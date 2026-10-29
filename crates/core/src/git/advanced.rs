use super::*;
use mutation::{require_review, IndexTransaction};
use std::{fs::OpenOptions, io::Write};

impl GitService {
    /// Hunk patches originate in Git, never in an IPC supplied patch.
    pub async fn hunk_diff(
        &self,
        context_id: &str,
        path: &str,
        side: GitDiffSide,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitHunkDiff> {
        if side == GitDiffSide::Commit {
            return Err(error("Commit diffs cannot change the index"));
        }
        let repo = self.repo_for(context_id, &cancellation).await?;
        let before = self.status_for(&repo, &cancellation).await?;
        // Hunk review is allowed during merge conflict resolution, but not for
        // the unmerged path itself. Whole-file conflict resolution stays explicit.
        if before.index_revision != expected_index_revision || before.truncated {
            return Err(error("Git changed. Refresh before reviewing hunks."));
        }
        let entry = before
            .entries
            .iter()
            .find(|entry| entry.path.as_deref() == Some(path))
            .ok_or_else(|| error("The selected file has no changes. Refresh Git."))?;
        if entry.conflicted
            || entry.submodule
            || entry.untracked
            || entry.old_path.is_some()
            || entry.unsupported_reason.is_some()
            || if side == GitDiffSide::Working {
                entry.worktree_status != "M"
            } else {
                entry.index_status != "M"
            }
        {
            return Err(error("Hunks require an ordinary modified tracked file. Use a whole-file action for additions, deletions, renames, conflicts or submodules."));
        }
        let worktree_snapshot = bounded_worktree_snapshot(&repo, path)?;
        let meta = fs::symlink_metadata(repo.root.join(relative_path(path)?))
            .map_err(|reason| error(format!("Read hunk file: {reason}")))?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(error("Hunks require an ordinary file"));
        }
        let diff = self
            .diff(
                context_id,
                path,
                side,
                expected_index_revision,
                cancellation.clone(),
            )
            .await?;
        if diff.binary || diff.truncated {
            return Err(error("Binary and oversized diffs cannot be staged by hunk"));
        }
        let hunks = split_hunks(&diff.patch, expected_index_revision, &worktree_snapshot)?;
        if bounded_worktree_snapshot(&repo, path)? != worktree_snapshot {
            return Err(error(
                "Working file changed while reading hunks. Refresh Git.",
            ));
        }
        Ok(GitHunkDiff {
            diff,
            worktree_snapshot,
            hunks,
        })
    }

    /// Working stages the selected hunk, Staged reverses it in the index.
    pub async fn apply_hunk(
        &self,
        context_id: &str,
        path: &str,
        side: GitDiffSide,
        hunk_id: &str,
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let mut transaction = IndexTransaction::new(&repo)?;
        let reviewed = self
            .hunk_diff(
                context_id,
                path,
                side,
                expected_index_revision,
                cancellation.clone(),
            )
            .await?;
        if reviewed.worktree_snapshot != expected_worktree_snapshot {
            return Err(error(
                "Working file changed. Refresh and review its hunks again.",
            ));
        }
        let hunk = reviewed
            .hunks
            .iter()
            .find(|hunk| hunk.id == hunk_id)
            .ok_or_else(|| error("This hunk changed. Refresh and review its diff again."))?;
        let before_entries = self
            .checked(
                &repo,
                strings(&["ls-files", "--stage", "-z"]),
                transaction.environment(),
                None,
                &cancellation,
            )
            .await?;
        let mut args = strings(&["apply", "--cached", "--whitespace=nowarn"]);
        if side == GitDiffSide::Staged {
            args.push("--reverse".into());
        }
        args.push("-".into());
        self.checked(
            &repo,
            args,
            transaction.environment(),
            Some(hunk.patch.as_bytes().to_vec()),
            &cancellation,
        )
        .await?;
        let after_entries = self
            .checked(
                &repo,
                strings(&["ls-files", "--stage", "-z"]),
                transaction.environment(),
                None,
                &cancellation,
            )
            .await?;
        if other_index_entries(&before_entries.stdout, path)?
            != other_index_entries(&after_entries.stdout, path)?
        {
            return Err(error(
                "The hunk would change an unrelated index path. No index changes were applied.",
            ));
        }
        self.check_cancelled(&cancellation)?;
        self.repo_for(context_id, &cancellation).await?;
        let current = self.status_for(&repo, &cancellation).await?;
        if current.index_revision != expected_index_revision
            || bounded_worktree_snapshot(&repo, path)? != expected_worktree_snapshot
        {
            return Err(error(
                "Git or the working file changed before applying the hunk. Refresh Git.",
            ));
        }
        transaction.apply()?;
        self.finish_status(&repo).await
    }

