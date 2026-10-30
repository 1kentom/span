use super::*;
use mutation::IndexTransaction;
use similar::{ChangeTag, TextDiff};
use std::collections::{HashMap, HashSet};

fn line_diff<'a>(old: &'a str, new: &'a str) -> TextDiff<'a, 'a, str> {
    TextDiff::configure()
        .timeout(Duration::from_millis(250))
        .diff_lines(old, new)
}

fn line_hunks(diff: &GitDiff, snapshot: &str) -> Result<Vec<GitLineHunk>> {
    let old = diff.old_text.as_deref().unwrap_or("");
    let new = diff.new_text.as_deref().unwrap_or("");
    let text = line_diff(old, new);
    let seed = opaque(&[
        diff.path.as_bytes(),
        format!("{:?}", diff.side).as_bytes(),
        diff.index_revision.as_bytes(),
        snapshot.as_bytes(),
        old.as_bytes(),
        new.as_bytes(),
    ]);
    let mut hunks = Vec::new();
    let mut count = 0;
    for group in text.grouped_ops(3) {
        let mut lines = Vec::new();
        for op in &group {
            for change in text.iter_changes(op) {
                count += 1;
                if count > 100_000 {
                    return Err(error(
                        "Partial staging exceeds the 100000 line review limit",
                    ));
                }
                let kind = match change.tag() {
                    ChangeTag::Equal => "context",
                    ChangeTag::Delete => "delete",
                    ChangeTag::Insert => "insert",
                };
                let old_line = change.old_index().map(|i| i as u32 + 1);
                let new_line = change.new_index().map(|i| i as u32 + 1);
                let id = if change.tag() == ChangeTag::Equal {
                    String::new()
                } else {
                    opaque(&[
                        seed.as_bytes(),
                        kind.as_bytes(),
                        format!("{old_line:?}:{new_line:?}").as_bytes(),
                        change.value().as_bytes(),
                    ])
                };
                lines.push(GitReviewLine {
                    id,
                    kind: kind.into(),
                    text: change.value().into(),
                    old_line,
                    new_line,
                });
            }
        }
        let header = format!(
            "Lines {} / {}",
            lines.iter().find_map(|r| r.old_line).unwrap_or(0),
            lines.iter().find_map(|r| r.new_line).unwrap_or(0)
        );
        let id = opaque(&[seed.as_bytes(), format!("{lines:?}").as_bytes()]);
        hunks.push(GitLineHunk { id, header, lines });
    }
    Ok(hunks)
}

fn snapshot(repo: &RepoIdentity, path: &str, old_path: Option<&str>) -> Result<String> {
    let mut pieces = Vec::new();
    for path in std::iter::once(path).chain(old_path) {
        let stamp = read::disk_stamp_for(repo, path)?;
        let bytes = if stamp == "missing" {
            Vec::new()
        } else {
            advanced::working_text_bytes(repo, path)?.0
        };
        if stamp != read::disk_stamp_for(repo, path)? {
            return Err(error("Working file changed during review"));
        }
        pieces.push(opaque(&[path.as_bytes(), stamp.as_bytes(), &bytes]));
    }
    Ok(opaque(
        &pieces.iter().map(|s| s.as_bytes()).collect::<Vec<_>>(),
    ))
}

