use super::*;

impl GitService {
    /// Explicit initialization is consent to create metadata in this exact workspace.
    pub async fn initialize_repository(&self, token: CancellationToken) -> Result<GitContext> {
        let _serial = self.0.mutation.lock().await;
        self.check_cancelled(&token)?;
        let root = self
            .0
            .workspace_root
            .canonicalize()
            .map_err(|e| error(format!("Resolve workspace: {e}")))?;
        if root != self.0.workspace_root
            || fs::symlink_metadata(root.join(".git")).is_ok()
            || self.discover(&token).await?.is_some()
        {
            return Err(error("Initialize requires a workspace with no existing repository, including parent repositories"));
        }
        self.check_cancelled(&token)?;
        // Refuse a raced repository instead of letting Git reinitialize its metadata.
        fs::create_dir(root.join(".git"))
            .map_err(|reason| error(format!("Reserve new repository metadata: {reason}")))?;
        let out = self
            .run_at(
                &root,
                strings(&["-c", "core.hooksPath=", "init", "--template=", "--", "."]),
                vec![],
                None,
                &token,
            )
            .await?;
        require_success(&out)?;
        self.context(token).await
    }

    /// Never remove a partially cloned directory: a cancelled clone may have written data.
    pub async fn clone_repository(
        &self,
        source: &str,
        destination: &str,
        token: CancellationToken,
    ) -> Result<GitCloneResult> {
        let _serial = self.0.mutation.lock().await;
        self.check_cancelled(&token)?;
        validate_remote_source(source)?;
        let target = new_directory(destination)?;
        let parent = target
            .parent()
            .ok_or_else(|| error("Clone parent is missing"))?;
        if target.starts_with(&self.0.workspace_root) || self.0.workspace_root.starts_with(&target)
        {
            return Err(error(
                "Choose a clone destination outside the open workspace",
            ));
        }
        self.check_cancelled(&token)?;
        // Reserve only a new directory. A concurrently created destination is refused.
        fs::create_dir(&target)
            .map_err(|reason| error(format!("Create clone destination: {reason}")))?;
        let args = vec![
            "-c".into(),
            "core.hooksPath=".into(),
            "-c".into(),
            "protocol.ext.allow=never".into(),
            "clone".into(),
            "--template=".into(),
            "--no-local".into(),
            "--no-recurse-submodules".into(),
            "--".into(),
            source.into(),
            git_path(&target),
        ];
        let result = self
            .run_at(
                parent,
                args,
                vec![
                    (
                        "GIT_ALLOW_PROTOCOL".into(),
                        "https:http:ssh:git:file".into(),
                    ),
                    ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                    ("GIT_SSH_COMMAND".into(), "ssh -oBatchMode=yes".into()),
                    ("GIT_SSH_VARIANT".into(), "ssh".into()),
                    ("GIT_ASKPASS".into(), "".into()),
                    ("SSH_ASKPASS".into(), "".into()),
                    ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
                    ("GCM_INTERACTIVE".into(), "never".into()),
                    (
                        "GIT_CONFIG_GLOBAL".into(),
                        git_path(Path::new(if cfg!(windows) { "NUL" } else { "/dev/null" })),
                    ),
                ],
                None,
                &token,
            )
            .await;
        match result {
            Ok(out) if out.success => Ok(GitCloneResult {
                path: path_text(&target)?,
            }),
            Ok(out) => Err(error(format!(
                "Clone failed. Any partial destination was retained for inspection. {}",
                redact_git_output(
                    &String::from_utf8_lossy(&out.stderr).replace(source, "[remote]")
                )
            ))),
            Err(reason) => Err(error(format!(
                "Clone did not complete. Inspect the destination before retrying. {}",
                redact_git_output(&reason.to_string().replace(source, "[remote]"))
            ))),
        }
    }