    pub async fn tags(
        &self,
        context_id: &str,
        cancellation: CancellationToken,
    ) -> Result<Vec<GitTag>> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        let output = self
            .checked(
                &repo,
                strings(&[
                    "for-each-ref",
                    "--sort=refname",
                    "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)",
                    "refs/tags/",
                ]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| error("Tag names are not valid UTF-8"))?;
        let mut tags = Vec::new();
        for line in text.lines() {
            let fields: Vec<_> = line.split('\0').collect();
            if fields.len() != 3 {
                return Err(error("Malformed Git tag metadata"));
            }
            let id = object_id(fields[1].as_bytes())?;
            let annotated = !fields[2].is_empty();
            let target_id = if annotated {
                object_id(fields[2].as_bytes())?
            } else {
                id.clone()
            };
            tags.push(GitTag {
                name: fields[0].into(),
                object_id: id,
                target_id,
                annotated,
            });
        }
        self.repo_for(context_id, &cancellation).await?;
        Ok(tags)
    }

    /// Creates a lightweight tag only if this exact name does not exist.
    pub async fn create_tag(
        &self,
        context_id: &str,
        name: &str,
        target_id: &str,
        cancellation: CancellationToken,
    ) -> Result<Vec<GitTag>> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let reference = self.tag_reference(&repo, name, &cancellation).await?;
        let target_id = object_id(target_id.as_bytes())?;
        self.checked(
            &repo,
            strings(&["cat-file", "-e", &format!("{target_id}^{{commit}}")]),
            vec![],
            None,
            &cancellation,
        )
        .await?;
        let zero = "0".repeat(target_id.len());
        self.checked(
            &repo,
            strings(&["update-ref", &reference, &target_id, &zero]),
            vec![],
            None,
            &cancellation,
        )
        .await?;
        self.tags(context_id, cancellation).await
    }

    /// Deletion compares the exact reviewed object, including annotated tag objects.
    pub async fn delete_tag(
        &self,
        context_id: &str,
        name: &str,
        expected_object_id: &str,
        cancellation: CancellationToken,
    ) -> Result<Vec<GitTag>> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let reference = self.tag_reference(&repo, name, &cancellation).await?;
        let expected = object_id(expected_object_id.as_bytes())?;
        self.checked(
            &repo,
            strings(&["update-ref", "-d", &reference, &expected]),
            vec![],
            None,
            &cancellation,
        )
        .await?;
        self.tags(context_id, cancellation).await
    }

    async fn tag_reference(
        &self,
        repo: &RepoIdentity,
        name: &str,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        if name.is_empty()
            || name.starts_with('-')
            || name.contains(['\0', '\n', '\r'])
            || name.len() > 1024
        {
            return Err(error("Select a valid literal tag name"));
        }
        let reference = format!("refs/tags/{name}");
        self.checked(
            repo,
            strings(&["check-ref-format", &reference]),
            vec![],
            None,
            cancellation,
        )
        .await?;
        Ok(reference)
    }

    /// Fast-forward only. Diverged histories are retained for an explicit rebase or merge workflow.
    pub async fn merge_fast_forward(
        &self,
        context_id: &str,
        target_id: &str,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let reviewed = self.status_for(&repo, &cancellation).await?;
        require_review(&reviewed, expected_index_revision, None)?;
        if !reviewed.entries.is_empty()
            || reviewed.repository.detached
            || reviewed.repository.unborn
        {
            return Err(error(
                "Fast-forward merge requires a clean working tree and an existing local branch",
            ));
        }
        let target = object_id(target_id.as_bytes())?;
        self.checked(
            &repo,
            strings(&["cat-file", "-e", &format!("{target}^{{commit}}")]),
            vec![],
            None,
            &cancellation,
        )
        .await?;
        let output = self.checked(&repo, strings(&["merge", "--ff-only", "--no-edit", "--no-autostash", "--no-overwrite-ignore", &target]), vec![], None, &cancellation).await
            .map_err(|reason| error(format!("Fast-forward merge ended: {reason}. Refresh and inspect the branch and working files before retrying.")))?;
        let status = self.finish_status(&repo).await?;
        Ok(GitOperationResult {
            status,
            output: redact_git_output(&String::from_utf8_lossy(&output.stdout)),
        })
    }

    /// Restore only an existing ordinary tracked text file from the index.
    /// The reviewed working bytes remain in a private repository recovery copy.
    pub async fn discard_file(
        &self,
        context_id: &str,
        path: &str,
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitDiscardResult> {
        relative_path(path)?;
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let _index_lock = IndexTransaction::new(&repo)?;
        let reviewed = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(
            &reviewed,
            expected_index_revision,
            expected_worktree_snapshot,
        )?;
        require_review(&reviewed.status, expected_index_revision, None)?;
        let entry = reviewed
            .status
            .entries
            .iter()
            .find(|entry| entry.path.as_deref() == Some(path))
            .ok_or_else(|| {
                error("The selected file no longer has a working change. Refresh Git.")
            })?;
        if entry.untracked
            || entry.conflicted
            || entry.submodule
            || entry.old_path.is_some()
            || entry.worktree_status != "M"
            || !matches!(entry.index_status.as_str(), "." | "M")
            || entry.unsupported_reason.is_some()
        {
            return Err(error("Discard supports ordinary modified tracked text only. Use external Git for untracked files, additions, deletions, renames, conflicts, symlinks and submodules."));
        }
        let (original, permissions) = working_text_bytes(&repo, path)?;
        let original_stamp = read::disk_stamp_for(&repo, path)?;
        let entries = self
            .checked(
                &repo,
                strings(&["ls-files", "--stage", "-z", "--", path]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let records: Vec<_> = entries
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
            .collect();
        let record = records
            .first()
            .ok_or_else(|| error("The selected path is not in the index"))?;
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| error("Malformed index entry"))?;
        let fields: Vec<_> = record[..tab].split(|byte| *byte == b' ').collect();
        if records.len() != 1
            || &record[tab + 1..] != path.as_bytes()
            || fields.len() != 3
            || !matches!(fields[0], b"100644" | b"100755")
            || fields[2] != b"0"
        {
            return Err(error("Discard requires one ordinary resolved index file"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = permissions.mode() & 0o111 != 0;
            if executable != (fields[0] == b"100755") {
                return Err(error("Discarding permission changes requires external Git"));
            }
        }
        let oid = object_id(fields[1])?;
        // Git performs its normal working-tree conversion, including CRLF and
        // configured smudge filters. Raw index bytes are not written to disk.
        let filtered = self
            .checked(
                &repo,
                strings(&["cat-file", "--filters", &format!("--path={path}"), &oid]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        require_small_text(&filtered.stdout)?;
        if original == filtered.stdout {
            return Err(error("This file already matches its index version"));
        }
        let recovery = write_recovery_copy(&repo, &original)?;
        let recovery_text = path_text(&recovery)?;
        let full = repo.root.join(path);
        // Keep prepared bytes inside Git metadata so they never appear as an
        // untracked working file. A different metadata filesystem fails safely.
        let prepared = PreparedDiscard::new(&recovery, &filtered.stdout, permissions)?;
        let current = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(
            &current,
            expected_index_revision,
            expected_worktree_snapshot,
        )?;
        self.repo_for(context_id, &cancellation).await?;
        self.check_cancelled(&cancellation)?;
        // Compare actual bytes immediately before the atomic replacement. No
        // editor draft is saved, and the index stays locked and unchanged.
        if working_text_bytes(&repo, path)?.0 != original
            || read::disk_stamp_for(&repo, path)? != original_stamp
        {
            return Err(error(format!("Working bytes changed before discard. The file was retained. Recovery copy: {recovery_text}")));
        }
        prepared.apply(&full).map_err(|reason| {
            error(format!(
                "Discard could not replace the file: {reason}. Recovery copy: {recovery_text}"
            ))
        })?;
        let status = self.finish_status(&repo).await.map_err(|reason| error(format!("File restored from index, but status refresh failed: {reason}. Recovery copy: {recovery_text}")))?;
        let worktree_snapshot = integration_snapshot(&repo, &status).map_err(|reason| error(format!("File restored from index, but working snapshot refresh failed: {reason}. Recovery copy: {recovery_text}")))?;
        Ok(GitDiscardResult {
            state: GitIntegrationState {
                status,
                worktree_snapshot,
            },
            recovery_path: recovery_text,
        })
    }

    pub async fn integration_state(
        &self,
        context_id: &str,
        cancellation: CancellationToken,
    ) -> Result<GitIntegrationState> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        let state = self.integration_state_for(&repo, &cancellation).await?;
        self.repo_for(context_id, &cancellation).await?;
        Ok(state)
    }

    /// A normal noninteractive rebase, with autostash and multi-branch ref updates disabled.
    pub async fn rebase(
        &self,
        context_id: &str,
        target_id: &str,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitIntegrationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let reviewed = self.status_for(&repo, &cancellation).await?;
        require_review(&reviewed, expected_index_revision, None)?;
        if !reviewed.entries.is_empty()
            || reviewed.repository.detached
            || reviewed.repository.unborn
        {
            return Err(error(
                "Rebase requires a clean working tree and an existing local branch",
            ));
        }
        let target = object_id(target_id.as_bytes())?;
        let kind = self
            .checked(
                &repo,
                strings(&["cat-file", "-t", &target]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        if kind.stdout != b"commit\n" {
            return Err(error("Rebase target must be an exact commit identity"));
        }
        self.protect_local_target_paths(&repo, &target, &cancellation)
            .await?;
        let current = self.status_for(&repo, &cancellation).await?;
        require_review(&current, expected_index_revision, None)?;
        if !current.entries.is_empty() {
            return Err(error("Working files changed before rebasing. Refresh Git."));
        }
        self.run_integration(
            &repo,
            strings(&[
                "-c",
                "rebase.updateRefs=false",
                "rebase",
                "--no-autostash",
                "--no-fork-point",
                "--no-rebase-merges",
                "--no-autosquash",
                &target,
            ]),
            &cancellation,
        )
        .await
    }

    pub async fn rebase_control(
        &self,
        context_id: &str,
        action: GitRebaseAction,
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitIntegrationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let state = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(&state, expected_index_revision, expected_worktree_snapshot)?;
        if !repo.git_dir.join("rebase-merge").is_dir()
            && !repo.git_dir.join("rebase-apply/rebasing").is_file()
        {
            return Err(error("No supported Git rebase is in progress"));
        }
        if action == GitRebaseAction::Continue
            && state
                .status
                .entries
                .iter()
                .any(|entry| entry.conflicted || !entry.untracked && entry.worktree_status != ".")
        {
            return Err(error(
                "Resolve and stage every conflict and unstaged change before continuing the rebase",
            ));
        }
        let verb = if action == GitRebaseAction::Continue {
            "--continue"
        } else {
            "--abort"
        };
        self.run_integration(
            &repo,
            strings(&["-c", "rebase.updateRefs=false", "rebase", verb]),
            &cancellation,
        )
        .await
    }

    /// Marks the explicit reviewed disk path as resolved without modifying disk bytes.
    pub async fn mark_resolved(
        &self,
        context_id: &str,
        path: &str,
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitIntegrationState> {
        relative_path(path)?;
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let mut transaction = IndexTransaction::new(&repo)?;
        let reviewed = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(
            &reviewed,
            expected_index_revision,
            expected_worktree_snapshot,
        )?;
        let entry = reviewed
            .status
            .entries
            .iter()
            .find(|entry| entry.path.as_deref() == Some(path))
            .ok_or_else(|| error("The conflict path is no longer present. Refresh Git."))?;
        if !entry.conflicted || entry.submodule {
            return Err(error("Select an ordinary conflicted file to mark resolved"));
        }
        match fs::symlink_metadata(repo.root.join(path)) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(error(
                    "Resolve symlink, directory and submodule conflicts with external Git",
                ))
            }
            Err(reason) if reason.kind() != std::io::ErrorKind::NotFound => {
                return Err(error(format!("Read resolution file: {reason}")))
            }
            _ => {}
        }
        self.checked(
            &repo,
            strings(&["add", "--", path]),
            transaction.environment(),
            None,
            &cancellation,
        )
        .await?;
        self.check_cancelled(&cancellation)?;
        self.repo_for(context_id, &cancellation).await?;
        let current = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(
            &current,
            expected_index_revision,
            expected_worktree_snapshot,
        )?;
        transaction.apply()?;
        let status = self.finish_status(&repo).await?;
        let worktree_snapshot = integration_snapshot(&repo, &status)?;
        Ok(GitIntegrationState {
            status,
            worktree_snapshot,
        })
    }

    async fn integration_state_for(
        &self,
        repo: &RepoIdentity,
        cancellation: &CancellationToken,
    ) -> Result<GitIntegrationState> {
        let status = self.status_for(repo, cancellation).await?;
        let worktree_snapshot = integration_snapshot(repo, &status)?;
        let after = self.status_for(repo, cancellation).await?;
        if status.index_revision != after.index_revision
            || worktree_snapshot != integration_snapshot(repo, &after)?
        {
            return Err(error(
                "Git or working files changed while reading the integration state. Refresh Git.",
            ));
        }
        Ok(GitIntegrationState {
            status,
            worktree_snapshot,
        })
    }

    async fn protect_local_target_paths(
        &self,
        repo: &RepoIdentity,
        target: &str,
        cancellation: &CancellationToken,
    ) -> Result<()> {
        let indexed = self
            .checked(
                repo,
                strings(&["ls-files", "-z"]),
                vec![],
                None,
                cancellation,
            )
            .await?;
        let indexed: std::collections::HashSet<_> = indexed
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .collect();
        let incoming = self
            .checked(
                repo,
                strings(&["ls-tree", "-r", "--name-only", "-z", target]),
                vec![],
                None,
                cancellation,
            )
            .await?;
        for path in incoming
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            if indexed.contains(path) {
                continue;
            }
            let path = std::str::from_utf8(path).map_err(|_| {
                error("Rebase target contains non-UTF-8 paths that require external Git")
            })?;
            let relative = relative_path(path)?;
            let components: Vec<_> = relative.components().collect();
            let mut cursor = repo.root.clone();
            for (position, component) in components.iter().enumerate() {
                cursor.push(component.as_os_str());
                match fs::symlink_metadata(&cursor) {
                    Ok(meta) if position + 1 == components.len() || !meta.is_dir() || meta.file_type().is_symlink() => return Err(error(format!("Rebase would replace a local untracked or ignored path: {path}. Move it aside explicitly before rebasing."))),
                    Ok(_) => {},
                    Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => break,
                    Err(reason) => return Err(error(format!("Inspect rebase target path {path}: {reason}"))),
                }
            }
        }
        Ok(())
    }

    async fn run_integration(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        cancellation: &CancellationToken,
    ) -> Result<GitIntegrationResult> {
        // Continue retains Git's prepared commit message instead of opening a terminal editor.
        // Hooks and signing remain enabled and use the configured Git behavior.
        let output = self.run_repo(repo, args, vec![("GIT_EDITOR".into(), "true".into())], None, cancellation).await
            .map_err(|reason| error(format!("Rebase command ended before its outcome could be confirmed: {reason}. Refresh and inspect the rebase state before retrying.")))?;
        let status = self.finish_status(repo).await?;
        let worktree_snapshot = integration_snapshot(repo, &status)?;
        let completed = output.success && status.operation.is_none();
        let output = redact_git_output(&format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
        Ok(GitIntegrationResult {
            state: GitIntegrationState {
                status,
                worktree_snapshot,
            },
            output,
            completed,
        })
    }
}

fn other_index_entries<'a>(bytes: &'a [u8], selected: &str) -> Result<Vec<&'a [u8]>> {
    let mut entries = Vec::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| error("Malformed index entry while validating hunk paths"))?;
        if &record[tab + 1..] != selected.as_bytes() {
            entries.push(record);
        }
    }
    Ok(entries)
}

fn require_integration_review(
    state: &GitIntegrationState,
    index: &str,
    working: &str,
) -> Result<()> {
    if state.status.truncated
        || state.status.index_revision != index
        || state.worktree_snapshot != working
    {
        return Err(error(
            "Git or working files changed. Refresh and review the integration state again.",
        ));
    }
    Ok(())
}

fn integration_snapshot(repo: &RepoIdentity, status: &GitStatus) -> Result<String> {
    let mut pieces = vec![
        status.index_revision.as_bytes().to_vec(),
        status
            .operation
            .as_deref()
            .unwrap_or_default()
            .as_bytes()
            .to_vec(),
    ];
    let mut paths = std::collections::BTreeSet::new();
    for entry in &status.entries {
        pieces.push(entry.id.as_bytes().to_vec());
        let path = entry
            .path
            .as_deref()
            .ok_or_else(|| error("Integration actions require UTF-8 working file names"))?;
        paths.insert(path);
        if let Some(old) = entry.old_path.as_deref() {
            paths.insert(old);
        }
    }
    let mut read_budget = INDEX_LIMIT;
    for path in paths {
        pieces.push(path.as_bytes().to_vec());
        let before = read::disk_stamp_for(repo, path)?;
        pieces.push(before.as_bytes().to_vec());
        // Bind bounded ordinary files to their actual bytes as well as stat
        // metadata, including on filesystems with coarse timestamp resolution.
        if let Ok(meta) = fs::symlink_metadata(repo.root.join(path)) {
            if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= TEXT_LIMIT as u64 {
                let mut bytes = Vec::new();
                read::open_working_file(repo, path)?
                    .take(TEXT_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|reason| error(format!("Read Git integration snapshot: {reason}")))?;
                read_budget = read_budget.checked_sub(bytes.len()).ok_or_else(|| error("Changed working files exceed the 32 MiB integration snapshot budget. Use external Git."))?;
                if bytes.len() > TEXT_LIMIT || before != read::disk_stamp_for(repo, path)? {
                    return Err(error(
                        "Working file changed while reading the integration snapshot. Refresh Git.",
                    ));
                }
                pieces.push(opaque(&[&bytes]).into_bytes());
            }
        }
    }
    for path in [
        "MERGE_HEAD",
        "REBASE_HEAD",
        "ORIG_HEAD",
        "rebase-merge/head-name",
        "rebase-merge/orig-head",
        "rebase-merge/onto",
        "rebase-merge/git-rebase-todo",
        "rebase-merge/done",
        "rebase-merge/stopped-sha",
        "rebase-merge/msgnum",
        "rebase-merge/end",
        "rebase-apply/head-name",
        "rebase-apply/orig-head",
        "rebase-apply/onto",
        "rebase-apply/next",
        "rebase-apply/last",
        "rebase-apply/rebasing",
    ] {
        pieces.push(path.as_bytes().to_vec());
        match fs::File::open(repo.git_dir.join(path)) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(TEXT_LIMIT as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|reason| error(format!("Read Git integration metadata: {reason}")))?;
                if bytes.len() > TEXT_LIMIT {
                    return Err(error(
                        "Git integration metadata exceeds the 1 MiB review limit",
                    ));
                }
                pieces.push(bytes);
            }
            Err(reason) if reason.kind() == std::io::ErrorKind::NotFound => pieces.push(Vec::new()),
            Err(reason) => return Err(error(format!("Read Git integration metadata: {reason}"))),
        }
    }
    Ok(opaque(
        &pieces.iter().map(Vec::as_slice).collect::<Vec<_>>(),
    ))
}

