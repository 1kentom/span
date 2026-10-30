use super::*;
use std::fs::OpenOptions;
use std::io::Write;

impl GitService {
    pub async fn stage(
        &self,
        context_id: &str,
        paths: Vec<String>,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        self.index_action(
            context_id,
            paths,
            expected_index_revision,
            false,
            cancellation,
        )
        .await
    }

    pub async fn unstage(
        &self,
        context_id: &str,
        paths: Vec<String>,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        self.index_action(
            context_id,
            paths,
            expected_index_revision,
            true,
            cancellation,
        )
        .await
    }

    async fn index_action(
        &self,
        context_id: &str,
        paths: Vec<String>,
        expected: &str,
        unstage: bool,
        cancellation: CancellationToken,
    ) -> Result<GitStatus> {
        let _serial = self.0.mutation.lock().await;
        self.check_cancelled(&cancellation)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let mut transaction = IndexTransaction::new(&repo)?;
        let reviewed = self.status_for(&repo, &cancellation).await?;
        require_review(&reviewed, expected, None)?;
        let selected = selected_paths(&reviewed, paths, unstage)?;
        let input = nul_paths(&selected);
        let args = if unstage {
            if reviewed.repository.unborn {
                strings(&["update-index", "--force-remove", "-z", "--stdin"])
            } else {
                strings(&[
                    "restore",
                    "--staged",
                    "--source=HEAD",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ])
            }
        } else {
            strings(&["add", "--pathspec-from-file=-", "--pathspec-file-nul"])
        };
        self.checked(
            &repo,
            args,
            transaction.environment(),
            Some(input),
            &cancellation,
        )
        .await?;
        self.check_cancelled(&cancellation)?;
        let current = self.status_for(&repo, &cancellation).await?;
        require_review(&current, expected, None)?;
        transaction.apply()?;
        // The atomic index replacement has completed. Finish its read-only result
        // before a workspace shutdown drains this mutation transaction.
        self.finish_status(&repo).await
    }

