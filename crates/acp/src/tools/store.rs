//! Task records for `task_status` and `list_tasks` (ADR 0014, section 4).
//!
//! The server writes one record per task whenever the task changes, and the
//! listing tools read them back. Records hold ids, the agent, status,
//! reason, timings and a bounded, framed summary: never a token, an auth
//! header or the child's full text. Stage 2 keeps them in memory
//! ([`MemoryTaskStore`]); stage 3 puts a durable store (session metadata
//! and the transcript store) behind the same [`TaskStore`] trait, and calls
//! [`TaskStore::recover`] on load so a task that was queued or running when
//! Span stopped reads as `lost`.
use super::result::FailureReason;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};

/// Detail of a task Span marks lost after a restart.
pub const LOST_AFTER_RESTART: &str =
    "Span restarted while this task ran; the child session is gone, delegate again";

/// One delegated task as the listing tools report it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    /// The `delegate_many` group, when the task was started by one.
    pub group_id: Option<String>,
    pub agent: String,
    pub model: Option<String>,
    pub connection_id: String,
    pub session_id: String,
    /// `queued`, `running`, `completed`, `failed` or `lost`.
    pub status: String,
    pub reason: Option<FailureReason>,
    pub detail: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    /// The start of the child's reply, bounded and already inside the
    /// untrusted output frame.
    pub summary: Option<String>,
}

impl TaskRecord {
    pub fn finished(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "lost")
    }

    /// Creation order: task ids are `task-<n>`.
    fn sequence(&self) -> u64 {
        self.task_id
            .rsplit('-')
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    }
}

/// A `list_tasks` query. `statuses` empty means every status.
#[derive(Debug, Clone, Default)]
pub struct TaskQuery {
    pub statuses: Vec<String>,
    pub group_id: Option<String>,
    pub limit: usize,
    /// From an earlier page's `next_cursor`.
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskPage {
    /// Newest first.
    pub tasks: Vec<TaskRecord>,
    pub next_cursor: Option<String>,
}

/// Where one lead's task records live.
pub trait TaskStore: Send + Sync {
    /// Insert or replace the record with this task id.
    fn upsert(&self, record: TaskRecord);
    fn get(&self, task_id: &str) -> Option<TaskRecord>;
    /// Matching records, newest first, `query.limit` at a time. An unknown
    /// cursor is an error the caller reports as -32602.
    fn list(&self, query: &TaskQuery) -> Result<TaskPage, String>;
    /// Restart recovery: every record that was `queued` or `running` becomes
    /// `lost` with reason `lost`. Returns how many changed.
    fn recover(&self) -> usize;
}

/// The stage 2 store: records live as long as the lead's server.
#[derive(Default)]
pub struct MemoryTaskStore {
    records: Mutex<Vec<TaskRecord>>,
}

impl MemoryTaskStore {
    fn records(&self) -> MutexGuard<'_, Vec<TaskRecord>> {
        self.records.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl TaskStore for MemoryTaskStore {
    fn upsert(&self, record: TaskRecord) {
        let mut records = self.records();
        match records.iter_mut().find(|r| r.task_id == record.task_id) {
            Some(existing) => *existing = record,
            None => records.push(record),
        }
    }

    fn get(&self, task_id: &str) -> Option<TaskRecord> {
        self.records()
            .iter()
            .find(|r| r.task_id == task_id)
            .cloned()
    }

    fn list(&self, query: &TaskQuery) -> Result<TaskPage, String> {
        let before = match &query.cursor {
            Some(cursor) => Some(
                cursor
                    .strip_prefix("before-")
                    .and_then(|n| n.parse::<u64>().ok())
                    .ok_or_else(|| format!("Unknown cursor: {cursor}"))?,
            ),
            None => None,
        };
        let mut matching: Vec<TaskRecord> = self
            .records()
            .iter()
            .filter(|r| query.statuses.is_empty() || query.statuses.contains(&r.status))
            .filter(|r| {
                query
                    .group_id
                    .as_ref()
                    .is_none_or(|g| r.group_id.as_ref() == Some(g))
            })
            .filter(|r| before.is_none_or(|b| r.sequence() < b))
            .cloned()
            .collect();
        matching.sort_by_key(|r| std::cmp::Reverse(r.sequence()));
        let limit = query.limit.max(1);
        let more = matching.len() > limit;
        matching.truncate(limit);
        let next_cursor = more
            .then(|| matching.last().map(|r| format!("before-{}", r.sequence())))
            .flatten();
        Ok(TaskPage {
            tasks: matching,
            next_cursor,
        })
    }

    fn recover(&self) -> usize {
        let mut changed = 0;
        for record in self.records().iter_mut().filter(|r| !r.finished()) {
            record.status = "lost".into();
            record.reason = Some(FailureReason::Lost);
            record.detail = Some(LOST_AFTER_RESTART.into());
            changed += 1;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(n: u64, status: &str, group: Option<&str>) -> TaskRecord {
        TaskRecord {
            task_id: format!("task-{n}"),
            group_id: group.map(str::to_owned),
            agent: "worker".into(),
            model: None,
            connection_id: "c".into(),
            session_id: format!("s{n}"),
            status: status.into(),
            reason: None,
            detail: None,
            started_at_ms: n,
            finished_at_ms: None,
            summary: None,
        }
    }

    #[test]
    fn lists_newest_first_with_filters_and_cursor_pages() {
        let store = MemoryTaskStore::default();
        for n in 1..=12 {
            let status = if n % 3 == 0 { "completed" } else { "running" };
            store.upsert(record(n, status, (n > 6).then_some("group-1")));
        }
        let first = store
            .list(&TaskQuery {
                limit: 5,
                ..TaskQuery::default()
            })
            .unwrap();
        let ids: Vec<&str> = first.tasks.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, ["task-12", "task-11", "task-10", "task-9", "task-8"]);
        let second = store
            .list(&TaskQuery {
                limit: 5,
                cursor: first.next_cursor.clone(),
                ..TaskQuery::default()
            })
            .unwrap();
        assert_eq!(second.tasks[0].task_id, "task-7");
        let completed = store
            .list(&TaskQuery {
                statuses: vec!["completed".into()],
                group_id: Some("group-1".into()),
                limit: 20,
                cursor: None,
            })
            .unwrap();
        let ids: Vec<&str> = completed.tasks.iter().map(|r| r.task_id.as_str()).collect();
        assert_eq!(ids, ["task-12", "task-9"]);
        assert_eq!(completed.next_cursor, None);
        assert!(store
            .list(&TaskQuery {
                limit: 1,
                cursor: Some("bogus".into()),
                ..TaskQuery::default()
            })
            .is_err());
    }

    #[test]
    fn recovery_marks_unfinished_records_lost_and_keeps_results() {
        let store = MemoryTaskStore::default();
        store.upsert(record(1, "running", None));
        store.upsert(record(2, "queued", Some("group-1")));
        store.upsert(record(3, "completed", None));
        assert_eq!(store.recover(), 2);
        let lost = store.get("task-2").unwrap();
        assert_eq!(lost.status, "lost");
        assert_eq!(lost.reason, Some(FailureReason::Lost));
        assert_eq!(lost.detail.as_deref(), Some(LOST_AFTER_RESTART));
        assert_eq!(store.get("task-3").unwrap().status, "completed");
        assert_eq!(store.recover(), 0);
    }
}