fn require_small_text(bytes: &[u8]) -> Result<()> {
    if bytes.len() > TEXT_LIMIT || bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
        return Err(error(
            "This action supports UTF-8 text files up to 1 MiB only",
        ));
    }
    Ok(())
}

fn bounded_worktree_snapshot(repo: &RepoIdentity, path: &str) -> Result<String> {
    let stamp = read::disk_stamp_for(repo, path)?;
    let (bytes, _) = working_text_bytes(repo, path)?;
    if stamp != read::disk_stamp_for(repo, path)? {
        return Err(error(
            "Working file changed while capturing its snapshot. Refresh Git.",
        ));
    }
    Ok(opaque(&[stamp.as_bytes(), &bytes]))
}

fn working_text_bytes(repo: &RepoIdentity, path: &str) -> Result<(Vec<u8>, fs::Permissions)> {
    let before = read::disk_stamp_for(repo, path)?;
    let meta = fs::symlink_metadata(repo.root.join(relative_path(path)?))
        .map_err(|reason| error(format!("Read discard file metadata: {reason}")))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(error("Discard requires an ordinary file without a symlink"));
    }
    let file = read::open_working_file(repo, path)?;
    let meta = file
        .metadata()
        .map_err(|reason| error(format!("Read discard file metadata: {reason}")))?;
    let permissions = meta.permissions();
    let mut bytes = Vec::new();
    file.take(TEXT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|reason| error(format!("Read discard working file: {reason}")))?;
    require_small_text(&bytes)?;
    if before != read::disk_stamp_for(repo, path)? {
        return Err(error(
            "Working file changed while reading discard review. Refresh Git.",
        ));
    }
    Ok((bytes, permissions))
}

