//! OpenCode 1.2+ usage from its SQLite database (ADR 0012, source B).
//!
//! OpenCode keeps sessions in `opencode.db` (or `opencode-<channel>.db`) in
//! its data folder, `$XDG_DATA_HOME/opencode` else `~/.local/share/opencode`
//! on every platform (it resolves the folder with `xdg-basedir`). Two layouts
//! are known, both from github.com/anomalyco/opencode:
//!
//! - `message(id, session_id, time_created, time_updated, data)`, releases
//!   1.2 to 1.19 (`packages/opencode/src/session/session.sql.ts`, later
//!   `packages/core/src/session/sql.ts`). `data` is the message info as JSON;
//!   an assistant message carries `role`, `modelID`, `providerID`, `cost`,
//!   `time.created` and `tokens.{input, output, reasoning, cache.{read,
//!   write}}`. Prompt text and replies live in the `part` table, never read.
//! - `session` or `session_v2` with numeric `tokens_input`, `tokens_output`,
//!   `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost`,
//!   `time_updated` and a `model` JSON `{id, providerID}` (later releases).
//!   Used when no `message` table exists: one entry per session.
//!
//! Strictly read only and never locking: a database without a write-ahead
//! log is opened with `SQLITE_OPEN_READ_ONLY` and the URI
//! `file:...?mode=ro&immutable=1`; a live one (a non-empty `-wal` file) is
//! read through a copy of the database and its `-wal` in a fresh folder that
//! is removed after the read. Only numbers, ids, model ids and times are
//! selected; SQLite's `json_extract` picks the numeric fields out of `data`
//! so no message JSON reaches Span. Queries are paged, and a scan only rereads
//! sessions with a message updated after the stored `time_updated`
//! watermark. A database in neither layout leaves a plain note instead of an
//! error.
use crate::usage_import::{
    add_entries, fnv, hour_of_ms, opencode_counts, Entry, FileState, ImportKind, ImportLimits,
    ScanReport,
};
use rusqlite::{Connection, OpenFlags};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// `opencode*.db` files in OpenCode's data folder, two levels above the
/// `storage/message` root.
pub fn databases(message_root: &Path) -> Vec<PathBuf> {
    let Some(data) = message_root.parent().and_then(Path::parent) else {
        return vec![];
    };
    if !fs::symlink_metadata(data).is_ok_and(|m| m.is_dir()) {
        return vec![];
    }
    let Ok(entries) = fs::read_dir(data) else {
        return vec![];
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("opencode")
                && name.ends_with(".db")
                && e.file_type().is_ok_and(|t| t.is_file())
        })
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

fn wal_path(db: &Path) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

/// Length and modification time of the database and its `-wal` file, as one
/// hash: an unchanged database is not opened again.
fn fingerprint(db: &Path) -> Option<(u64, u64)> {
    let stamp = |path: &Path| {
        fs::symlink_metadata(path).ok().map(|m| {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            (m.len(), modified)
        })
    };
    let (len, modified) = stamp(db)?;
    let (wal_len, wal_modified) = stamp(&wal_path(db)).unwrap_or((0, 0));
    let hash = fnv(format!("{len}\u{0}{modified}\u{0}{wal_len}\u{0}{wal_modified}").as_bytes());
    Some((len, hash))
}

/// A `file:` URI for SQLite: `%`, `?` and `#` escaped, forward slashes, and a
/// leading slash before a Windows drive letter.
fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file:");
    if text.as_bytes().get(1) == Some(&b':') {
        out.push('/');
    }
    for c in text.chars() {
        match c {
            '%' => out.push_str("%25"),
            '?' => out.push_str("%3f"),
            '#' => out.push_str("%23"),
            _ => out.push(c),
        }
    }
    out
}

/// A copy folder removed when dropped, whatever happens during the read.
struct CopyDir(PathBuf);

