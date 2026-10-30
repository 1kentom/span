use super::*;

impl GitService {
    pub async fn clone_without_workspace(
        source: &str,
        destination: &str,
        token: CancellationToken,
    ) -> Result<GitCloneResult> {
        let target = super::management::new_directory(destination)?;
        let service = Self::new(
            target
                .parent()
                .ok_or_else(|| error("Clone parent is missing"))?
                .to_path_buf(),
        )?;
        let this = &service;
        this.check_cancelled(&token)?;
        super::management::validate_remote_source(source)?;
        let target = super::management::new_directory(destination)?;
        let parent = target
            .parent()
            .ok_or_else(|| error("Clone parent is missing"))?;
        this.check_cancelled(&token)?;
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
            super::management::management_remote_source(source),
            git_path(&target),
        ];
        let result = this
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

    #[allow(clippy::too_many_arguments)]
    pub async fn remote_selected(
        &self,
        context_id: &str,
        action: GitRemoteAction,
        remote_name: &str,
        target_branch: &str,
        expected_index_revision: &str,
        expected_config_fingerprint: &str,
        set_upstream: bool,
        token: CancellationToken,
    ) -> Result<GitSelectedRemoteResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        if self.config_fingerprint(&repo, &token).await? != expected_config_fingerprint {
            return Err(error(
                "Git remote configuration changed. Review the remote URLs again before continuing.",
            ));
        }

