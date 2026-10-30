use super::*;

impl GitService {
    /// Checks out the exact head reviewed in the GitHub pull request details.
    /// The native adapter holds the workspace lock and rejects dirty editor drafts.
    #[allow(clippy::too_many_arguments)]
    pub async fn checkout_pull_request(
        &self,
        context_id: &str,
        remote_name: &str,
        number: u32,
        expected_head: &str,
        local_branch: &str,
        expected_index_revision: &str,
        expected_config_fingerprint: &str,
        cancellation: CancellationToken,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let repo = self.repo_for(context_id, &cancellation).await?;
        self.pull_request_config_review(&repo, expected_config_fingerprint, &cancellation)
            .await?;
        if remote_name.is_empty()
            || remote_name.starts_with('-')
            || remote_name.contains(['\0', '\n', '\r'])
        {
            return Err(error("Select an exact configured GitHub remote"));
        }
        let remotes = self
            .checked(&repo, strings(&["remote"]), vec![], None, &cancellation)
            .await?;
        let names = std::str::from_utf8(&remotes.stdout)
            .map_err(|_| error("Remote names must be UTF-8"))?;
        if !names.lines().any(|name| name == remote_name) {
            return Err(error("The reviewed GitHub remote no longer exists"));
        }
        // get-url includes insteadOf expansion. Reject local redirects and multiple
        // fetch URLs rather than assuming the first configured URL is authoritative.
        let urls = self
            .checked(
                &repo,
                strings(&["remote", "get-url", "--all", remote_name]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let text = std::str::from_utf8(&urls.stdout)
            .map_err(|_| error("GitHub remote URL must be UTF-8"))?;
        let urls: Vec<_> = text.lines().collect();
        if urls.len() != 1
            || crate::github::GitHubRepository::from_remote(remote_name, urls[0]).is_none()
        {
            return Err(error(
                "Pull request checkout requires one reviewed github.com fetch URL",
            ));
        }
        self.checkout_pull_request_source(
            context_id,
            &repo,
            remote_name,
            number,
            expected_head,
            local_branch,
            expected_index_revision,
            expected_config_fingerprint,
            &cancellation,
        )
        .await
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn checkout_pull_request_fixture(
        &self,
        context_id: &str,
        source: &str,
        number: u32,
        expected_head: &str,
        branch: &str,
        index: &str,
        config: &str,
    ) -> Result<GitOperationResult> {
        let _serial = self.0.mutation.lock().await;
        let token = CancellationToken::default();
        let repo = self.repo_for(context_id, &token).await?;
        self.checkout_pull_request_source(
            context_id,
            &repo,
            source,
            number,
            expected_head,
            branch,
            index,
            config,
            &token,
        )
        .await
    }

    async fn pull_request_config_review(
        &self,
        repo: &RepoIdentity,
        expected: &str,
        token: &CancellationToken,
    ) -> Result<()> {
        if self.config_fingerprint(repo, token).await? != expected {
            return Err(error(
                "Git remote configuration changed. Review the GitHub remote again.",
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn checkout_pull_request_source(
        &self,
        context_id: &str,
        repo: &RepoIdentity,
        source: &str,
        number: u32,
        expected_head: &str,
        local_branch: &str,
        expected_index_revision: &str,
        expected_config_fingerprint: &str,
        token: &CancellationToken,
    ) -> Result<GitOperationResult> {
        if number == 0 {
            return Err(error("Pull request number must be positive"));
        }
        let target = object_id(expected_head.as_bytes())?;
        self.validate_branch(repo, local_branch, token).await?;
        self.require_new_pr_branch(repo, local_branch, token)
            .await?;
        let reviewed = self
            .review_operation(repo, Some(expected_index_revision), true, token)
            .await?;
        if reviewed.repository.unborn {
            return Err(error(
                "Create an initial commit before checking out a pull request",
            ));
        }
        self.pull_request_config_review(repo, expected_config_fingerprint, token)
            .await?;
        self.repo_for(context_id, token).await?;
        let reference = format!(
            "refs/span/github-pr/{}/{}",
            self.0.instance,
            NEXT_SERVICE.fetch_add(1, Ordering::Relaxed)
        );
        let refspec = format!("refs/pull/{number}/head:{reference}");
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
            "protocol.ssh.allow=always",
            "-c",
            if cfg!(test) {
                "protocol.file.allow=always"
            } else {
                "protocol.file.allow=never"
            },
            "fetch",
            "--no-recurse-submodules",
            "--no-tags",
            "--no-write-fetch-head",
            "--refmap=",
            "--",
            source,
            &refspec,
        ]);
        // Production fetches the reviewed remote name so Git applies insteadOf
        // exactly once, matching get-url. Reusing its expanded URL could apply a
        // second rewrite. File transport exists only in disposable test builds.
        let fetched = self
            .checked(
                repo,
                args,
                vec![
                    (
                        "GIT_ALLOW_PROTOCOL".into(),
                        if cfg!(test) {
                            "https:ssh:file"
                        } else {
                            "https:ssh"
                        }
                        .into(),
                    ),
                    ("GCM_INTERACTIVE".into(), "never".into()),
                    ("GIT_ASKPASS".into(), "".into()),
                    ("SSH_ASKPASS".into(), "".into()),
                    ("SSH_ASKPASS_REQUIRE".into(), "never".into()),
                    ("GIT_SSH_COMMAND".into(), "ssh -oBatchMode=yes".into()),
                    ("GIT_SSH_VARIANT".into(), "ssh".into()),
                ],
                None,
                token,
            )
            .await;
        let cleanup_token = CancellationToken::default();
        let resolved = self
            .checked(
                repo,
                strings(&["rev-parse", "--verify", &reference]),
                vec![],
                None,
                &cleanup_token,
            )
            .await;
        let fetched_oid = resolved.ok().and_then(|output| {
            object_id(output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout)).ok()
        });
        let result = async {
            let fetch = fetched.map_err(|reason| error(format!("Pull request fetch ended with an uncertain outcome: {reason}. Working files were not switched. Refresh Git before retrying.")))?;
            let fetched_oid = fetched_oid.as_deref().ok_or_else(|| error("Fetch completed but its private pull request ref could not be read. Working files were not switched."))?;
            if fetched_oid != target { return Err(error("The pull request head changed since review. Working files were not switched. Refresh pull request details.")); }
            let object = self.checked(repo, strings(&["cat-file", "-t", &target]), vec![], None, token).await?;
            if object.stdout != b"commit\n" { return Err(error("Pull request head must identify an exact commit")); }
            self.pull_request_config_review(repo, expected_config_fingerprint, token).await?;
            self.review_operation(repo, Some(expected_index_revision), true, token).await?;
            self.require_new_pr_branch(repo, local_branch, token).await?;
            self.protect_local_target_paths(repo, &target, token).await?;
            self.repo_for(context_id, token).await?;
            self.pull_request_config_review(repo, expected_config_fingerprint, token).await?;
            self.review_operation(repo, Some(expected_index_revision), true, token).await?;
            let mut result = self.operation_result(repo, strings(&["-c", "submodule.recurse=false", "switch", "--no-guess", "--no-overwrite-ignore", "--no-track", "-c", local_branch, &target]), token).await?;
            if result.status.repository.head.as_deref() != Some(target.as_str())
                || result.status.repository.branch.as_deref() != Some(local_branch)
            {
                return Err(error("Checkout command completed but HEAD changed before verification. Refresh and inspect the branch and working files before retrying."));
            }
            result.output = redact_git_output(&format!("{}{}{}", String::from_utf8_lossy(&fetch.stdout), String::from_utf8_lossy(&fetch.stderr), result.output));
            Ok(result)
        }.await;
        if let Some(oid) = fetched_oid {
            // Cleanup is independent of user cancellation and cannot remove a
            // ref whose value was changed after our fetch review.
            let _ = self
                .run_repo(
                    repo,
                    strings(&["update-ref", "-d", &reference, &oid]),
                    vec![],
                    None,
                    &cleanup_token,
                )
                .await;
        }
        result
    }

    async fn require_new_pr_branch(
        &self,
        repo: &RepoIdentity,
        branch: &str,
        token: &CancellationToken,
    ) -> Result<()> {
        let out = self
            .checked(
                repo,
                strings(&["for-each-ref", "--format=%(refname)", "refs/heads/"]),
                vec![],
                None,
                token,
            )
            .await?;
        let expected = format!("refs/heads/{branch}");
        if out
            .stdout
            .split(|byte| *byte == b'\n')
            .any(|name| name == expected.as_bytes())
        {
            return Err(error("That local branch already exists. Select a new branch name; existing branches are never overwritten."));
        }
        Ok(())
    }
}