fn write_recovery_copy(repo: &RepoIdentity, bytes: &[u8]) -> Result<PathBuf> {
    let directory = repo.git_dir.join("span-recovery");
    match fs::create_dir(&directory) {
        Ok(()) => {}
        Err(reason) if reason.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(reason) => return Err(error(format!("Create Git recovery directory: {reason}"))),
    }
    let meta = fs::symlink_metadata(&directory)
        .map_err(|reason| error(format!("Read Git recovery directory: {reason}")))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(error(
            "Git recovery directory must be an ordinary private directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|reason| error(format!("Protect Git recovery directory: {reason}")))?;
    }
    let serial = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
    let path = directory.join(format!("discard-{}-{serial}.txt", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|reason| error(format!("Create Git recovery copy: {reason}")))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|reason| error(format!("Write Git recovery copy: {reason}")))?;
    Ok(path)
}

struct PreparedDiscard {
    path: PathBuf,
}
impl PreparedDiscard {
    fn new(target: &Path, bytes: &[u8], permissions: fs::Permissions) -> Result<Self> {
        let parent = target
            .parent()
            .ok_or_else(|| error("Discard file has no parent"))?;
        let serial = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".span-discard-{}-{serial}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|reason| error(format!("Prepare discard replacement: {reason}")))?;
        let prepared = Self { path };
        file.set_permissions(permissions)
            .and_then(|_| file.write_all(bytes))
            .and_then(|_| file.sync_all())
            .map_err(|reason| error(format!("Write discard replacement: {reason}")))?;
        Ok(prepared)
    }
    fn apply(self, target: &Path) -> std::io::Result<()> {
        fs::rename(&self.path, target)
    }
}
impl Drop for PreparedDiscard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn split_hunks(patch: &str, index: &str, disk: &str) -> Result<Vec<GitHunk>> {
    let mut prefix = String::new();
    let mut chunks: Vec<(String, String)> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            chunks.push((line.trim_end_matches('\n').into(), line.into()));
        } else if let Some((_, body)) = chunks.last_mut() {
            body.push_str(line);
        } else {
            if !(line.starts_with("diff --git ")
                || line.starts_with("index ")
                || line.starts_with("--- ")
                || line.starts_with("+++ "))
            {
                return Err(error(
                    "Mode changes and non-text file changes require a whole-file action",
                ));
            }
            prefix.push_str(line);
        }
    }
    Ok(chunks
        .into_iter()
        .map(|(header, body)| {
            let patch = format!("{prefix}{body}");
            let id = opaque(&[index.as_bytes(), disk.as_bytes(), patch.as_bytes()]);
            GitHunk { id, header, patch }
        })
        .collect())
}

impl CoreWorkspace {
    /// Refresh only already clean buffers. Disk deletion and unsupported content
    /// remain available through the existing external-file review flow.
    pub fn git_reload_clean_buffers(&mut self) -> Result<()> {
        let paths: Vec<_> = self
            .buffers
            .iter()
            .filter(|(_, buffer)| buffer.revision == buffer.saved_revision)
            .map(|(path, _)| path.clone())
            .collect();
        for path in paths {
            let Ok(resolved) = self.resolve(&path) else {
                continue;
            };
            if !resolved.is_file() {
                continue;
            }
            let Ok(text) = crate::text_file::read_text("Refresh Git buffer", &resolved) else {
                continue;
            };
            if self
                .buffers
                .get(&path)
                .is_some_and(|buffer| buffer.rope.to_string() != text)
            {
                self.discard_buffer(&path)?;
            }
        }
        Ok(())
    }
}