        let reviewed = self
            .review_operation(
                &repo,
                Some(expected_index_revision),
                action == GitRemoteAction::Pull,
                &token,
            )
            .await?;
        super::management::validate_remote_name(remote_name)?;
        if !self
            .remotes(context_id, token.clone())
            .await?
            .remotes
            .iter()
            .any(|remote| remote.name == remote_name)
        {
            return Err(error("Select an existing remote"));
        }
        if action != GitRemoteAction::Fetch {
            self.validate_branch(&repo, target_branch, &token).await?;
        }
        let mut pull_ref = None;
        let mut args = match action {
            GitRemoteAction::Fetch => strings(&[
                "fetch",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--",
                remote_name,
            ]),
            GitRemoteAction::Pull => {
                let branch = reviewed
                    .repository
                    .branch
                    .as_deref()
                    .ok_or_else(|| error("Pull requires a local branch"))?;
                self.validate_branch(&repo, branch, &token).await?;
                let remote = remote_name;
                let merge_value = format!("refs/heads/{target_branch}");
                let merge = merge_value.as_str();
                let branch = merge
                    .strip_prefix("refs/heads/")
                    .ok_or_else(|| error("Pull requires a branch upstream"))?;
                self.validate_branch(&repo, branch, &token).await?;
                // Fetch into a unique private ref instead of racing shared FETCH_HEAD.
                let reference = format!(
                    "refs/span/pull/{}/{}",
                    self.0.instance,
                    NEXT_SERVICE.fetch_add(1, Ordering::Relaxed)
                );
                let args = strings(&[
                    "fetch",
                    "--no-recurse-submodules",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--",
                    remote,
                    &format!("{merge}:{reference}"),
                ]);
                pull_ref = Some(reference);
                args
            }
            GitRemoteAction::Push => {
                let branch = reviewed
                    .repository
                    .branch
                    .as_deref()
                    .ok_or_else(|| error("Push requires a local branch"))?;
                self.validate_branch(&repo, branch, &token).await?;
                let remote = remote_name;
                let merge_value = format!("refs/heads/{target_branch}");
                let merge = merge_value.as_str();
                let target = merge
                    .strip_prefix("refs/heads/")
                    .ok_or_else(|| error("Push requires a branch upstream"))?;
                self.validate_branch(&repo, target, &token).await?;
                // Push only this branch to its explicit upstream. Configured multi-ref push rules do not widen this action.
                strings(&[
                    "push",
                    "--no-follow-tags",
                    "--no-mirror",
                    "--recurse-submodules=no",
                    "--",
                    remote,
                    &format!(
                        "{}:{merge}",
                        reviewed
                            .repository
                            .head
                            .as_deref()
                            .ok_or_else(|| error("Create a commit before pushing"))?
                    ),
                ])
            }
        };
        let mut configuration = strings(&[
            "-c",
            "merge.autoStash=false",
            "-c",
            "rebase.autoStash=false",
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
        ]);
        configuration.append(&mut args);
        if self.config_fingerprint(&repo, &token).await? != expected_config_fingerprint {
            return Err(error(
                "Git remote configuration changed. Review the remote URLs again before continuing.",
            ));
        }
        if action != GitRemoteAction::Fetch
            && self.status_for(&repo, &token).await?.index_revision != reviewed.index_revision
        {
            return Err(error(
                "Git HEAD or index changed before the remote action. Refresh Git.",
            ));
        }
        let fetched = self
            .operation_result_with_env(
                &repo,
                configuration,
                vec![
                    (
                        "GIT_ALLOW_PROTOCOL".into(),
                        "https:http:ssh:git:file".into(),
                    ),
                    ("GIT_SSH_COMMAND".into(), "ssh -oBatchMode=yes".into()),
                    ("GIT_SSH_VARIANT".into(), "ssh".into()),
                    ("GIT_ASKPASS".into(), "".into()),
                    ("SSH_ASKPASS".into(), "".into()),
                    ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
                    ("GCM_INTERACTIVE".into(), "never".into()),
                ],
                &token,
            )
            .await?;
        let Some(reference) = pull_ref else {
            let mut result = GitSelectedRemoteResult {
                operation: fetched,
                remote_succeeded: true,
                upstream_configured: false,
                warning: None,
            };
            if action == GitRemoteAction::Push && set_upstream {
                let update = async {
                    self.repo_for(context_id, &token).await?;
                    if self.config_fingerprint(&repo, &token).await? != expected_config_fingerprint
                        || self.status_for(&repo, &token).await?.index_revision
                            != reviewed.index_revision
                    {
                        return Err(error("Git changed after push; upstream was not configured"));
                    }
                    let branch = reviewed
                        .repository
                        .branch
                        .as_deref()
                        .ok_or_else(|| error("Upstream requires a local branch"))?;
                    // branch --set-upstream-to requires a tracking ref which a first push need not create.
                    self.checked(
                        &repo,
                        strings(&[
                            "config",
                            "--local",
                            &format!("branch.{branch}.remote"),
                            remote_name,
                        ]),
                        vec![],
                        None,
                        &token,
                    )
                    .await?;
                    self.checked(
                        &repo,
                        strings(&[
                            "config",
                            "--local",
                            &format!("branch.{branch}.merge"),
                            &format!("refs/heads/{target_branch}"),
                        ]),
                        vec![],
                        None,
                        &token,
                    )
                    .await?;
                    Ok::<(), CoreError>(())
                }
                .await;
                match update {
                    Ok(()) => result.upstream_configured = true,
                    Err(reason) => result.warning = Some(format!("Push succeeded. Upstream configuration did not complete and may be partial. Refresh configuration before retrying. {reason}")),
                }
            }
            return Ok(result);
        };
        let resolved = self
            .checked(
                &repo,
                strings(&["rev-parse", "--verify", &reference]),
                vec![],
                None,
                &token,
            )
            .await?;
        let target = object_id(
            resolved
                .stdout
                .strip_suffix(b"\n")
                .unwrap_or(&resolved.stdout),
        )?;
        let merged = if fetched.status.index_revision != reviewed.index_revision
            || self.config_fingerprint(&repo, &token).await? != expected_config_fingerprint
        {
            Err(error(
                "Git HEAD or index changed while fetching. The branch was not merged. Refresh Git.",
            ))
        } else {
            self.operation_result(
                &repo,
                strings(&[
                    "merge",
                    "--ff-only",
                    "--no-edit",
                    "--no-autostash",
                    "--no-overwrite-ignore",
                    &target,
                ]),
                &token,
            )
            .await
        };
        // Compare-and-swap cleanup cannot remove an externally changed ref.
        let _ = self
            .run_repo(
                &repo,
                strings(&["update-ref", "-d", &reference, &target]),
                vec![],
                None,
                &token,
            )
            .await;
        let mut merged = merged?;
        merged.output = format!("{}{}", fetched.output, merged.output);
        Ok(GitSelectedRemoteResult {
            operation: merged,
            remote_succeeded: true,
            upstream_configured: false,
            warning: None,
        })
    }

    pub async fn worktree_window_path(
        &self,
        context_id: &str,
        path: &str,
        token: CancellationToken,
    ) -> Result<String> {
        let repo = self.repo_for(context_id, &token).await?;
        let requested = Path::new(path)
            .canonicalize()
            .map_err(|e| error(format!("Resolve worktree: {e}")))?;
        let trees = self.worktrees_for(&repo, &token).await?;
        if !trees.iter().any(|tree| {
            !tree.bare && super::management::management_same_path(Path::new(&tree.path), &requested)
        }) {
            return Err(error("Select an existing listed worktree"));
        }
        self.repo_for(context_id, &token).await?;
        path_text(&requested)
    }
}
