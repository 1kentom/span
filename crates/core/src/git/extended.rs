use super::*;

impl GitService {
    pub async fn branches(
        &self,
        context_id: &str,
        token: CancellationToken,
    ) -> Result<Vec<GitBranch>> {
        let repo = self.repo_for(context_id, &token).await?;
        let out = self.checked(&repo, strings(&["for-each-ref", "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname)", "refs/heads/", "refs/remotes/"]), vec![], None, &token).await?;
        let mut branches = Vec::new();
        for record in utf8(&out.stdout)?.lines() {
            let fields: Vec<_> = record.split('\0').collect();
            if fields.len() != 5 {
                return Err(error("Malformed Git branch metadata"));
            }
            let remote = fields[0].starts_with("refs/remotes/");
            let name = fields[0]
                .strip_prefix(if remote {
                    "refs/remotes/"
                } else {
                    "refs/heads/"
                })
                .ok_or_else(|| error("Invalid branch reference"))?;
            if remote && name.ends_with("/HEAD") {
                continue;
            }
            let count = |label: &str| {
                fields[3]
                    .split(['[', ']', ',', ' '])
                    .skip_while(|part| *part != label)
                    .nth(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)
            };
            branches.push(GitBranch {
                name: name.into(),
                commit_id: object_id(fields[4].as_bytes())?,
                remote,
                current: fields[1] == "*",
                upstream: (!fields[2].is_empty()).then(|| fields[2].into()),
                ahead: count("ahead"),
                behind: count("behind"),
            });
        }
        self.repo_for(context_id, &token).await?;
        Ok(branches)
    }