    pub async fn commit(
        &self,
        context_id: &str,
        message: String,
        expected_index_revision: &str,
        expected_staged_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitCommitResult> {
        self.commit_options(
            context_id,
            message,
            None,
            expected_index_revision,
            expected_staged_snapshot,
            cancellation,
        )
        .await
    }

    pub async fn amend(
        &self,
        context_id: &str,
        message: String,
        expected_head: &str,
        expected_index_revision: &str,
        expected_staged_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitCommitResult> {
        self.commit_options(
            context_id,
            message,
            Some(expected_head),
            expected_index_revision,
            expected_staged_snapshot,
            cancellation,
        )
        .await
    }

    async fn commit_options(
        &self,
        context_id: &str,
        message: String,
        amend_head: Option<&str>,
        expected_index_revision: &str,
        expected_staged_snapshot: &str,
        cancellation: CancellationToken,
    ) -> Result<GitCommitResult> {
        if message.trim().is_empty() || message.contains('\0') || message.len() > 64 * 1024 {
            return Err(error(
                "Commit message must be nonblank, contain no NUL and be at most 64 KiB",
            ));
        }
        let _serial = self.0.mutation.lock().await;
        self.check_cancelled(&cancellation)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let mut transaction = IndexTransaction::new(&repo)?;
        let reviewed = self.status_for(&repo, &cancellation).await?;
        require_review(
            &reviewed,
            expected_index_revision,
            Some(expected_staged_snapshot),
        )?;
        if let Some(expected) = amend_head {
            if reviewed.repository.head.as_deref() != Some(expected) {
                return Err(error(
                    "HEAD changed or does not exist. Refresh and review before amending.",
                ));
            }
        }
        let staged = reviewed
            .entries
            .iter()
            .filter(|entry| !entry.untracked && entry.index_status != ".")
            .collect::<Vec<_>>();
        if staged.is_empty() && amend_head.is_none() {
            return Err(error("There are no staged changes to commit"));
        }
        if let Some(entry) = staged
            .iter()
            .find(|entry| entry.unsupported_reason.is_some())
        {
            return Err(error(format!(
                "Cannot commit {}: {}",
                entry.display_path,
                entry
                    .unsupported_reason
                    .as_deref()
                    .unwrap_or("unsupported change")
            )));
        }
        let tree = self
            .checked(
                &repo,
                strings(&["write-tree"]),
                transaction.environment(),
                None,
                &cancellation,
            )
            .await?;
        let tree = object_id(tree.stdout.strip_suffix(b"\n").unwrap_or(&tree.stdout))?;
        let hooks = self
            .path_query_allow_missing(
                &repo.root,
                &["rev-parse", "--git-path", "hooks"],
                &cancellation,
            )
            .await?;
        let symbolic = self
            .run_repo(
                &repo,
                strings(&["symbolic-ref", "-q", "HEAD"]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let expected_ref = if symbolic.success {
            std::str::from_utf8(
                symbolic
                    .stdout
                    .strip_suffix(b"\n")
                    .unwrap_or(&symbolic.stdout),
            )
            .map_err(|_| {
                error("This branch name is not valid UTF-8 and cannot be committed by this view")
            })?
            .to_owned()
        } else {
            "HEAD".into()
        };
        let old = reviewed
            .repository
            .head
            .clone()
            .unwrap_or_else(|| "0".repeat(tree.len()));
        let amend_parents = if let Some(head) = amend_head {
            let output = self
                .checked(
                    &repo,
                    vec![
                        "show".into(),
                        "--no-patch".into(),
                        "--format=%P".into(),
                        head.into(),
                        "--".into(),
                    ],
                    vec![],
                    None,
                    &cancellation,
                )
                .await?;
            Some(
                String::from_utf8(output.stdout)
                    .map_err(|_| error("Invalid commit parent metadata"))?
                    .trim()
                    .to_owned(),
            )
        } else {
            None
        };
        let guard = HookGuard::new(&repo, &hooks)?;
        let mut environment = transaction.environment();
        let program =
            git_program(&self.0.workspace_root).ok_or_else(|| error("Git is unavailable"))?;
        environment.extend([
            ("SPAN_GIT_BINARY".into(), git_path(&program)),
            ("SPAN_GIT_ORIGINAL_HOOKS".into(), git_path(&hooks)),
            ("SPAN_GIT_GUARD_DIR".into(), git_path(&guard.directory)),
            ("SPAN_GIT_GUARD_RECORD".into(), git_path(&guard.record)),
            ("SPAN_GIT_EXPECTED_TREE".into(), tree.clone().into()),
            ("SPAN_GIT_EXPECTED_OLD".into(), old.into()),
            ("SPAN_GIT_EXPECTED_REF".into(), expected_ref.into()),
        ]);
        if let Some(parents) = amend_parents {
            environment.push(("SPAN_GIT_AMEND_PARENTS".into(), parents.into()));
            environment.push(("SPAN_GIT_IS_AMEND".into(), "true".into()));
        } else {
            environment.push(("SPAN_GIT_IS_AMEND".into(), "false".into()));
        }
        self.check_cancelled(&cancellation)?;
        let current = self.status_for(&repo, &cancellation).await?;
        require_review(
            &current,
            expected_index_revision,
            Some(expected_staged_snapshot),
        )?;
        if amend_head.is_some() && current.repository.head.as_deref() != amend_head {
            return Err(error("HEAD changed. Refresh and review before amending."));
        }
        let mut args = strings(&["-c"]);
        args.push(
            format!(
                "core.hooksPath={}",
                git_path(&guard.directory)
                    .to_str()
                    .ok_or_else(|| error("Git hook guard path is not valid UTF-8"))?
            )
            .into(),
        );
        args.extend(strings(&["commit", "--file=-"]));
        if amend_head.is_some() {
            args.push("--amend".into());
        }
        let outcome = self
            .run_repo(
                &repo,
                args,
                environment,
                Some(message.into_bytes()),
                &cancellation,
            )
            .await;

        // A post-commit hook can fail or hang after Git has committed the ref.
        // Never tell the caller to retry a commit that is already the actual HEAD.
        let recorded = fs::read(&guard.record)
            .ok()
            .and_then(|bytes| object_id(bytes.strip_suffix(b"\n").unwrap_or(&bytes)).ok());
        let confirmed = fs::read(guard.directory.join("committed-commit"))
            .ok()
            .and_then(|bytes| object_id(bytes.strip_suffix(b"\n").unwrap_or(&bytes)).ok());
        let actual = if confirmed.is_some() {
            None
        } else {
            self.finish_head(&repo, &CancellationToken::default()).await.map_err(|reason| error(format!("Commit outcome could not be confirmed. Refresh and inspect HEAD before retrying: {reason}")))?
        };
        let succeeded = confirmed.or_else(|| recorded.filter(|id| actual.as_ref() == Some(id)));
        if let Some(id) = succeeded {
            let mut warning = match outcome {
                Ok(output) if output.success => None,
                Ok(output) => Some(format!(
                    "Commit {id} was created, but Git reported: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
                Err(reason) => Some(format!(
                    "Commit {id} was created before the command ended: {reason}"
                )),
            };
            // Git hooks may stage another change after the ref was committed.
            // Preserve that ordinary post-commit index behavior without ever
            // replacing the reviewed tree inside the commit that just succeeded.
            if let Err(reason) = transaction.apply() {
                append_warning(&mut warning, format!("Commit {id} was created, but its final index could not be applied: {reason}"));
            }
            if let Ok(detail) = fs::read_to_string(guard.directory.join("hook-warning")) {
                append_warning(&mut warning, detail.chars().take(1000).collect());
            }
            let commit = match self.finish_log(&repo, &id).await {
                Ok(commits) => commits.into_iter().next(),
                Err(reason) => {
                    append_warning(
                        &mut warning,
                        format!("Commit metadata could not be refreshed: {reason}"),
                    );
                    None
                }
            };
            let status = match self.finish_status(&repo).await {
                Ok(status) => Some(status),
                Err(reason) => {
                    append_warning(
                        &mut warning,
                        format!("Status could not be refreshed: {reason}"),
                    );
                    None
                }
            };
            return Ok(GitCommitResult {
                commit_id: id,
                commit,
                status,
                warning,
            });
        }
        match outcome {
            Ok(output) => {
                require_success(&output)?;
                Err(error("Git did not report a validated reference transaction. Refresh and inspect HEAD before retrying."))
            }
            Err(reason) => Err(reason),
        }
    }

    async fn finish_head(
        &self,
        repo: &RepoIdentity,
        token: &CancellationToken,
    ) -> Result<Option<String>> {
        let output = self
            .finish_run(repo, strings(&["rev-parse", "--verify", "HEAD"]), token)
            .await?;
        if !output.success {
            return Ok(None);
        }
        Ok(Some(object_id(
            output.stdout.strip_suffix(b"\n").unwrap_or(&output.stdout),
        )?))
    }

    async fn finish_log(&self, repo: &RepoIdentity, id: &str) -> Result<Vec<GitCommit>> {
        let mut args = strings(&[
            "log",
            "-z",
            "-1",
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b",
        ]);
        args.push(id.into());
        args.push("--".into());
        let output = self
            .finish_run(repo, args, &CancellationToken::default())
            .await?;
        require_success(&output)?;
        history::parse_history(&output.stdout)
    }

    async fn finish_run(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        token: &CancellationToken,
    ) -> Result<GitOutput> {
        let program = git_program(&self.0.workspace_root)
            .ok_or_else(|| error("Git is unavailable while refreshing the completed action"))?;
        let mut all = vec![
            OsString::from("--git-dir"),
            git_path(&repo.git_dir),
            OsString::from("--work-tree"),
            git_path(&repo.root),
        ];
        all.extend(strings(&[
            "--no-optional-locks",
            "--literal-pathspecs",
            "--no-pager",
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "color.ui=false",
            "-c",
            "log.showSignature=false",
        ]));
        all.extend(args);
        process::run(
            GitCommand {
                program,
                cwd: repo.root.clone(),
                args: all,
                env: vec![],
                input: None,
                timeout: Duration::from_secs(3),
                max_output: OUTPUT_LIMIT,
            },
            token,
            &CancellationToken::default(),
        )
        .await
    }

    pub(super) async fn finish_status(&self, repo: &RepoIdentity) -> Result<GitStatus> {
        // A separate uncancelled read-only service is used only after the atomic
        // mutation point, while shutdown still waits for this transaction's lock.
        let service = Self::from_root(self.0.workspace_root.clone());
        let mut status = service
            .status_for(repo, &CancellationToken::default())
            .await?;
        status.repository.id = repo.id.clone();
        Ok(status)
    }
}

pub(super) fn require_review(status: &GitStatus, index: &str, staged: Option<&str>) -> Result<()> {
    if status.index_revision != index
        || staged.is_some_and(|expected| status.staged_snapshot != expected)
    {
        return Err(error(
            "The Git index or HEAD changed. Refresh and review the staged snapshot again.",
        ));
    }
    if let Some(operation) = &status.operation {
        return Err(error(format!(
            "A Git {operation} is in progress. Complete it with Git before using these actions."
        )));
    }
    if status.truncated {
        return Err(error(
            "The complete status is required before changing the index",
        ));
    }
    Ok(())
}

fn selected_paths(status: &GitStatus, paths: Vec<String>, unstage: bool) -> Result<Vec<String>> {
    if paths.is_empty() || paths.len() > 1000 {
        return Err(error("Select between one and 1000 explicit file paths"));
    }
    let mut result = std::collections::BTreeSet::new();
    for path in paths {
        relative_path(&path)?;
        let entry = status
            .entries
            .iter()
            .find(|entry| entry.path.as_deref() == Some(path.as_str()))
            .ok_or_else(|| error(format!("{path} is no longer a changed file. Refresh Git.")))?;
        if let Some(reason) = &entry.unsupported_reason {
            return Err(error(format!(
                "Cannot change {}: {reason}",
                entry.display_path
            )));
        }
        if unstage && (entry.untracked || entry.index_status == ".") {
            return Err(error(format!("{path} has no staged change")));
        }
        if !unstage && !entry.untracked && entry.worktree_status == "." {
            return Err(error(format!("{path} has no unstaged change")));
        }
        result.insert(path);
        if unstage || entry.index_status == "." {
            if let Some(old) = &entry.old_path {
                relative_path(old)?;
                result.insert(old.clone());
            }
        }
    }
    Ok(result.into_iter().collect())
}

fn nul_paths(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for path in paths {
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0);
    }
    bytes
}

pub(super) struct IndexTransaction {
    index: PathBuf,
    lock: PathBuf,
    marker: Vec<u8>,
    alternate: PathBuf,
    original: Vec<u8>,
    owned_alternate: bool,
}

impl IndexTransaction {
    pub(super) fn new(repo: &RepoIdentity) -> Result<Self> {
        let lock = repo.index.with_file_name("index.lock");
        let serial = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
        let marker = format!("span-git-lock:{}:{serial}\n", std::process::id()).into_bytes();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|e| {
                error(format!(
                    "Cannot acquire Git index lock (another Git operation may be active): {e}"
                ))
            })?;
        if let Err(reason) = file.write_all(&marker).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&lock);
            return Err(error(format!("Write Git index lock: {reason}")));
        }
        let parent = repo
            .index
            .parent()
            .ok_or_else(|| error("Git index has no parent directory"))?;
        let alternate = parent.join(format!(".span-index-{}-{serial}", std::process::id()));
        let mut transaction = Self {
            index: repo.index.clone(),
            lock,
            marker,
            alternate,
            original: Vec::new(),
            owned_alternate: false,
        };
        let mut alt_lock = transaction.alternate.as_os_str().to_os_string();
        alt_lock.push(".lock");
        if transaction.alternate.symlink_metadata().is_ok()
            || PathBuf::from(alt_lock).symlink_metadata().is_ok()
        {
            return Err(error("An owned temporary Git index name is already in use"));
        }
        transaction.owned_alternate = true;
        transaction.original = read_index(&repo.index)?;
        if !transaction.original.is_empty() {
            let mut copy = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&transaction.alternate)
                .map_err(|e| error(format!("Create private Git index: {e}")))?;
            copy.write_all(&transaction.original)
                .and_then(|_| copy.sync_all())
                .map_err(|e| error(format!("Copy private Git index: {e}")))?;
        }
        Ok(transaction)
    }

    pub(super) fn environment(&self) -> Vec<(OsString, OsString)> {
        vec![("GIT_INDEX_FILE".into(), git_path(&self.alternate))]
    }

    pub(super) fn apply(&mut self) -> Result<()> {
        if read_index(&self.index)? != self.original {
            return Err(error(
                "Another writer changed the locked Git index. Refresh before continuing.",
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.alternate)
            .map_err(|e| error(format!("Open completed private index: {e}")))?;
        file.sync_all()
            .map_err(|e| error(format!("Sync completed private index: {e}")))?;
        drop(file);
        fs::rename(&self.alternate, &self.index)
            .map_err(|e| error(format!("Apply Git index transaction: {e}")))
    }
}

fn append_warning(warning: &mut Option<String>, detail: String) {
    match warning {
        Some(existing) => {
            existing.push_str("; ");
            existing.push_str(&detail);
        }
        None => *warning = Some(detail),
    }
}

impl Drop for IndexTransaction {
    fn drop(&mut self) {
        if self.owned_alternate {
            let _ = fs::remove_file(&self.alternate);
            let mut alt_lock = self.alternate.as_os_str().to_os_string();
            alt_lock.push(".lock");
            let _ = fs::remove_file(PathBuf::from(alt_lock));
        }
        if fs::read(&self.lock).ok().as_deref() == Some(self.marker.as_slice()) {
            let _ = fs::remove_file(&self.lock);
        }
    }
}

struct HookGuard {
    directory: PathBuf,
    record: PathBuf,
}
impl HookGuard {
    fn new(repo: &RepoIdentity, original: &Path) -> Result<Self> {
        let serial = NEXT_SERVICE.fetch_add(1, Ordering::Relaxed);
        let directory = repo
            .git_dir
            .join(format!(".span-hooks-{}-{serial}", std::process::id()));
        fs::create_dir(&directory)
            .map_err(|e| error(format!("Create commit review guard: {e}")))?;
        let guard = Self {
            record: directory.join("validated-commit"),
            directory,
        };
        let entries = match fs::read_dir(original) {
            Ok(entries) => Some(entries),
            Err(reason)
                if matches!(
                    reason.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                None
            }
            Err(reason) => return Err(error(format!("Read configured Git hooks: {reason}"))),
        };
        if let Some(entries) = entries {
            for entry in entries {
                let entry = entry.map_err(|e| error(format!("Read configured Git hooks: {e}")))?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if name == "reference-transaction"
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
                {
                    continue;
                }
                if !entry.path().is_file() {
                    continue;
                }
                let script = format!("#!/bin/sh\noriginal=\"$SPAN_GIT_ORIGINAL_HOOKS/{name}\"\nif [ -x \"$original\" ]; then\n  \"$original\" \"$@\"\n  result=$?\n  if [ \"$result\" -ne 0 ]; then printf '%s\\n' 'Configured Git hook {name} returned a failure.' > \"$SPAN_GIT_GUARD_DIR/hook-warning\"; fi\n  exit \"$result\"\nfi\nexit 0\n");
                write_hook(&guard.directory.join(name), script.as_bytes())?;
            }
        }
        write_hook(
            &guard.directory.join("reference-transaction"),
            REFERENCE_GUARD.as_bytes(),
        )?;
        Ok(guard)
    }
}
impl Drop for HookGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn write_hook(path: &Path, script: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| error(format!("Create commit hook guard: {e}")))?;
    file.write_all(script)
        .map_err(|e| error(format!("Write commit hook guard: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o700))
            .map_err(|e| error(format!("Make commit hook guard executable: {e}")))?;
    }
    Ok(())
}

// Git executes this normal POSIX hook on Unix and through Git for Windows' sh.
// Configuration and paths stay in quoted environment values, never shell source.
const REFERENCE_GUARD: &str = r#"#!/bin/sh
umask 077
# Git for Windows' sh can reuse a process id across hook phases, so the input
# file gets a unique exclusive name instead of one derived from $$.
input=$(mktemp "$SPAN_GIT_GUARD_DIR/reference-input-XXXXXX") || exit 1
# The reference protocol always supplies complete LF-terminated lines.
while IFS= read -r line; do printf '%s\n' "$line"; done > "$input"
if [ "$1" = committed ] && [ -s "$SPAN_GIT_GUARD_RECORD" ]; then
  IFS= read -r committed_oid < "$SPAN_GIT_GUARD_RECORD"
  printf '%s\n' "$committed_oid" > "$SPAN_GIT_GUARD_DIR/committed-commit" || exit 1
fi
original="$SPAN_GIT_ORIGINAL_HOOKS/reference-transaction"
if [ -x "$original" ]; then
  "$original" "$@" < "$input"
  result=$?
  if [ "$result" -ne 0 ]; then
    printf '%s\n' 'Configured reference-transaction hook returned a failure.' > "$SPAN_GIT_GUARD_DIR/hook-warning"
    exit "$result"
  fi
fi
if [ "$1" != prepared ]; then exit 0; fi
# Current Git also deletes AUTO_MERGE after a successful ordinary commit.
# Permit only that post-success cleanup, not another branch update.
cleanup=false
if [ -s "$SPAN_GIT_GUARD_DIR/committed-commit" ]; then
  cleanup=true
  while IFS=' ' read -r old new ref extra; do
    if [ "$ref" != AUTO_MERGE ] || [ -n "$extra" ] || [ -z "$new" ]; then cleanup=false; break; fi
    case "$new" in *[!0]*) cleanup=false; break;; esac
  done < "$input"
fi
if [ "$cleanup" = true ]; then exit 0; fi
found=false
validated=
while IFS=' ' read -r old new ref extra; do
  if [ -n "$extra" ] || [ "$old" != "$SPAN_GIT_EXPECTED_OLD" ]; then
    echo 'Span refused a changed HEAD reference. Refresh and review before committing.' >&2
    exit 1
  fi
  if [ "$ref" = "$SPAN_GIT_EXPECTED_REF" ]; then found=true
  elif [ "$ref" != HEAD ]; then
    echo 'Span refused an unexpected reference update.' >&2
    exit 1
  fi
  tree=$("$SPAN_GIT_BINARY" --no-optional-locks --no-replace-objects -c core.fsmonitor=false -c log.showSignature=false show --no-patch --format=%T "$new") || exit 1
  if [ "$tree" != "$SPAN_GIT_EXPECTED_TREE" ]; then
    echo 'Span refused a changed staged tree. A hook or another process changed the reviewed snapshot.' >&2
    exit 1
  fi
  if [ "$SPAN_GIT_IS_AMEND" = true ]; then
    parents=$("$SPAN_GIT_BINARY" --no-optional-locks --no-replace-objects -c core.fsmonitor=false -c log.showSignature=false show --no-patch --format=%P "$new") || exit 1
    if [ "$parents" != "$SPAN_GIT_AMEND_PARENTS" ]; then
      echo 'Span refused changed amend parents. Refresh and review before amending.' >&2
      exit 1
    fi
  fi
  validated=$new
done < "$input"
if [ "$found" != true ] || [ -z "$validated" ]; then
  echo 'Span could not validate the reviewed reference update.' >&2
  exit 1
fi
printf '%s\n' "$validated" > "$SPAN_GIT_GUARD_RECORD" || exit 1
exit 0
"#;
