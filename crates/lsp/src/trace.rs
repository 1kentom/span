//! Optional protocol trace for diagnosing server behaviour.
//!
//! When `SPAN_LSP_TRACE_DIR` is set, each spawned server gets `<server>-<pid>.jsonl`
//! (one line per message sent or received) and `<server>-<pid>.stderr` in that
//! directory. When unset nothing is allocated and no file is touched. Environment
//! variables of the child are never logged.

use serde_json::{json, Value};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const TRACE_DIR_ENV: &str = "SPAN_LSP_TRACE_DIR";
const MAX_PARAMS_BYTES: usize = 64 * 1024;

/// Handle shared by the writer, the reader and the stderr task of one server process.
pub struct Trace {
    jsonl: Mutex<File>,
    stderr_path: PathBuf,
}

impl Trace {
    /// Trace directory taken from the process environment, if set and non-empty.
    pub fn dir_from_env() -> Option<PathBuf> {
        std::env::var_os(TRACE_DIR_ENV)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }

    /// Open the trace files for a server process. Any failure disables tracing.
    pub fn open(dir: &Path, command: &str, pid: Option<u32>) -> Option<Arc<Self>> {
        std::fs::create_dir_all(dir).ok()?;
        let stem = Path::new(command)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("server");
        let name: String = stem
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let base = format!("{}-{}", name, pid.unwrap_or(0));
        let jsonl = File::create(dir.join(format!("{base}.jsonl"))).ok()?;
        Some(Arc::new(Self {
            jsonl: Mutex::new(jsonl),
            stderr_path: dir.join(format!("{base}.stderr")),
        }))
    }

    pub fn stderr_file(&self) -> Option<File> {
        File::create(&self.stderr_path).ok()
    }

    /// Record one message. `dir` is "send" or "recv".
    pub fn record(&self, dir: &str, message: &Value) {
        let method = message.get("method").and_then(Value::as_str);
        let mut entry = json!({
            "ts": timestamp(),
            "dir": dir,
            "method": method,
            "id": message.get("id"),
        });
        if message.get("method").is_none() {
            entry["kind"] = json!("response");
            if message.get("error").is_some() {
                entry["error"] = message["error"].clone();
            }
        }
        let wants_params = method.is_some_and(|m| {
            m.starts_with("textDocument/")
                || m == "$/progress"
                || m.starts_with("window/")
                || m.starts_with("workspace/")
                || m == "initialize"
        });
        if wants_params {
            if let Some(params) = message.get("params") {
                let text = params.to_string();
                if text.len() > MAX_PARAMS_BYTES {
                    entry["params_truncated"] = json!(true);
                    entry["params_len"] = json!(text.len());
                    entry["params"] = json!(truncate_utf8(&text, MAX_PARAMS_BYTES));
                } else {
                    entry["params"] = params.clone();
                }
            }
        }
        if let Ok(mut f) = self.jsonl.lock() {
            let _ = writeln!(f, "{entry}");
            let _ = f.flush();
        }
    }
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn timestamp() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, d.subsec_millis())
}
