use super::advanced::{
    require_integration_review, require_small_text, working_text_bytes, write_recovery_copy,
    PreparedDiscard,
};
use super::mutation::require_review;
use super::*;

impl GitIntegrationKind {
    fn command(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
        }
    }
    fn marker(self) -> &'static str {
        match self {
            Self::Merge => "MERGE_HEAD",
            Self::CherryPick => "CHERRY_PICK_HEAD",
            Self::Revert => "REVERT_HEAD",
        }
    }
}

impl GitService {
    pub async fn integration_start(
        &self,
        context_id: &str,
        kind: GitIntegrationKind,
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
                "Integration requires a clean working tree and an existing local branch",
            ));
        }
        let target = object_id(target_id.as_bytes())?;
        let object = self
            .checked(
                &repo,
                strings(&["cat-file", "-t", &target]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        if object.stdout != b"commit\n" {
            return Err(error("Integration target must be an exact commit identity"));
        }
        self.protect_local_target_paths(&repo, &target, &cancellation)
            .await?;
        // Reverting can restore a path that is absent in the target commit.
        if kind == GitIntegrationKind::Revert {
            let parents = self
                .checked(
                    &repo,
                    strings(&["rev-list", "--parents", "-n", "1", &target]),
                    vec![],
                    None,
                    &cancellation,
                )
                .await?;
            let text = String::from_utf8_lossy(&parents.stdout);
            let ids: Vec<_> = text.split_whitespace().collect();
            if ids.len() != 2 {
                return Err(error(
                    "Reverting root or merge commits requires external Git",
                ));
            }
            self.protect_local_target_paths(&repo, ids[1], &cancellation)
                .await?;
        }
        let current = self.status_for(&repo, &cancellation).await?;
        require_review(&current, expected_index_revision, None)?;
        if !current.entries.is_empty() {
            return Err(error(
                "Working files changed before integration. Refresh Git.",
            ));
        }
        self.repo_for(context_id, &cancellation).await?;
        // Disable automatic conflict reuse so reviewed stages remain explicit.
        let args = if kind == GitIntegrationKind::Merge {
            strings(&[
                "-c",
                "rerere.enabled=false",
                "merge",
                "--ff",
                "--no-edit",
                "--no-autostash",
                "--no-overwrite-ignore",
                &target,
            ])
        } else {
            strings(&["-c", "rerere.enabled=false", kind.command(), &target])
        };
        let result = self.run_integration(&repo, args, &cancellation).await?;
        if result.state.status.operation.is_some() {
            fs::write(repo.git_dir.join("span-integration-abort-review"), result.state.worktree_snapshot.as_bytes())
                .map_err(|reason| error(format!("Integration started, but abort review could not be saved: {reason}. Refresh Git.")))?;
        }
        Ok(result)
    }

    pub async fn integration_control(
        &self,
        context_id: &str,
        kind: GitIntegrationKind,
        action: GitRebaseAction,
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitIntegrationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let state = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(&state, expected_index_revision, expected_worktree_snapshot)?;
        if !repo.git_dir.join(kind.marker()).is_file()
            || repo.git_dir.join("rebase-merge").exists()
            || repo.git_dir.join("rebase-apply").exists()
        {
            return Err(error(
                "The selected integration is no longer in progress. Refresh Git.",
            ));
        }
        if action == GitRebaseAction::Continue
            && state
                .status
                .entries
                .iter()
                .any(|entry| entry.conflicted || !entry.untracked && entry.worktree_status != ".")
        {
            return Err(error(
                "Resolve and stage all conflicts and unstaged changes before continuing",
            ));
        }
        // Only an unchanged operation-created working state is automatically
        // abortable. Later edits require external recovery decisions.
        if action == GitRebaseAction::Abort {
            let baseline = fs::read_to_string(repo.git_dir.join("span-integration-abort-review"))
                .map_err(|_| {
                error("No native abort review exists. Use external Git to preserve local changes.")
            })?;
            if baseline != state.worktree_snapshot {
                return Err(error("Working files or index changed after integration started. Abort refused to preserve edits. Use external Git after saving recovery copies."));
            }
            let head = state
                .status
                .repository
                .head
                .as_deref()
                .ok_or_else(|| error("Abort requires the reviewed original commit"))?;
            self.protect_local_target_paths(&repo, head, &cancellation)
                .await?;
        }
        self.repo_for(context_id, &cancellation).await?;
        let verb = if action == GitRebaseAction::Continue {
            "--continue"
        } else {
            "--abort"
        };
        self.run_integration(&repo, strings(&[kind.command(), verb]), &cancellation)
            .await
    }

    pub async fn conflict_resource(
        &self,
        context_id: &str,
        path: &str,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitConflictResource> {
        relative_path(path)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let state = self.integration_state_for(&repo, &cancellation).await?;
        if state.status.index_revision != expected_index_revision || state.status.truncated {
            return Err(error("Git changed. Refresh the conflict."));
        }
        let entry = state
            .status
            .entries
            .iter()
            .find(|entry| entry.path.as_deref() == Some(path))
            .ok_or_else(|| error("Conflict path no longer exists"))?;
        if !entry.conflicted
            || entry.submodule
            || entry.old_path.is_some()
            || entry
                .unsupported_reason
                .as_deref()
                .is_some_and(|reason| reason != "Conflicted files must be resolved in Git")
        {
            return Err(error("Only ordinary text conflicts are supported. Resolve rename, submodule and unsupported conflicts with external Git."));
        }
        if !matches!(
            (entry.index_status.as_str(), entry.worktree_status.as_str()),
            ("U", "U") | ("A", "A")
        ) {
            return Err(error("The three-way editor supports content and add/add conflicts. Resolve add/delete, deletion and rename conflicts with external Git."));
        }
        let records = self
            .checked(
                &repo,
                strings(&["ls-files", "--unmerged", "-z", "--", path]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let mut versions: [Option<String>; 3] = [None, None, None];
        for record in records
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
        {
            let tab = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(|| error("Malformed conflict index entry"))?;
            let fields: Vec<_> = record[..tab].split(|byte| *byte == b' ').collect();
            if &record[tab + 1..] != path.as_bytes()
                || fields.len() != 3
                || !matches!(fields[0], b"100644" | b"100755")
            {
                return Err(error("Conflict is not an ordinary literal file"));
            }
            let stage = match fields[2] {
                b"1" => 0,
                b"2" => 1,
                b"3" => 2,
                _ => return Err(error("Invalid conflict stage")),
            };
            if versions[stage].is_some() {
                return Err(error("Duplicate conflict stage"));
            }
            let oid = object_id(fields[1])?;
            let size = self
                .checked(
                    &repo,
                    strings(&["cat-file", "-s", &oid]),
                    vec![],
                    None,
                    &cancellation,
                )
                .await?;
            let size: usize = String::from_utf8_lossy(&size.stdout)
                .trim()
                .parse()
                .map_err(|_| error("Invalid conflict object size"))?;
            if size > TEXT_LIMIT {
                return Err(error("Conflict object exceeds the 1 MiB text limit"));
            }
            let bytes = self
                .checked(
                    &repo,
                    strings(&["cat-file", "blob", &oid]),
                    vec![],
                    None,
                    &cancellation,
                )
                .await?;
            require_small_text(&bytes.stdout)?;
            versions[stage] = Some(
                String::from_utf8(bytes.stdout).map_err(|_| error("Conflict is not UTF-8 text"))?,
            );
        }
        if versions.iter().all(Option::is_none) {
            return Err(error("No conflict stages remain"));
        }
        let working = String::from_utf8(working_text_bytes(&repo, path)?.0)
            .map_err(|_| error("Conflict working file is not UTF-8"))?;
        let current = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(
            &current,
            &state.status.index_revision,
            &state.worktree_snapshot,
        )?;
        self.repo_for(context_id, &cancellation).await?;
        let [base, ours, theirs] = versions;
        Ok(GitConflictResource {
            path: path.into(),
            base,
            ours,
            theirs,
            working,
            state,
        })
    }

    /// Caller holds the workspace lock so editor drafts cannot race this save.
    pub async fn save_conflict_resolution(
        &self,
        context_id: &str,
        path: &str,
        content: &str,
        expected_index_revision: &str,
        expected_worktree_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitIntegrationState> {
        require_small_text(content.as_bytes())?;
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let _index_lock = mutation::IndexTransaction::new(&repo)?;
        let resource = self
            .conflict_resource(
                context_id,
                path,
                expected_index_revision,
                cancellation.clone(),
            )
            .await?;
        require_integration_review(
            &resource.state,
            expected_index_revision,
            expected_worktree_snapshot,
        )?;
        let (original, permissions) = working_text_bytes(&repo, path)?;
        let stamp = read::disk_stamp_for(&repo, path)?;
        let recovery = write_recovery_copy(&repo, &original)?;
        let prepared = PreparedDiscard::new(&recovery, content.as_bytes(), permissions)?;
        let state = self.integration_state_for(&repo, &cancellation).await?;
        require_integration_review(&state, expected_index_revision, expected_worktree_snapshot)?;
        self.repo_for(context_id, &cancellation).await?;
        self.check_cancelled(&cancellation)?;
        if original != working_text_bytes(&repo, path)?.0
            || stamp != read::disk_stamp_for(&repo, path)?
        {
            return Err(error("Conflict changed before saving. Refresh Git."));
        }
        prepared
            .apply(&repo.root.join(relative_path(path)?))
            .map_err(|reason| error(format!("Save conflict resolution: {reason}")))?;
        self.integration_state_for(&repo, &CancellationToken::default()).await.map_err(|reason| error(format!("Resolution was saved but refresh failed: {reason}. Refresh Git before retrying.")))
    }
}