    pub async fn configure_remote(
        &self,
        context_id: &str,
        action: GitRemoteConfigAction,
        name: &str,
        url: Option<&str>,
        expected_config_fingerprint: &str,
        token: CancellationToken,
    ) -> Result<GitRemotes> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.review_operation(&repo, None, false, &token).await?;
        validate_remote_name(name)?;
        let mut args = match action {
            GitRemoteConfigAction::Add => strings(&["remote", "add", "--", name]),
            GitRemoteConfigAction::SetUrl => strings(&["remote", "set-url", "--", name]),
            GitRemoteConfigAction::Remove => strings(&["remote", "remove", "--", name]),
        };
        if action != GitRemoteConfigAction::Remove {
            let source = url.ok_or_else(|| error("A remote URL is required"))?;
            validate_remote_source(source)?;
            args.push(source.into());
        }
        self.management_config_review(&repo, expected_config_fingerprint, &token)
            .await?;
        self.checked(&repo, args, vec![], None, &token).await?;
        self.remotes(context_id, token).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn manage_branch(
        &self,
        context_id: &str,
        action: GitBranchManagementAction,
        branch: &str,
        value: Option<&str>,
        expected_oid: &str,
        expected_head: Option<&str>,
        expected_config_fingerprint: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.review_operation(&repo, None, false, &token).await?;
        self.local_branch(&repo, branch, &token).await?;
        let reference = format!("refs/heads/{branch}");
        let oid = self
            .checked(
                &repo,
                strings(&["rev-parse", "--verify", &reference]),
                vec![],
                None,
                &token,
            )
            .await?;
        if object_id(oid.stdout.strip_suffix(b"\n").unwrap_or(&oid.stdout))? != expected_oid
            || self.head(&repo, &token).await?.as_deref() != expected_head
        {
            return Err(error(
                "Branch or HEAD changed. Refresh before managing branches.",
            ));
        }
        if matches!(
            action,
            GitBranchManagementAction::Rename | GitBranchManagementAction::Delete
        ) && self
            .worktrees_for(&repo, &token)
            .await?
            .iter()
            .any(|tree| tree.branch.as_deref() == Some(branch))
        {
            return Err(error(
                "This branch is checked out in a worktree. Switch that worktree first.",
            ));
        }
        let args = match action {
            GitBranchManagementAction::Delete => strings(&["branch", "-d", "--", branch]),
            GitBranchManagementAction::Rename => {
                let new = value.ok_or_else(|| error("New branch name is required"))?;
                self.validate_branch(&repo, new, &token).await?;
                strings(&["branch", "-m", "--", branch, new])
            }
            GitBranchManagementAction::SetUpstream => {
                let upstream = value.ok_or_else(|| error("Upstream branch is required"))?;
                if upstream.starts_with('-')
                    || upstream.contains(['\0', '\r', '\n'])
                    || !upstream.starts_with("refs/")
                {
                    return Err(error("Select a fully qualified upstream reference"));
                }
                self.checked(
                    &repo,
                    strings(&["show-ref", "--verify", upstream]),
                    vec![],
                    None,
                    &token,
                )
                .await?;
                strings(&[
                    "branch",
                    &format!("--set-upstream-to={upstream}"),
                    "--",
                    branch,
                ])
            }
            GitBranchManagementAction::UnsetUpstream => {
                strings(&["branch", "--unset-upstream", "--", branch])
            }
        };
        self.management_config_review(&repo, expected_config_fingerprint, &token)
            .await?;
        self.operation_result(&repo, args, &token).await
    }

    /// Explicitly enabled background fetch never opens terminal or GUI authentication.
    pub async fn auto_fetch(
        &self,
        context_id: &str,
        expected_config_fingerprint: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.review_operation(&repo, None, false, &token).await?;
        self.management_config_review(&repo, expected_config_fingerprint, &token)
            .await?;
        let args = strings(&[
            "-c",
            "core.hooksPath=",
            "-c",
            "credential.interactive=never",
            "-c",
            "submodule.recurse=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "protocol.http.allow=always",
            "-c",
            "protocol.ssh.allow=always",
            "-c",
            "protocol.git.allow=always",
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
        ]);
        self.operation_result_with_env(
            &repo,
            args,
            vec![
                (
                    "GIT_ALLOW_PROTOCOL".into(),
                    "https:http:ssh:git:file".into(),
                ),
                ("GCM_INTERACTIVE".into(), "never".into()),
                ("GIT_ASKPASS".into(), "".into()),
                ("SSH_ASKPASS".into(), "".into()),
                ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
                ("GIT_SSH_COMMAND".into(), "ssh -oBatchMode=yes".into()),
                ("GIT_SSH_VARIANT".into(), "ssh".into()),
            ],
            &token,
        )
        .await
    }

