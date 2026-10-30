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
        Layout::Sessions { table, model } => {
            read_sessions(&conn, table, model, state, limits, report)
        }
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
            let rows: Vec<(
                String,
                i64,
                String,
                [Option<i64>; 5],
                Option<f64>,
                Option<f64>,
            )> = statement
                .query_map(rusqlite::params![session, after, page], |row| {
                    Ok((
                        row.get(0)?,
                        row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        [
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ],
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
                let created = created
                    .filter(|c| *c > 0.0)
                    .unwrap_or(created_column as f64);
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
                    [
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_import::{imported_sessions, scan_in, ImportCache, IMPORTED_OPENCODE_ID};
    use std::collections::HashSet;

    /// The 1.2 to 1.19 tables, as in OpenCode's `session.sql.ts`.
    const SCHEMA: &str = "
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
          slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
          time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX message_session_idx ON message (session_id);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);";

    const T0: i64 = 1_792_000_000_000;

    fn assistant(
        conn: &Connection,
        id: &str,
        session: &str,
        at: i64,
        model: &str,
        tokens: (u64, u64, u64, u64, u64),
        cost: f64,
    ) {
        let (input, output, reasoning, read, write) = tokens;
        let data = format!(
            r#"{{"role":"assistant","modelID":"{model}","providerID":"sample","cost":{cost},"time":{{"created":{at},"completed":{}}},"tokens":{{"input":{input},"output":{output},"reasoning":{reasoning},"cache":{{"read":{read},"write":{write}}}}},"system":["sample system prompt"]}}"#,
            at + 1000
        );
        conn.execute(
            "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, session, at, at + 1000, data],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            rusqlite::params![format!("prt_{id}"), id, session, at, r#"{"type":"text","text":"generated sample reply"}"#],
        )
        .unwrap();
    }

    fn user(conn: &Connection, id: &str, session: &str, at: i64) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![id, session, at, r#"{"role":"user","time":{"created":1},"summary":{"title":"sample prompt"}}"#],
        )
        .unwrap();
    }

    fn sample_db(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        user(&conn, "msg_0", "ses_1", T0);
        assistant(
            &conn,
            "msg_1",
            "ses_1",
            T0 + 1,
            "claude-sonnet-5",
            (1200, 300, 50, 9000, 400),
            0.25,
        );
        assistant(
            &conn,
            "msg_2",
            "ses_1",
            T0 + 2,
            "gpt-5.5",
            (100, 10, 0, 900, 0),
            0.0,
        );
        assistant(
            &conn,
            "msg_3",
            "ses_2",
            T0 + 3,
            "claude-haiku-4-5",
            (10, 1, 0, 0, 0),
            0.0,
        );
        conn
    }

    fn stamp(path: &Path) -> (Vec<u8>, std::time::SystemTime) {
        (
            fs::read(path).unwrap(),
            fs::metadata(path).unwrap().modified().unwrap(),
        )
    }

    fn scan_data(data: &Path, work: &Path, cache: &mut ImportCache) -> ScanReport {
        let roots = vec![(ImportKind::OpenCode, data.join("storage/message"))];
        scan_in(&roots, cache, &ImportLimits::default(), work, &mut |_| {})
    }

    /// Input, output, cache read, cache write, reasoning, cost and turns.
    type Sums = (u64, u64, u64, u64, u64, u64, u32);

    fn by_model(cache: &ImportCache) -> std::collections::BTreeMap<String, Sums> {
        let mut out = std::collections::BTreeMap::new();
        for s in imported_sessions(cache, 0, &HashSet::new()) {
            for b in s.usage.unwrap().buckets {
                let e = out.entry(b.model).or_insert((0, 0, 0, 0, 0, 0, 0));
                e.0 += b.input;
                e.1 += b.output;
                e.2 += b.cache_read;
                e.3 += b.cache_write;
                e.4 += b.thought;
                e.5 += b.cost_micros;
                e.6 += b.turns;
            }
        }
        out
    }

    #[test]
    fn usage_opencode_db_counts_messages_read_only_without_text() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        fs::create_dir_all(&data).unwrap();
        let db = data.join("opencode.db");
        drop(sample_db(&db));
        let before = stamp(&db);
        let work = dir.path().join("work");
        let mut cache = ImportCache::default();
        let report = scan_data(&data, &work, &mut cache);
        assert_eq!(report.databases_read, 1);
        assert_eq!(report.entries, 3);
        assert_eq!(report.kinds, vec![ImportKind::OpenCode]);
        let models = by_model(&cache);
        // Anthropic convention: input apart from cache; reasoning is output.
        assert_eq!(
            models["claude-sonnet-5"],
            (1200, 350, 9000, 400, 50, 250_000, 1)
        );
        // OpenAI convention: cached tokens folded into input.
        assert_eq!(models["gpt-5.5"].0, 1000);
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().all(|s| s.agent_id == IMPORTED_OPENCODE_ID));
        // Read only: same bytes, same time, no journal files, no copy left.
        assert_eq!(stamp(&db), before);
        for suffix in ["-journal", "-wal", "-shm"] {
            assert!(
                !data.join(format!("opencode.db{suffix}")).exists(),
                "{suffix}"
            );
        }
        assert!(!work.exists() || fs::read_dir(&work).unwrap().next().is_none());
        let text = serde_json::to_string(&cache).unwrap();
        for content in [
            "sample prompt",
            "generated sample reply",
            "sample system prompt",
        ] {
            assert!(!text.contains(content), "{content}");
        }
        // Unchanged: not opened again.
        let again = scan_data(&data, &work, &mut cache);
        assert_eq!((again.databases_read, again.entries), (0, 0));
        assert_eq!(by_model(&cache), models);
    }

    #[test]
    fn usage_opencode_db_live_wal_is_read_through_a_removed_copy() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        fs::create_dir_all(&data).unwrap();
        let db = data.join("opencode.db");
        let writer = sample_db(&db);
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        // Only in the log: never checkpointed while the writer stays open.
        assistant(
            &writer,
            "msg_4",
            "ses_3",
            T0 + 4,
            "claude-opus-5-5",
            (7, 3, 0, 0, 0),
            0.0,
        );
        let wal = data.join("opencode.db-wal");
        assert!(fs::metadata(&wal).unwrap().len() > 0);
        let (db_before, wal_before) = (stamp(&db), stamp(&wal));
        let work = dir.path().join("work");
        let mut cache = ImportCache::default();
        let report = scan_data(&data, &work, &mut cache);
        assert_eq!(report.databases_read, 1);
        assert_eq!(report.entries, 4);
        assert_eq!(by_model(&cache)["claude-opus-5-5"].0, 7);
        assert_eq!(stamp(&db), db_before);
        assert_eq!(stamp(&wal), wal_before);
        assert!(
            fs::read_dir(&work).unwrap().next().is_none(),
            "the copy is removed"
        );
        drop(writer);
    }

    #[test]
    fn usage_opencode_db_rescans_only_changed_sessions_without_double_counting() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        fs::create_dir_all(&data).unwrap();
        let db = data.join("opencode.db");
        drop(sample_db(&db));
        let work = dir.path().join("work");
        let mut cache = ImportCache::default();
        scan_data(&data, &work, &mut cache);
        {
            let conn = Connection::open(&db).unwrap();
            assistant(
                &conn,
                "msg_5",
                "ses_2",
                T0 + 10_000,
                "claude-haiku-4-5",
                (5, 1, 0, 0, 0),
                0.0,
            );
            conn.execute("DELETE FROM message WHERE session_id = 'ses_1'", [])
                .unwrap();
        }
        let report = scan_data(&data, &work, &mut cache);
        assert_eq!(report.entries, 2, "only ses_2 is read again");
        let models = by_model(&cache);
        assert_eq!(models["claude-haiku-4-5"], (15, 2, 0, 0, 0, 0, 2));
        assert!(
            !models.contains_key("claude-sonnet-5"),
            "a deleted session drops out"
        );
    }

    #[test]
    fn usage_opencode_db_replaces_the_same_sessions_from_json_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        let json = data.join("storage/message/ses_1/msg_1.json");
        fs::create_dir_all(json.parent().unwrap()).unwrap();
        fs::write(&json, r#"{"id":"msg_1","sessionID":"ses_1","role":"assistant","modelID":"claude-sonnet-5","cost":0.25,"time":{"created":1792000000001},"tokens":{"input":1200,"output":300,"reasoning":50,"cache":{"read":9000,"write":400}}}"#).unwrap();
        let old = data.join("storage/message/ses_0/msg_9.json");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, r#"{"id":"msg_9","sessionID":"ses_0","role":"assistant","modelID":"kimi-k2","time":{"created":1791000000000},"tokens":{"input":40,"output":4,"reasoning":0,"cache":{"read":0,"write":0}}}"#).unwrap();
        drop(sample_db(&data.join("opencode.db")));
        let mut cache = ImportCache::default();
        scan_data(&data, &dir.path().join("work"), &mut cache);
        let models = by_model(&cache);
        assert_eq!(models["claude-sonnet-5"].6, 1, "ses_1 counts once");
        assert_eq!(models["claude-sonnet-5"].0, 1200);
        // A session only the JSON files hold still counts.
        assert_eq!(models["kimi-k2"].0, 40);
        assert_eq!(imported_sessions(&cache, 0, &HashSet::new()).len(), 3);
    }

    #[test]
    fn usage_opencode_db_unknown_format_leaves_a_note() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        fs::create_dir_all(&data).unwrap();
        let db = data.join("opencode.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE chat (id TEXT, body TEXT); PRAGMA user_version = 7;")
                .unwrap();
        }
        let mut cache = ImportCache::default();
        let report = scan_data(&data, &dir.path().join("work"), &mut cache);
        assert_eq!(report.databases_read, 0);
        assert_eq!(report.skipped, 0);
        assert!(
            report
                .notes
                .iter()
                .any(|n| n.contains("OpenCode database format not recognised (version 7)")),
            "{:?}",
            report.notes
        );
        assert!(imported_sessions(&cache, 0, &HashSet::new()).is_empty());
        // Not a database at all: skipped, the scan goes on.
        fs::write(&db, b"not a database").unwrap();
        let report = scan_data(&data, &dir.path().join("work"), &mut ImportCache::default());
        assert_eq!(report.databases_read, 0);
        assert!(report.skipped + report.notes.len() as u32 >= 1);
    }

    #[test]
    fn usage_opencode_db_session_totals_layout() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        fs::create_dir_all(&data).unwrap();
        let conn = Connection::open(data.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, cost REAL NOT NULL DEFAULT 0,
               tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
               tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
               tokens_cache_write INTEGER NOT NULL DEFAULT 0, model TEXT,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
             INSERT INTO session_v2 VALUES ('ses_a', 'sample title', 1.5, 100, 20, 5, 1000, 50,
               '{\"id\":\"claude-sonnet-5\",\"providerID\":\"anthropic\"}', 1792000000000, 1792000500000);",
        )
        .unwrap();
        drop(conn);
        let mut cache = ImportCache::default();
        let report = scan_data(&data, &dir.path().join("work"), &mut cache);
        assert_eq!(report.databases_read, 1);
        assert_eq!(
            by_model(&cache)["claude-sonnet-5"],
            (100, 25, 1000, 50, 5, 1_500_000, 1)
        );
        assert!(!serde_json::to_string(&cache)
            .unwrap()
            .contains("sample title"));
    }

    #[test]
    fn usage_opencode_file_uri_escapes_and_handles_drive_letters() {
        assert_eq!(
            file_uri(Path::new("/a b/x?#%.db")),
            "file:/a b/x%3f%23%25.db"
        );
        assert_eq!(
            file_uri(Path::new("C:\\Users\\s\\opencode.db")),
            "file:/C:/Users/s/opencode.db"
        );
    }
}