impl GitService {
    pub async fn review_lines(
        &self,
        context_id: &str,
        path: &str,
        side: GitDiffSide,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitLineReview> {
        self.check_cancelled(&cancellation)?;
        relative_path(path)?;
        if side == GitDiffSide::Commit {
            return Err(error("Commit lines cannot change the index"));
        }
        let repo = self.repo_for(context_id, &cancellation).await?;
        let status = self.status_for(&repo, &cancellation).await?;
        if status.truncated || status.index_revision != expected_index_revision {
            return Err(error("Git changed. Refresh before reviewing lines."));
        }
        let entry = status
            .entries
            .iter()
            .find(|e| e.path.as_deref() == Some(path))
            .ok_or_else(|| error("This path has no changes"))?;
        if entry.conflicted
            || entry.submodule
            || entry.unsupported_reason.is_some()
            || entry.index_status == "C"
            || entry.worktree_status == "C"
        {
            return Err(error(
                "Partial staging requires ordinary resolved text files",
            ));
        }
        let old_path = entry.old_path.as_deref();
        if let Some(old) = old_path {
            relative_path(old)?;
        }
        let worktree_snapshot = self
            .partial_snapshot(&repo, path, old_path, &cancellation)
            .await?;
        let mut diff = self
            .diff(
                context_id,
                path,
                side,
                expected_index_revision,
                cancellation.clone(),
            )
            .await?;
        if diff.binary || diff.truncated {
            return Err(error("Partial staging requires UTF-8 text up to 1 MiB"));
        }
        if side == GitDiffSide::Working {
            if let Some(working) = diff.new_text.as_deref() {
                // Ask Git to perform the exact path-dependent clean conversion used by
                // add, including attributes, autocrlf and configured clean helpers.
                let hashed = self
                    .checked(
                        &repo,
                        strings(&["hash-object", "-w", "--stdin", &format!("--path={path}")]),
                        vec![],
                        Some(working.as_bytes().to_vec()),
                        &cancellation,
                    )
                    .await?;
                let oid = object_id(String::from_utf8_lossy(&hashed.stdout).trim().as_bytes())?;
                let canonical = self
                    .checked(
                        &repo,
                        strings(&["cat-file", "blob", &oid]),
                        vec![],
                        None,
                        &cancellation,
                    )
                    .await?;
                advanced::require_small_text(&canonical.stdout)?;
                diff.new_text = Some(
                    String::from_utf8(canonical.stdout)
                        .map_err(|_| error("Git clean conversion produced unsupported text"))?,
                );
            }
        }
        // The raw Git patch can describe disk line endings rather than the index
        // representation. Selection is exclusively from these canonical rows.
        diff.patch.clear();
        diff.summary = Some("Index normalized saved text. Git clean filters and line-ending attributes are applied before line review; working bytes remain unchanged.".into());
        // Validate index and base modes independently of the preview's text checks.
        let (_, old_mode, new_mode) = self
            .partial_modes(
                &repo,
                &status,
                path,
                diff.old_path.as_deref(),
                side,
                &cancellation,
            )
            .await?;
        let mut metadata = Vec::new();
        if let Some(old) = diff.old_path.as_deref() {
            metadata.push(format!(
                "Rename {old} to {path}. Selecting metadata moves the complete index path."
            ));
        }
        if old_mode != new_mode {
            metadata.push(format!("File mode/existence: {} to {}. Metadata applies as a whole; deleting an entry requires selecting all changed lines.", old_mode.as_deref().unwrap_or("absent"), new_mode.as_deref().unwrap_or("absent")));
        }
        let hunks = line_hunks(&diff, &worktree_snapshot)?;
        self.check_cancelled(&cancellation)?;
        if self
            .partial_snapshot(&repo, path, old_path, &cancellation)
            .await?
            != worktree_snapshot
        {
            return Err(error("Working file changed during line review"));
        }
        Ok(GitLineReview {
            diff,
            worktree_snapshot,
            hunks,
            metadata,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply_lines(
        &self,
        context_id: &str,
        path: &str,
        side: GitDiffSide,
        line_ids: &[String],
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        include_metadata: bool,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        let _serial = self.0.mutation.lock().await;
        self.check_cancelled(&cancellation)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let mut transaction = IndexTransaction::new(&repo)?;
        let review = self
            .review_lines(
                context_id,
                path,
                side,
                expected_index_revision,
                cancellation.clone(),
            )
            .await?;
        if review.worktree_snapshot != expected_worktree_snapshot {
            return Err(error("Working file changed. Review its lines again."));
        }
        let selected: HashSet<_> = line_ids.iter().map(String::as_str).collect();
        let available: HashSet<_> = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| !l.id.is_empty())
            .map(|l| l.id.as_str())
            .collect();
        if selected.len() != line_ids.len()
            || selected.iter().any(|id| !available.contains(id))
            || (selected.is_empty() && (!include_metadata || review.metadata.is_empty()))
        {
            return Err(error("Select valid changed lines from this exact review"));
        }
        let old = review.diff.old_text.as_deref().unwrap_or("");
        let new = review.diff.new_text.as_deref().unwrap_or("");
        let mut result = String::new();
        let reviewed_rows: HashMap<_, _> = review
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .map(|r| ((r.old_line, r.new_line, r.text.as_str()), r.id.as_str()))
            .collect();
        let changes = line_diff(old, new);
        let mut changed_rows = 0;
        for change in changes.iter_all_changes() {
            if change.tag() != ChangeTag::Equal {
                changed_rows += 1;
                if !reviewed_rows.contains_key(&(
                    change.old_index().map(|i| i as u32 + 1),
                    change.new_index().map(|i| i as u32 + 1),
                    change.value(),
                )) {
                    return Err(error("Line alignment changed. Refresh the line review."));
                }
            }
            let chosen = reviewed_rows
                .get(&(
                    change.old_index().map(|i| i as u32 + 1),
                    change.new_index().map(|i| i as u32 + 1),
                    change.value(),
                ))
                .is_some_and(|id| selected.contains(id));
            let keep = match (side, change.tag()) {
                (_, ChangeTag::Equal) => true,
                (GitDiffSide::Working, ChangeTag::Delete)
                | (GitDiffSide::Staged, ChangeTag::Insert) => !chosen,
                _ => chosen,
            };
            if keep {
                result.push_str(change.value());
            }
        }
        if changed_rows != available.len() {
            return Err(error("Line alignment changed. Refresh the line review."));
        }
        advanced::require_small_text(result.as_bytes())?;
        let status = self.status_for(&repo, &cancellation).await?;
        let (index_mode, old_mode, new_mode) = self
            .partial_modes(
                &repo,
                &status,
                path,
                review.diff.old_path.as_deref(),
                side,
                &cancellation,
            )
            .await?;
        let desired = if side == GitDiffSide::Working {
            new_mode
        } else {
            old_mode
        };
        let mode = if include_metadata {
            desired
        } else {
            index_mode.or_else(|| Some("100644".into()))
        };
        let remove = mode.is_none();
        if remove && (!result.is_empty() || selected.len() != available.len()) {
            return Err(error(
                "Deleting index metadata requires selecting all changed lines",
            ));
        }
        let old_path = review.diff.old_path.as_deref();
        let current_path = if side == GitDiffSide::Working {
            old_path.unwrap_or(path)
        } else {
            path
        };
        let target_path = if include_metadata && side == GitDiffSide::Staged {
            old_path.unwrap_or(path)
        } else if include_metadata {
            path
        } else {
            current_path
        };
        let before = self
            .checked(
                &repo,
                strings(&["ls-files", "--stage", "-z"]),
                transaction.environment(),
                None,
                &cancellation,
            )
            .await?;
        if current_path != target_path {
            let target = self
                .checked(
                    &repo,
                    strings(&["ls-files", "--stage", "-z", "--", target_path]),
                    transaction.environment(),
                    None,
                    &cancellation,
                )
                .await?;
            if entry_mode(&target.stdout, target_path)?.is_some() {
                return Err(error(
                    "Rename metadata would overwrite an existing index path",
                ));
            }
        }
        if current_path != target_path || remove {
            self.checked(
                &repo,
                strings(&["update-index", "--force-remove", "--", current_path]),
                transaction.environment(),
                None,
                &cancellation,
            )
            .await?;
        }
        if !remove {
            let blob = self
                .checked(
                    &repo,
                    strings(&["hash-object", "-w", "--stdin", "--no-filters"]),
                    vec![],
                    Some(result.into_bytes()),
                    &cancellation,
                )
                .await?;
            let oid = object_id(String::from_utf8_lossy(&blob.stdout).trim().as_bytes())?;
            let input = format!("{} {}\t{}\0", mode.unwrap(), oid, target_path).into_bytes();
            self.checked(
                &repo,
                strings(&["update-index", "-z", "--index-info"]),
                transaction.environment(),
                Some(input),
                &cancellation,
            )
            .await?;
        }
        let after = self
            .checked(
                &repo,
                strings(&["ls-files", "--stage", "-z"]),
                transaction.environment(),
                None,
                &cancellation,
            )
            .await?;
        if unaffected(&before.stdout, current_path, target_path)?
            != unaffected(&after.stdout, current_path, target_path)?
        {
            return Err(error("Partial staging would change an unrelated path"));
        }
        self.check_cancelled(&cancellation)?;
        self.repo_for(context_id, &cancellation).await?;
        let current = self.status_for(&repo, &cancellation).await?;
        let entry_old = current
            .entries
            .iter()
            .find(|e| e.path.as_deref() == Some(path))
            .and_then(|e| e.old_path.as_deref());
        if current.index_revision != expected_index_revision
            || self
                .partial_snapshot(&repo, path, entry_old, &cancellation)
                .await?
                != expected_worktree_snapshot
        {
            return Err(error(
                "Git or working files changed before applying selected lines",
            ));
        }
        transaction.apply()?;
        self.finish_status(&repo).await
    }

    async fn partial_snapshot(
        &self,
        repo: &RepoIdentity,
        path: &str,
        old_path: Option<&str>,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        let disk = snapshot(repo, path, old_path)?;
        // Effective values include local, included, global and system config.
        // Attribute output also includes info/attributes and global attributes.
        let config = self
            .checked(
                repo,
                strings(&["config", "--null", "--list", "--show-origin"]),
                vec![],
                None,
                cancellation,
            )
            .await?;
        let mut args = strings(&["check-attr", "--all", "-z", "--", path]);
        if let Some(old) = old_path {
            args.push(old.into());
        }
        let attrs = self.checked(repo, args, vec![], None, cancellation).await?;
        if snapshot(repo, path, old_path)? != disk {
            return Err(error(
                "Working files changed while checking Git conversion settings",
            ));
        }
        Ok(opaque(&[disk.as_bytes(), &config.stdout, &attrs.stdout]))
    }

    async fn partial_modes(
        &self,
        repo: &RepoIdentity,
        status: &GitStatus,
        path: &str,
        old_path: Option<&str>,
        side: GitDiffSide,
        cancellation: &CancellationToken,
    ) -> Result<(Option<String>, Option<String>, Option<String>)> {
        let index_path = if side == GitDiffSide::Working {
            old_path.unwrap_or(path)
        } else {
            path
        };
        let indexed = self
            .checked(
                repo,
                strings(&["ls-files", "--stage", "-z", "--", index_path]),
                vec![],
                None,
                cancellation,
            )
            .await?;
        let index = entry_mode(&indexed.stdout, index_path)?;
        if side == GitDiffSide::Working {
            let filemode = self
                .checked(
                    repo,
                    strings(&[
                        "config",
                        "--type=bool",
                        "--default=true",
                        "--get",
                        "core.filemode",
                    ]),
                    vec![],
                    None,
                    cancellation,
                )
                .await?;
            let trust_executable = match filemode.stdout.as_slice() {
                b"true\n" => true,
                b"false\n" => false,
                _ => return Err(error("Invalid effective core.filemode configuration")),
            };
            let mode = match fs::symlink_metadata(repo.root.join(path)) {
                Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                    #[cfg(unix)]
                    let executable = {
                        use std::os::unix::fs::PermissionsExt;
                        if trust_executable {
                            // Git canonicalizes regular file modes using owner execute.
                            meta.permissions().mode() & 0o100 != 0
                        } else {
                            // With filemode disabled, tracked entries retain their
                            // index mode and new entries default to non-executable.
                            index.as_deref() == Some("100755")
                        }
                    };
                    #[cfg(not(unix))]
                    let executable = {
                        let _ = trust_executable;
                        index.as_deref() == Some("100755")
                    };
                    Some(if executable { "100755" } else { "100644" }.into())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                _ => return Err(error("Partial staging requires ordinary files")),
            };
            Ok((index.clone(), index, mode))
        } else {
            let old = if let Some(head) = status.repository.head.as_deref() {
                let out = self
                    .checked(
                        repo,
                        strings(&["ls-tree", "-z", head, "--", old_path.unwrap_or(path)]),
                        vec![],
                        None,
                        cancellation,
                    )
                    .await?;
                entry_mode(&out.stdout, old_path.unwrap_or(path))?
            } else {
                None
            };
            Ok((index.clone(), old, index))
        }
    }
}
fn entry_mode(bytes: &[u8], path: &str) -> Result<Option<String>> {
    let mut found = None;
    for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| error("Malformed index metadata"))?;
        if &record[tab + 1..] != path.as_bytes() {
            return Err(error("Unexpected path in partial staging metadata"));
        }
        let fields: Vec<_> = record[..tab].split(|b| *b == b' ').collect();
        if fields.len() != 3
            || !matches!(fields[0], b"100644" | b"100755")
            || (fields[2] != b"0" && fields[1] != b"blob")
            || found.is_some()
        {
            return Err(error(
                "Partial staging requires one resolved ordinary text file",
            ));
        }
        found = Some(String::from_utf8(fields[0].to_vec()).unwrap());
    }
    Ok(found)
}
fn unaffected<'a>(bytes: &'a [u8], a: &str, b: &str) -> Result<Vec<&'a [u8]>> {
    bytes
        .split(|v| *v == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|r| match r.iter().position(|v| *v == b'\t') {
            Some(tab) if &r[tab + 1..] == a.as_bytes() || &r[tab + 1..] == b.as_bytes() => None,
            Some(_) => Some(Ok(r)),
            None => Some(Err(error("Malformed index entry"))),
        })
        .collect()
}