    pub async fn checkout(
        &self,
        context_id: &str,
        branch: &str,
        create: bool,
        expected: &str,
        token: CancellationToken,
    ) -> Result<GitStatus> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.validate_branch(&repo, branch, &token).await?;
        let status = self
            .review_operation(&repo, Some(expected), true, &token)
            .await?;
        if !create {
            self.local_branch(&repo, branch, &token).await?;
        }
        if status.repository.unborn {
            return Err(error("Create an initial commit before switching branches"));
        }
        let args = if create {
            strings(&[
                "switch",
                "--no-guess",
                "--no-overwrite-ignore",
                "-c",
                branch,
            ])
        } else {
            strings(&["switch", "--no-guess", "--no-overwrite-ignore", branch])
        };
        self.checked(&repo, args, vec![], None, &token).await?;
        self.status_for(&repo, &token).await
    }

    pub async fn remotes(&self, context_id: &str, token: CancellationToken) -> Result<GitRemotes> {
        let repo = self.repo_for(context_id, &token).await?;
        let before = self.config_fingerprint(&repo, &token).await?;
        let names = self
            .checked(&repo, strings(&["remote"]), vec![], None, &token)
            .await?;
        let names: Vec<_> = utf8(&names.stdout)?
            .lines()
            .map(ToOwned::to_owned)
            .collect();
        let branch = self
            .run_repo(
                &repo,
                strings(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                vec![],
                None,
                &token,
            )
            .await?;
        let mut current = None;
        if branch.success {
            let branch = utf8(&branch.stdout)?.trim_end();
            let configured = self
                .run_repo(
                    &repo,
                    strings(&["config", "--get", &format!("branch.{branch}.remote")]),
                    vec![],
                    None,
                    &token,
                )
                .await?;
            if configured.success {
                current = Some(utf8(&configured.stdout)?.trim_end().to_owned());
            }
        }
        if current.is_none() {
            current = names
                .iter()
                .find(|n| n.as_str() == "origin")
                .or(names.first())
                .cloned();
        }
        let mut remotes = vec![];
        for name in names {
            if name.starts_with('-') || name.contains(['\0', '\n', '\r']) {
                return Err(error("Invalid configured remote name"));
            }
            let fetch = self
                .checked(
                    &repo,
                    strings(&["remote", "get-url", "--all", &name]),
                    vec![],
                    None,
                    &token,
                )
                .await?;
            let push = self
                .checked(
                    &repo,
                    strings(&["remote", "get-url", "--push", "--all", &name]),
                    vec![],
                    None,
                    &token,
                )
                .await?;
            remotes.push(GitRemote {
                current: current.as_deref() == Some(&name),
                name,
                fetch_url: redact_git_output(utf8(&fetch.stdout)?.trim_end()),
                push_url: redact_git_output(utf8(&push.stdout)?.trim_end()),
            });
        }
        if before != self.config_fingerprint(&repo, &token).await? {
            return Err(error(
                "Git remote configuration changed. Refresh before continuing.",
            ));
        }
        self.repo_for(context_id, &token).await?;
        Ok(GitRemotes {
            remotes,
            config_fingerprint: before,
        })
    }

    async fn config_fingerprint(
        &self,
        repo: &RepoIdentity,
        token: &CancellationToken,
    ) -> Result<String> {
        let config = self
            .checked(
                repo,
                strings(&["config", "--null", "--list", "--show-origin"]),
                vec![],
                None,
                token,
            )
            .await?;
        Ok(opaque(&[&config.stdout]))
    }

    pub async fn remote(
        &self,
        context_id: &str,
        action: GitRemoteAction,
        expected_config_fingerprint: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        if self.config_fingerprint(&repo, &token).await? != expected_config_fingerprint {
            return Err(error(
                "Git remote configuration changed. Review the remote URLs again before continuing.",
            ));
        }

        let reviewed = self
            .review_operation(&repo, None, action == GitRemoteAction::Pull, &token)
            .await?;
        let mut pull_ref = None;
        let mut args = match action {
            GitRemoteAction::Fetch => strings(&["fetch", "--no-recurse-submodules"]),
            GitRemoteAction::Pull => {
                let branch = reviewed
                    .repository
                    .branch
                    .as_deref()
                    .ok_or_else(|| error("Pull requires a local branch with an upstream"))?;
                self.validate_branch(&repo, branch, &token).await?;
                let remote = self
                    .checked(
                        &repo,
                        strings(&["config", "--get", &format!("branch.{branch}.remote")]),
                        vec![],
                        None,
                        &token,
                    )
                    .await?;
                let merge = self
                    .checked(
                        &repo,
                        strings(&["config", "--get", &format!("branch.{branch}.merge")]),
                        vec![],
                        None,
                        &token,
                    )
                    .await?;
                let remote = utf8(&remote.stdout)?.trim_end();
                if remote.is_empty()
                    || remote.starts_with('-')
                    || remote.contains(['\n', '\r', '\0'])
                {
                    return Err(error("Configure a valid upstream remote before pulling"));
                }
                let merge = utf8(&merge.stdout)?.trim_end();
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
                    .ok_or_else(|| error("Push requires a local branch with an upstream"))?;
                self.validate_branch(&repo, branch, &token).await?;
                let remote = self
                    .checked(
                        &repo,
                        strings(&["config", "--get", &format!("branch.{branch}.remote")]),
                        vec![],
                        None,
                        &token,
                    )
                    .await?;
                let merge = self
                    .checked(
                        &repo,
                        strings(&["config", "--get", &format!("branch.{branch}.merge")]),
                        vec![],
                        None,
                        &token,
                    )
                    .await?;
                let remote = utf8(&remote.stdout)?.trim_end();
                if remote.is_empty() || remote.starts_with('-') || remote.contains(['\n', '\0']) {
                    return Err(error("Configure a valid upstream remote before pushing"));
                }
                let merge = utf8(&merge.stdout)?.trim_end();
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
                vec![(
                    "GIT_ALLOW_PROTOCOL".into(),
                    "https:http:ssh:git:file".into(),
                )],
                &token,
            )
            .await?;
        let Some(reference) = pull_ref else {
            return Ok(fetched);
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
        let merged = if fetched.status.index_revision != reviewed.index_revision {
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
        Ok(merged)
    }

    pub async fn stashes(
        &self,
        context_id: &str,
        token: CancellationToken,
    ) -> Result<Vec<GitStash>> {
        let repo = self.repo_for(context_id, &token).await?;
        let result = self.stashes_for(&repo, &token).await?;
        self.repo_for(context_id, &token).await?;
        Ok(result)
    }

    async fn stashes_for(
        &self,
        repo: &RepoIdentity,
        token: &CancellationToken,
    ) -> Result<Vec<GitStash>> {
        let out = self
            .checked(
                repo,
                strings(&[
                    "stash",
                    "list",
                    "-z",
                    "--format=%H%x00%gd%x00%gs",
                    "--max-count=200",
                ]),
                vec![],
                None,
                token,
            )
            .await?;
        let fields: Vec<_> = out.stdout.split(|b| *b == 0).collect();
        let mut result = vec![];
        for record in fields.chunks(3) {
            if record.len() < 3 {
                if record.iter().all(|r| r.is_empty()) {
                    break;
                }
                return Err(error("Malformed stash metadata"));
            }
            result.push(GitStash {
                id: object_id(record[0])?,
                selector: utf8(record[1])?.into(),
                subject: utf8(record[2])?.into(),
            });
        }
        Ok(result)
    }

    pub async fn stash(
        &self,
        context_id: &str,
        action: GitStashAction,
        stash_id: Option<String>,
        message: Option<String>,
        expected: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        if matches!(action, GitStashAction::Pop | GitStashAction::Drop) {
            return Err(error("Stash pop and drop are unavailable because concurrent external stash edits cannot be safely bound to a selected entry. Apply the stash and manage deletion with external Git."));
        }
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.review_operation(&repo, Some(expected), false, &token)
            .await?;
        let args = if action == GitStashAction::Save {
            let message = message.unwrap_or_else(|| "Span stash".into());
            if message.contains('\0') || message.len() > 4096 {
                return Err(error("Stash message exceeds 4096 bytes or contains NUL"));
            }
            strings(&["stash", "push", "-m", &message])
        } else {
            let id = stash_id.ok_or_else(|| error("Select a stash first"))?;
            let id = object_id(id.as_bytes())?;
            let stashes = self.stashes_for(&repo, &token).await?;
            if !stashes.iter().any(|stash| stash.id == id) {
                return Err(error(
                    "Stash changed or was removed. Refresh before continuing.",
                ));
            }
            // Applying an immutable object cannot accidentally select a shifted stash ordinal.
            strings(&["stash", "apply", &id])
        };
        self.operation_result(&repo, args, &token).await
    }

    pub async fn worktrees(
        &self,
        context_id: &str,
        token: CancellationToken,
    ) -> Result<Vec<GitWorktree>> {
        let repo = self.repo_for(context_id, &token).await?;
        let result = self.worktrees_for(&repo, &token).await?;
        self.repo_for(context_id, &token).await?;
        Ok(result)
    }

    async fn worktrees_for(
        &self,
        repo: &RepoIdentity,
        token: &CancellationToken,
    ) -> Result<Vec<GitWorktree>> {
        let out = self
            .checked(
                repo,
                strings(&["worktree", "list", "--porcelain", "-z"]),
                vec![],
                None,
                token,
            )
            .await?;
        let mut result = vec![];
        let mut current: Option<GitWorktree> = None;
        for record in out.stdout.split(|b| *b == 0) {
            if record.is_empty() {
                if let Some(tree) = current.take() {
                    result.push(tree);
                }
                continue;
            }
            let record = utf8(record)?;
            if let Some(path) = record.strip_prefix("worktree ") {
                current = Some(GitWorktree {
                    path: path.into(),
                    head: None,
                    branch: None,
                    bare: false,
                    locked: false,
                    prunable: false,
                });
            } else if let Some(tree) = current.as_mut() {
                if let Some(head) = record.strip_prefix("HEAD ") {
                    tree.head = Some(object_id(head.as_bytes())?);
                } else if let Some(branch) = record.strip_prefix("branch refs/heads/") {
                    tree.branch = Some(branch.into());
                } else if record == "bare" {
                    tree.bare = true;
                } else if record == "locked" || record.starts_with("locked ") {
                    tree.locked = true;
                } else if record == "prunable" || record.starts_with("prunable ") {
                    tree.prunable = true;
                }
            }
        }
        if let Some(tree) = current {
            result.push(tree);
        }
        Ok(result)
    }

    pub async fn worktree_add(
        &self,
        context_id: &str,
        path: &str,
        branch: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        self.review_operation(&repo, None, false, &token).await?;
        self.local_branch(&repo, branch, &token).await?;
        let target = Path::new(path);
        if !target.is_absolute()
            || target
                .components()
                .any(|c| matches!(c, Component::ParentDir))
            || path.contains('\0')
            || target.exists()
        {
            return Err(error("Choose a new absolute worktree directory"));
        }
        let parent = target
            .parent()
            .ok_or_else(|| error("Worktree parent is missing"))?
            .canonicalize()
            .map_err(|e| error(format!("Resolve worktree parent: {e}")))?;
        let target = parent.join(
            target
                .file_name()
                .ok_or_else(|| error("Worktree name is missing"))?,
        );
        if target.starts_with(&repo.root)
            || repo.root.starts_with(&target)
            || target.starts_with(&repo.git_dir)
        {
            return Err(error("Choose a worktree outside the current repository"));
        }
        self.operation_result(
            &repo,
            vec![
                "worktree".into(),
                "add".into(),
                "--".into(),
                git_path(&target),
                branch.into(),
            ],
            &token,
        )
        .await
    }

    pub async fn worktree_remove(
        &self,
        context_id: &str,
        path: &str,
        token: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &token).await?;
        let target = Path::new(path)
            .canonicalize()
            .map_err(|e| error(format!("Resolve worktree: {e}")))?;
        if target == repo.root || self.0.workspace_root.starts_with(&target) {
            return Err(error("The open worktree cannot be removed"));
        }
        let trees = self.worktrees_for(&repo, &token).await?;
        if !trees.iter().any(|tree| {
            Path::new(&tree.path).canonicalize().ok().as_ref() == Some(&target)
                && !tree.bare
                && !tree.locked
        }) {
            return Err(error("Select an existing unlocked linked worktree"));
        }
        self.operation_result(
            &repo,
            vec![
                "worktree".into(),
                "remove".into(),
                "--".into(),
                git_path(&target),
            ],
            &token,
        )
        .await
    }

    pub async fn commit_details(
        &self,
        context_id: &str,
        commit_id: &str,
        token: CancellationToken,
    ) -> Result<GitCommitDetails> {
        let repo = self.repo_for(context_id, &token).await?;
        let id = object_id(commit_id.as_bytes())?;
        let page = self
            .history(
                context_id,
                GitHistoryQuery {
                    anchor: Some(id.clone()),
                    skip: 0,
                    limit: 1,
                    path: None,
                },
                token.clone(),
            )
            .await?;
        let commit = page
            .commits
            .into_iter()
            .next()
            .ok_or_else(|| error("Commit is unavailable"))?;
        let mut args = strings(&[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-z",
            "-r",
            "-M",
            "--no-ext-diff",
            "--no-textconv",
        ]);
        if let Some(parent) = commit.parents.first() {
            args.push(parent.into());
        }
        args.push(id.into());
        args.push("--".into());
        let out = self.checked(&repo, args, vec![], None, &token).await?;
        let fields: Vec<_> = out
            .stdout
            .split(|b| *b == 0)
            .filter(|f| !f.is_empty())
            .collect();
        let mut files = vec![];
        let mut at = 0;
        while at < fields.len() {
            let kind = utf8(fields[at])?;
            at += 1;
            let renamed = kind.starts_with('R') || kind.starts_with('C');
            let old_path = if renamed {
                let p = fields
                    .get(at)
                    .ok_or_else(|| error("Malformed commit rename"))?;
                at += 1;
                Some(utf8(p)?.to_owned())
            } else {
                None
            };
            let path = utf8(
                fields
                    .get(at)
                    .ok_or_else(|| error("Malformed commit file metadata"))?,
            )?
            .to_owned();
            at += 1;
            relative_path(&path)?;
            files.push(GitCommitFile {
                path,
                old_path,
                status: kind.into(),
            });
        }
        self.repo_for(context_id, &token).await?;
        Ok(GitCommitDetails { commit, files })
    }

    pub async fn blame(
        &self,
        context_id: &str,
        path: &str,
        token: CancellationToken,
    ) -> Result<GitBlame> {
        relative_path(path)?;
        let repo = self.repo_for(context_id, &token).await?;
        let head = self.head(&repo, &token).await?;
        let mut lines = vec![];
        if let Some(head) = &head {
            // Pin committed attribution. Uncommitted editor/disk lines have no claimed author.
            let out = self
                .checked(
                    &repo,
                    strings(&[
                        "blame",
                        "--line-porcelain",
                        "--no-textconv",
                        head,
                        "--",
                        path,
                    ]),
                    vec![],
                    None,
                    &token,
                )
                .await?;
            let mut current: Option<GitBlameLine> = None;
            for record in utf8(&out.stdout)?.lines() {
                if record.starts_with('\t') {
                    if let Some(line) = current.take() {
                        lines.push(line);
                    }
                    continue;
                }
                if let Some(line) = current.as_mut() {
                    if let Some(author) = record.strip_prefix("author ") {
                        line.author = author.into();
                    } else if let Some(email) = record.strip_prefix("author-mail ") {
                        line.author_email = email.trim_matches(['<', '>']).into();
                    } else if let Some(time) = record.strip_prefix("author-time ") {
                        line.timestamp =
                            time.parse().map_err(|_| error("Invalid blame timestamp"))?;
                    } else if let Some(summary) = record.strip_prefix("summary ") {
                        line.summary = summary.into();
                    }
                } else {
                    let fields: Vec<_> = record.split_whitespace().collect();
                    if fields.len() < 3 {
                        return Err(error("Malformed blame header"));
                    }
                    current = Some(GitBlameLine {
                        commit_id: object_id(fields[0].as_bytes())?,
                        original_line: fields[1]
                            .parse()
                            .map_err(|_| error("Invalid blame line"))?,
                        line: fields[2].parse().map_err(|_| error("Invalid blame line"))?,
                        author: String::new(),
                        author_email: String::new(),
                        timestamp: 0,
                        summary: String::new(),
                    });
                }
            }
        }
        self.repo_for(context_id, &token).await?;
        Ok(GitBlame {
            repository_id: repo.id,
            path: path.into(),
            head,
            lines,
        })
    }

    async fn validate_branch(
        &self,
        repo: &RepoIdentity,
        branch: &str,
        token: &CancellationToken,
    ) -> Result<()> {
        if branch.is_empty()
            || branch.starts_with('-')
            || branch.len() > 1024
            || branch.contains(['\0', '\n', '\r'])
            || branch.starts_with("refs/")
            || branch == "HEAD"
        {
            return Err(error("Select a valid local branch name"));
        }
        self.checked(
            repo,
            strings(&["check-ref-format", &format!("refs/heads/{branch}")]),
            vec![],
            None,
            token,
        )
        .await?;
        Ok(())
    }

    async fn local_branch(
        &self,
        repo: &RepoIdentity,
        branch: &str,
        token: &CancellationToken,
    ) -> Result<()> {
        self.validate_branch(repo, branch, token).await?;
        self.checked(
            repo,
            strings(&["show-ref", "--verify", &format!("refs/heads/{branch}")]),
            vec![],
            None,
            token,
        )
        .await?;
        Ok(())
    }

    async fn review_operation(
        &self,
        repo: &RepoIdentity,
        expected: Option<&str>,
        clean: bool,
        token: &CancellationToken,
    ) -> Result<GitStatus> {
        let status = self.status_for(repo, token).await?;
        if status.operation.is_some()
            || status.truncated
            || status.entries.iter().any(|e| e.conflicted)
        {
            return Err(error(
                "Finish the current Git operation or resolve conflicts first",
            ));
        }
        if expected.is_some_and(|expected| expected != status.index_revision) {
            return Err(error("Git index changed. Refresh before continuing."));
        }
        if clean && !status.entries.is_empty() {
            return Err(error("Commit or stash working changes before this action"));
        }
        Ok(status)
    }

    async fn operation_result(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        token: &CancellationToken,
    ) -> Result<GitOperationResult> {
        self.operation_result_with_env(repo, args, vec![], token)
            .await
    }

    async fn operation_result_with_env(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        env: Vec<(OsString, OsString)>,
        token: &CancellationToken,
    ) -> Result<GitOperationResult> {
        let out = self.checked(repo, args, env, None, token).await.map_err(|reason| {
            error(format!("Git action did not complete successfully. Repository or remote state may have changed. Refresh and inspect before retrying. {reason}"))
        })?;
        let output = redact_git_output(&format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ));
        Ok(GitOperationResult {
            status: self.status_for(repo, token).await.map_err(|reason| error(format!("Git command completed, but its resulting state could not be read. Inspect repository or remote state before retrying. {reason}")))?,
            output,
        })
    }
}

fn utf8(bytes: &[u8]) -> Result<&str> {
    std::str::from_utf8(bytes).map_err(|_| error("Git metadata is not valid UTF-8"))
}