impl Drop for CopyDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Opens `db` without ever writing to or locking it: immutable read only, or
/// a private copy (database plus `-wal`) when a write-ahead log is live.
fn open(db: &Path, work_dir: &Path) -> Result<(Connection, Option<CopyDir>), String> {
    let wal = wal_path(db);
    let live = fs::symlink_metadata(&wal).is_ok_and(|m| m.is_file() && m.len() > 0);
    if !live {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let uri = format!("{}?mode=ro&immutable=1", file_uri(db));
        let conn = Connection::open_with_flags(uri, flags).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "query_only", true)
            .map_err(|e| e.to_string())?;
        return Ok((conn, None));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = work_dir.join(format!("opencode-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let guard = CopyDir(dir.clone());
    let copy = dir.join("opencode.db");
    // The log first: a checkpoint between the two copies then only leaves
    // pages in both, which replay to the same content.
    fs::copy(&wal, wal_path(&copy)).map_err(|e| e.to_string())?;
    fs::copy(db, &copy).map_err(|e| e.to_string())?;
    // Read write on the private copy only, so SQLite can replay its log.
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&copy, flags).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "query_only", true)
        .map_err(|e| e.to_string())?;
    Ok((conn, Some(guard)))
}

enum Layout {
    /// Per message, from `message.data` numeric fields.
    Messages,
    /// Per session, from a session table's token columns.
    Sessions { table: &'static str, model: bool },
}

fn columns(conn: &Connection, table: &str) -> HashSet<String> {
    let Ok(mut statement) = conn.prepare("SELECT name FROM pragma_table_info(?1)") else {
        return HashSet::new();
    };
    statement
        .query_map([table], |row| row.get::<_, String>(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

fn layout(conn: &Connection) -> Option<Layout> {
    let message = columns(conn, "message");
    if ["id", "session_id", "time_created", "time_updated", "data"]
        .iter()
        .all(|c| message.contains(*c))
    {
        return Some(Layout::Messages);
    }
    for table in ["session_v2", "session"] {
        let have = columns(conn, table);
        if [
            "id",
            "time_updated",
            "cost",
            "tokens_input",
            "tokens_output",
            "tokens_reasoning",
            "tokens_cache_read",
            "tokens_cache_write",
        ]
        .iter()
        .all(|c| have.contains(*c))
        {
            return Some(Layout::Sessions {
                table,
                model: have.contains("model"),
            });
        }
    }
    None
}

/// A version label for a database in neither layout: `PRAGMA user_version`,
/// else the number of applied migrations, else "unknown".
fn version_label(conn: &Connection) -> String {
    let user: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if user > 0 {
        return user.to_string();
    }
    conn.query_row("SELECT count(*) FROM __drizzle_migrations", [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| format!("{n} migrations"))
    .unwrap_or_else(|_| "unknown".into())
}

/// Reads one OpenCode database into `state`. Never fails the scan: a read
/// error counts the database as skipped, an unknown layout adds a note.
pub fn read_database(
    db: &Path,
    state: &mut FileState,
    limits: &ImportLimits,
    work_dir: &Path,
    report: &mut ScanReport,
) {
    let Some((len, hash)) = fingerprint(db) else {
        report.skipped += 1;
        return;
    };
    if len > limits.max_file_bytes {
        report.skipped += 1;
        return;
    }
    if state.database && state.kind == Some(ImportKind::OpenCode) && state.head == hash {
        return;
    }
    let (conn, _copy) = match open(db, work_dir) {
        Ok(opened) => opened,
        Err(_) => {
            report.skipped += 1;
            return;
        }
    };
    let Some(layout) = layout(&conn) else {
        report.notes.push(format!(
            "OpenCode database format not recognised (version {}), so it was not read.",
            version_label(&conn)
        ));
        *state = FileState {
            kind: Some(ImportKind::OpenCode),
            database: true,
            head: hash,
            len,
            ..FileState::default()
        };
        return;
    };
    let outcome = match layout {
        Layout::Messages => read_messages(&conn, state, limits, report),
        Layout::Sessions { table, model } => read_sessions(&conn, table, model, state, limits, report),
    };
    match outcome {
        Ok(()) => {
            state.kind = Some(ImportKind::OpenCode);
            state.database = true;
            state.head = hash;
            state.len = len;
            report.databases_read += 1;
            report.files_read += 1;
        }
        Err(_) => {
            // Leave the fingerprint stale so the next scan tries again.
            state.head = 0;
            report.skipped += 1;
        }
    }
}

fn max_updated(conn: &Connection, table: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        &format!("SELECT coalesce(max(time_updated), 0) FROM {table}"),
        [],
        |row| row.get(0),
    )
}

/// Starts over when the database is new to the cache or went back in time
/// (replaced or restored): earlier counts are dropped.
fn reset_if_needed(state: &mut FileState, newest: i64) {
    if !state.database || state.kind != Some(ImportKind::OpenCode) || newest < state.watermark {
        *state = FileState {
            kind: Some(ImportKind::OpenCode),
            database: true,
            ..FileState::default()
        };
    }
}

/// Drops buckets of sessions no longer present or about to be reread.
fn drop_sessions(state: &mut FileState, keep: impl Fn(&str) -> bool) {
    state.buckets.retain(|b| keep(&b.session));
}

fn n(value: Option<i64>) -> u64 {
    value.filter(|v| *v > 0).map(|v| v as u64).unwrap_or(0)
}

fn cost_micros(cost: Option<f64>) -> u64 {
    cost.filter(|c| c.is_finite() && *c > 0.0)
        .map(|c| (c * 1_000_000.0).round() as u64)
        .unwrap_or(0)
}

fn read_messages(
    conn: &Connection,
    state: &mut FileState,
    limits: &ImportLimits,
    report: &mut ScanReport,
) -> rusqlite::Result<()> {
    let newest = max_updated(conn, "message")?;
    reset_if_needed(state, newest);
    let page = limits.db_page_rows.max(1) as i64;
    let mut budget = limits.max_db_rows;
    // Sessions present at all, and those with a message newer than the mark.
    let mut present = BTreeSet::new();
    let mut changed = BTreeSet::new();
    let mut statement = conn.prepare(
        "SELECT session_id, max(time_updated) FROM message WHERE session_id > ?1 \
         GROUP BY session_id ORDER BY session_id LIMIT ?2",
    )?;
    let mut after = String::new();
    loop {
        let rows: Vec<(String, i64)> = statement
            .query_map(rusqlite::params![after, page], |row| {
                Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let Some((last, _)) = rows.last() else {
            break;
        };
        after = last.clone();
        let full = rows.len() as i64 == page;
        for (session, updated) in rows {
            if updated > state.watermark {
                changed.insert(session.clone());
            }
            present.insert(session);
        }
        if !full {
            break;
        }
    }
    drop_sessions(state, |s| present.contains(s) && !changed.contains(s));
    let mut statement = conn.prepare(
        "SELECT id, time_created, \
           substr(coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID'), json_extract(data, '$.model.id'), ''), 1, 128), \
           CAST(coalesce(json_extract(data, '$.tokens.input'), 0) AS INTEGER), \
           CAST(coalesce(json_extract(data, '$.tokens.output'), 0) AS INTEGER), \
           CAST(coalesce(json_extract(data, '$.tokens.reasoning'), 0) AS INTEGER), \
           CAST(coalesce(json_extract(data, '$.tokens.cache.read'), 0) AS INTEGER), \
           CAST(coalesce(json_extract(data, '$.tokens.cache.write'), 0) AS INTEGER), \
           CAST(coalesce(json_extract(data, '$.cost'), 0) AS REAL), \
           CAST(json_extract(data, '$.time.created') AS REAL) \
         FROM message \
         WHERE session_id = ?1 AND id > ?2 AND json_extract(data, '$.role') = 'assistant' \
         ORDER BY id LIMIT ?3",
    )?;
    let mut entries = vec![];
    for session in &changed {
        let mut after = String::new();
        loop {
            #[allow(clippy::type_complexity)]
            let rows: Vec<(String, i64, String, [Option<i64>; 5], Option<f64>, Option<f64>)> =
                statement
                    .query_map(rusqlite::params![session, after, page], |row| {
                        Ok((
                            row.get(0)?,
                            row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            [row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?],
                            row.get(8)?,
                            row.get(9)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
            let Some(last) = rows.last() else {
                break;
            };
            after = last.0.clone();
            let full = rows.len() as i64 == page;
            for (_, created_column, model, tokens, cost, created) in rows {
                budget = budget.saturating_sub(1);
                let counts = opencode_counts(
                    &model,
                    n(tokens[0]),
                    n(tokens[1]),
                    n(tokens[2]),
                    n(tokens[3]),
                    n(tokens[4]),
                );
                if counts.is_empty() {
                    continue;
                }
                let created = created.filter(|c| *c > 0.0).unwrap_or(created_column as f64);
                let Some(hour) = hour_of_ms(created) else {
                    continue;
                };
                entries.push(Entry {
                    hour,
                    model,
                    session: session.chars().take(256).collect(),
                    tokens: counts,
                    cost_micros: cost_micros(cost),
                });
            }
            if !full || budget == 0 {
                break;
            }
        }
        if budget == 0 {
            report.truncated = true;
            break;
        }
    }
    add_entries(ImportKind::OpenCode, state, entries, "", report);
    // A capped read keeps the old mark, so the rest is read next time.
    if budget > 0 {
        state.watermark = newest;
    }
    Ok(())
}

fn read_sessions(
    conn: &Connection,
    table: &str,
    has_model: bool,
    state: &mut FileState,
    limits: &ImportLimits,
    report: &mut ScanReport,
) -> rusqlite::Result<()> {
    let newest = max_updated(conn, table)?;
    reset_if_needed(state, newest);
    let page = limits.db_page_rows.max(1) as i64;
    let model = if has_model {
        "substr(coalesce(json_extract(model, '$.id'), ''), 1, 128)"
    } else {
        "''"
    };
    let mut present = HashSet::new();
    let mut ids = conn.prepare(&format!(
        "SELECT id FROM {table} WHERE id > ?1 ORDER BY id LIMIT ?2"
    ))?;
    let mut after = String::new();
    loop {
        let rows: Vec<String> = ids
            .query_map(rusqlite::params![after, page], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let Some(last) = rows.last() else {
            break;
        };
        after = last.clone();
        let full = rows.len() as i64 == page;
        present.extend(rows);
        if !full || present.len() >= limits.max_db_rows {
            break;
        }
    }
    let mut statement = conn.prepare(&format!(
        "SELECT id, time_updated, {model}, tokens_input, tokens_output, tokens_reasoning, \
           tokens_cache_read, tokens_cache_write, CAST(cost AS REAL) \
         FROM {table} WHERE time_updated > ?1 AND id > ?2 ORDER BY id LIMIT ?3"
    ))?;
    let mut changed = HashSet::new();
    let mut entries = vec![];
    let mut after = String::new();
    loop {
        #[allow(clippy::type_complexity)]
        let rows: Vec<(String, i64, String, [Option<i64>; 5], Option<f64>)> = statement
            .query_map(rusqlite::params![state.watermark, after, page], |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    [row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?],
                    row.get(8)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let Some(last) = rows.last() else {
            break;
        };
        after = last.0.clone();
        let full = rows.len() as i64 == page;
        for (id, updated, model, tokens, cost) in rows {
            changed.insert(id.clone());
            let counts = opencode_counts(
                &model,
                n(tokens[0]),
                n(tokens[1]),
                n(tokens[2]),
                n(tokens[3]),
                n(tokens[4]),
            );
            let Some(hour) = hour_of_ms(updated as f64) else {
                continue;
            };
            if counts.is_empty() {
                continue;
            }
            entries.push(Entry {
                hour,
                model,
                session: id.chars().take(256).collect(),
                tokens: counts,
                cost_micros: cost_micros(cost),
            });
        }
        if !full || changed.len() >= limits.max_db_rows {
            break;
        }
    }
    drop_sessions(state, |s| present.contains(s) && !changed.contains(s));
    add_entries(ImportKind::OpenCode, state, entries, "", report);
    state.watermark = newest;
    Ok(())
}
