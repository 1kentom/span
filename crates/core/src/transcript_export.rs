//! Markdown export of a chat transcript ("Export as Markdown", ADR 0005).
//!
//! The caller passes simple records: message text, tool step titles and
//! diffs. Raw tool input and output are not part of the record type, so they
//! cannot leak into an export. Absolute workspace and home paths are
//! replaced with `.` and `~`.
use serde::{Deserialize, Serialize};
use specta::Type;

/// One record of a chat transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TranscriptItem {
    /// A user prompt. Starts a new turn.
    User { text: String },
    /// Agent reply text (Markdown, kept as is).
    Agent { text: String },
    /// Agent reasoning, exported as a quote.
    Thought { text: String },
    /// A tool step. Consecutive steps form one bulleted list.
    Tool {
        title: String,
        #[serde(default)]
        #[specta(optional)]
        status: Option<String>,
    },
    /// A file change, exported as a fenced unified diff.
    Diff {
        path: String,
        #[serde(default, rename = "oldText")]
        #[specta(optional)]
        old_text: Option<String>,
        #[serde(rename = "newText")]
        new_text: String,
    },
    /// A notice, error or status line.
    Notice { text: String },
}

/// A transcript to export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
    pub items: Vec<TranscriptItem>,
}

/// Renders `transcript` as Markdown. `workspace_root` occurrences become `.`
/// and `home_dir` occurrences become `~` (workspace first, so a workspace
/// inside the home directory still becomes `.`).
pub fn transcript_to_markdown(
    transcript: &Transcript,
    workspace_root: Option<&str>,
    home_dir: Option<&str>,
) -> String {
    let redact = |text: &str| redact_paths(text, workspace_root, home_dir);
    let mut out = String::new();
    let title = transcript
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("Chat transcript");
    out.push_str(&format!("# {}\n", one_line(&redact(title))));
    let mut turn = 0u32;
    let mut in_tools = false;
    for item in &transcript.items {
        let is_tool = matches!(item, TranscriptItem::Tool { .. });
        if in_tools && !is_tool {
            in_tools = false;
        }
        let starts_turn = matches!(item, TranscriptItem::User { .. });
        if starts_turn || turn == 0 {
            turn += 1;
            out.push_str(&format!("\n## Turn {turn}\n"));
        }
        match item {
            TranscriptItem::User { text } => {
                out.push_str(&format!("\n### You\n\n{}\n", redact(text).trim_end()));
            }
            TranscriptItem::Agent { text } => {
                out.push_str(&format!("\n### Agent\n\n{}\n", redact(text).trim_end()));
            }
            TranscriptItem::Thought { text } => {
                out.push('\n');
                for line in redact(text).trim_end().lines() {
                    if line.is_empty() {
                        out.push_str(">\n");
                    } else {
                        out.push_str(&format!("> {line}\n"));
                    }
                }
            }
            TranscriptItem::Tool { title, status } => {
                if !in_tools {
                    out.push_str("\n#### Tool steps\n\n");
                    in_tools = true;
                }
                let status = status
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(" ({})", one_line(s)))
                    .unwrap_or_default();
                out.push_str(&format!("- {}{status}\n", one_line(&redact(title))));
            }
            TranscriptItem::Diff {
                path,
                old_text,
                new_text,
            } => {
                let path = one_line(&redact(path));
                let diff =
                    similar::TextDiff::from_lines(old_text.as_deref().unwrap_or(""), new_text)
                        .unified_diff()
                        .context_radius(3)
                        .header(
                            if old_text.is_some() {
                                &path
                            } else {
                                "/dev/null"
                            },
                            &path,
                        )
                        .to_string();
                let diff = redact(&diff);
                let fence = fence_for(&diff);
                out.push_str(&format!(
                    "\n{fence}diff\n{}\n{fence}\n",
                    diff.trim_end_matches('\n')
                ));
            }
            TranscriptItem::Notice { text } => {
                out.push_str(&format!("\n_{}_\n", one_line(&redact(text))));
            }
        }
    }
    out
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A backtick fence longer than any backtick run inside `text`.
fn fence_for(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for ch in text.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

/// Replaces the workspace root with `.` and the home directory with `~`,
/// only where the match ends at a path boundary, so `/home/al` never rewrites
/// `/home/alex`. Windows roots also match with the other separator style.
pub fn redact_paths(text: &str, workspace_root: Option<&str>, home_dir: Option<&str>) -> String {
    let mut out = text.to_owned();
    for (root, replacement) in [(workspace_root, "."), (home_dir, "~")] {
        let Some(root) = root
            .map(|r| r.trim_end_matches(['/', '\\']))
            .filter(|r| r.len() > 1)
        else {
            continue;
        };
        let mut variants = vec![root.to_owned()];
        if root.contains('\\') {
            variants.push(root.replace('\\', "/"));
        }
        for variant in variants {
            out = replace_at_boundary(&out, &variant, replacement);
        }
    }
    out
}

fn replace_at_boundary(text: &str, needle: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(needle) {
        let after = &rest[index + needle.len()..];
        let boundary = after
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.')));
        out.push_str(&rest[..index]);
        out.push_str(if boundary { replacement } else { needle });
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Transcript {
        Transcript {
            title: Some("Fix /home/dev/repo/src/main.rs".into()),
            items: vec![
                TranscriptItem::User {
                    text: "Look at /home/dev/repo/src/main.rs and /home/dev/notes.txt".into(),
                },
                TranscriptItem::Thought {
                    text: "Reading the file.\n\nThen edit.".into(),
                },
                TranscriptItem::Tool {
                    title: "Read /home/dev/repo/src/main.rs".into(),
                    status: Some("completed".into()),
                },
                TranscriptItem::Tool {
                    title: "Edit main.rs".into(),
                    status: None,
                },
                TranscriptItem::Diff {
                    path: "/home/dev/repo/src/main.rs".into(),
                    old_text: Some("fn main() {}\n".into()),
                    new_text: "fn main() {\n    println!(\"hi\");\n}\n".into(),
                },
                TranscriptItem::Agent {
                    text: "Done. See ```code``` above.".into(),
                },
                TranscriptItem::User {
                    text: "Thanks".into(),
                },
                TranscriptItem::Notice {
                    text: "Turn cancelled".into(),
                },
            ],
        }
    }

    #[test]
    fn renders_turns_tools_and_diffs() {
        let md = transcript_to_markdown(&sample(), Some("/home/dev/repo"), Some("/home/dev"));
        let expected = "# Fix ./src/main.rs

## Turn 1

### You

Look at ./src/main.rs and ~/notes.txt

> Reading the file.
>
> Then edit.

#### Tool steps

- Read ./src/main.rs (completed)
- Edit main.rs

```diff
--- ./src/main.rs
+++ ./src/main.rs
@@ -1 +1,3 @@
-fn main() {}
+fn main() {
+    println!(\"hi\");
+}
```

### Agent

Done. See ```code``` above.

## Turn 2

### You

Thanks

_Turn cancelled_
";
        assert_eq!(md, expected);
    }

    #[test]
    fn redacts_paths_only_at_boundaries() {
        let text = "/home/al/x /home/alex/y /home/al /home/al.bak /home/al-old";
        assert_eq!(
            redact_paths(text, None, Some("/home/al/")),
            "~/x /home/alex/y ~ /home/al.bak /home/al-old"
        );
        let windows = r"C:\Users\Dev\repo\a.rs and C:/Users/Dev/repo/b.rs and C:\Users\Dev\c.txt";
        assert_eq!(
            redact_paths(windows, Some(r"C:\Users\Dev\repo"), Some(r"C:\Users\Dev")),
            r".\a.rs and ./b.rs and ~\c.txt"
        );
        assert_eq!(redact_paths("/ stays", Some("/"), None), "/ stays");
    }

    #[test]
    fn new_file_diff_and_backtick_fences() {
        let transcript = Transcript {
            title: None,
            items: vec![TranscriptItem::Diff {
                path: "/w/README.md".into(),
                old_text: None,
                new_text: "```rust\nlet x = 1;\n```\n".into(),
            }],
        };
        let md = transcript_to_markdown(&transcript, Some("/w"), None);
        assert!(md.starts_with("# Chat transcript\n\n## Turn 1\n"));
        assert!(
            md.contains("````diff\n--- /dev/null\n+++ ./README.md\n"),
            "{md}"
        );
        assert!(md.trim_end().ends_with("````"));
    }

    #[test]
    fn serde_shape_is_tagged_by_kind() {
        let item: TranscriptItem =
            serde_json::from_str(r#"{"kind":"diff","path":"a","newText":"x"}"#).unwrap();
        assert_eq!(
            item,
            TranscriptItem::Diff {
                path: "a".into(),
                old_text: None,
                new_text: "x".into()
            }
        );
    }
}