    async fn management_config_review(
        &self,
        repo: &RepoIdentity,
        expected: &str,
        token: &CancellationToken,
    ) -> Result<()> {
        self.repo_for(&repo.id, token).await?;
        if self.config_fingerprint(repo, token).await? != expected {
            return Err(error(
                "Git configuration changed. Review it again before continuing.",
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn worktree_create(
        &self,
        context_id: &str,
        path: &str,
        mode: GitWorktreeCreateMode,
        branch: Option<&str>,
        expected_head: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.review_operation(&repo, None, false, &token).await?;
        let target = new_directory(path)?;
        if target.starts_with(&repo.root)
            || repo.root.starts_with(&target)
            || target.starts_with(&repo.git_dir)
        {
            return Err(error("Choose a worktree directory outside the repository"));
        }
        if self.head(&repo, &token).await?.as_deref() != Some(expected_head) {
            return Err(error(
                "HEAD changed. Review the worktree starting commit again.",
            ));
        }
        object_id(expected_head.as_bytes())?;
        let mut args = strings(&["worktree", "add"]);
        match mode {
            GitWorktreeCreateMode::NewBranch => {
                let name = branch.ok_or_else(|| error("A new branch name is required"))?;
                self.validate_branch(&repo, name, &token).await?;
                args.extend(strings(&["-b", name]));
            }
            GitWorktreeCreateMode::Detached => {
                args.push("--detach".into());
            }
        }
        args.push("--".into());
        args.push(git_path(&target));
        args.push(expected_head.into());
        self.repo_for(context_id, &token).await?;
        self.operation_result(&repo, args, &token).await
    }

    pub async fn worktree_prune_review(
        &self,
        context_id: &str,
        token: CancellationToken,
    ) -> Result<GitWorktreePruneReview> {
        let repo = self.repo_for(context_id, &token).await?;
        self.worktree_management_review(&repo, &token).await
    }

    async fn worktree_management_review(
        &self,
        repo: &RepoIdentity,
        token: &CancellationToken,
    ) -> Result<GitWorktreePruneReview> {
        let list = self
            .checked(
                repo,
                strings(&["worktree", "list", "--porcelain", "-z"]),
                vec![],
                None,
                token,
            )
            .await?;
        let dry = self
            .checked(
                repo,
                strings(&[
                    "worktree",
                    "prune",
                    "--dry-run",
                    "--verbose",
                    "--expire=now",
                ]),
                vec![],
                None,
                token,
            )
            .await?;
        let snapshot = opaque(&[repo.id.as_bytes(), &list.stdout, &dry.stdout, &dry.stderr]);
        Ok(GitWorktreePruneReview {
            snapshot,
            output: redact_git_output(&format!(
                "{}{}",
                String::from_utf8_lossy(&dry.stdout),
                String::from_utf8_lossy(&dry.stderr)
            )),
        })
    }

    pub async fn worktree_prune(
        &self,
        context_id: &str,
        expected_snapshot: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        if self
            .worktree_management_review(&repo, &token)
            .await?
            .snapshot
            != expected_snapshot
        {
            return Err(error("Worktree state changed. Review pruning again."));
        }
        self.operation_result(
            &repo,
            strings(&["worktree", "prune", "--verbose", "--expire=now"]),
            &token,
        )
        .await
    }

    pub async fn worktree_set_locked(
        &self,
        context_id: &str,
        path: &str,
        locked: bool,
        expected_snapshot: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        let trees = self.worktrees_for(&repo, &token).await?;
        let tree = trees
            .iter()
            .find(|tree| tree.path == path && !tree.bare)
            .ok_or_else(|| error("Select a linked worktree"))?;
        if Path::new(path) == repo.root || tree.locked == locked {
            return Err(error(
                "Worktree lock state cannot be changed by this action",
            ));
        }
        if self
            .worktree_management_review(&repo, &token)
            .await?
            .snapshot
            != expected_snapshot
        {
            return Err(error("Worktree state changed. Review it again."));
        }
        self.operation_result(
            &repo,
            strings(&[
                "worktree",
                if locked { "lock" } else { "unlock" },
                "--",
                path,
            ]),
            &token,
        )
        .await
    }
}

fn new_directory(path: &str) -> Result<PathBuf> {
    let target = Path::new(path);
    if !target.is_absolute()
        || path.contains(['\0', '\r', '\n'])
        || target
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || fs::symlink_metadata(target).is_ok()
    {
        return Err(error("Choose a new absolute destination directory"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| error("Destination parent is missing"))?
        .canonicalize()
        .map_err(|e| error(format!("Resolve destination parent: {e}")))?;
    let name = target
        .file_name()
        .ok_or_else(|| error("Destination name is missing"))?;
    Ok(parent.join(name))
}

fn validate_remote_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 256
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        || name.starts_with('-')
        || name == "."
        || name == ".."
    {
        return Err(error("Choose a valid remote name"));
    }
    Ok(())
}

fn validate_remote_source(source: &str) -> Result<()> {
    if source.is_empty()
        || source.len() > 8192
        || source.starts_with('-')
        || source.contains(['\0', '\r', '\n'])
        || source.contains("::")
    {
        return Err(error(
            "Choose a valid Git URL or absolute local repository path",
        ));
    }
    if Path::new(source).is_absolute()
        || ["https://", "http://", "ssh://", "git://", "file://"]
            .iter()
            .any(|scheme| source.starts_with(scheme))
    {
        return Ok(());
    }
    // SCP syntax is accepted only with an explicit user and host.
    if let Some((host, path)) = source.split_once(':') {
        if host.contains('@') && !host.contains(['/', '\\', ' ']) && !path.is_empty() {
            return Ok(());
        }
    }
    Err(error(
        "Use HTTPS, SSH, Git, file, or an absolute local repository path",
    ))
}
