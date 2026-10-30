//! Git plumbing for turn checkpoints (ADR 0013).
//!
//! Every call goes through the shared guarded runner. Nothing here touches the
//! user's index, branches, stash, hooks or config: snapshots are built in a
//! private index file with `hash-object --no-filters`, so no configured clean
//! filter, hook or signing helper runs, and refs live under `refs/span/`.
use super::{error, git_path, require_success, strings, GitService, RepoIdentity};
use crate::checkpoint::{CheckpointGit, CpDiff, CpEntry, CpRef, CpRepo};
use crate::{CancellationToken, Result};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_SCRATCH: AtomicU64 = AtomicU64::new(1);

/// A private folder holding the temporary index and an empty hooks folder.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "span-checkpoint-{}-{}",
            std::process::id(),
            NEXT_SCRATCH.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(path.join("hooks"))
            .map_err(|e| error(format!("Create checkpoint scratch folder: {e}")))?;
        Ok(Self(path))
    }
    fn index(&self) -> PathBuf {
        self.0.join("index")
    }
    fn hooks(&self) -> PathBuf {
        self.0.join("hooks")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn read_only_env() -> Vec<(OsString, OsString)> {
    vec![("GIT_OPTIONAL_LOCKS".into(), "0".into())]
}

fn identity_env() -> Vec<(OsString, OsString)> {
    let mut env = read_only_env();
    for (key, value) in [
        ("GIT_AUTHOR_NAME", "Span"),
        ("GIT_AUTHOR_EMAIL", "checkpoints@span.invalid"),
        ("GIT_COMMITTER_NAME", "Span"),
        ("GIT_COMMITTER_EMAIL", "checkpoints@span.invalid"),
    ] {
        env.push((key.into(), value.into()));
    }
    env
}

/// `-c core.hooksPath=<empty folder>` so `update-ref` cannot run a
/// reference-transaction hook.
fn no_hooks(scratch: &Scratch) -> Result<Vec<OsString>> {
    let hooks = git_path(&scratch.hooks());
    let hooks = hooks
        .to_str()
        .ok_or_else(|| error("Checkpoint scratch path is not valid UTF-8"))?;
    Ok(vec!["-c".into(), format!("core.hooksPath={hooks}").into()])
}

fn utf8(bytes: &[u8]) -> Result<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| error("Git returned text that is not UTF-8"))
}

impl GitService {
    async fn checkpoint_repo(&self, token: &CancellationToken) -> Result<RepoIdentity> {
        self.discover(token)
            .await?
            .ok_or_else(|| error("This folder is not inside a local Git working tree"))
    }

    /// Create a repository in the workspace folder. Only ever called from an
    /// explicit user action ("Enable checkpoints").
    pub async fn init_repository(&self, token: CancellationToken) -> Result<()> {
        if self.discover(&token).await?.is_some() {
            return Ok(());
        }
        let output = self
            .run_at(
                &self.0.workspace_root.clone(),
                strings(&["init", "--quiet"]),
                vec![],
                None,
                &token,
            )
            .await?;
        require_success(&output)
    }
}

impl CheckpointGit for GitService {
    async fn repo(&self, token: &CancellationToken) -> Result<Option<CpRepo>> {
        let Some(repo) = self.discover(token).await? else {
            return Ok(None);
        };
        let prefix = self
            .0
            .workspace_root
            .strip_prefix(&repo.root)
            .map_err(|_| error("Workspace moved outside its repository"))?;
        let mut prefix = git_path(prefix).to_string_lossy().replace('\\', "/");
        if !prefix.is_empty() && !prefix.ends_with('/') {
            prefix.push('/');
        }
        Ok(Some(CpRepo {
            root: repo.root,
            prefix,
        }))
    }

    async fn list_files(&self, repo: &CpRepo, token: &CancellationToken) -> Result<Vec<String>> {
        let identity = self.checkpoint_repo(token).await?;
        let mut args = strings(&[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ]);
        if !repo.prefix.is_empty() {
            args.push("--".into());
            args.push(repo.prefix.clone().into());
        }
        let output = self
            .run_repo(&identity, args, read_only_env(), None, token)
            .await?;
        require_success(&output)?;
        let mut files: Vec<String> = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .filter_map(|part| String::from_utf8(part.to_vec()).ok())
            .collect();
        files.sort();
        files.dedup();
        Ok(files)
    }

    async fn hash_files(
        &self,
        _repo: &CpRepo,
        paths: &[String],
        token: &CancellationToken,
    ) -> Result<Vec<String>> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let identity = self.checkpoint_repo(token).await?;
        let mut input = Vec::new();
        for path in paths {
            input.extend_from_slice(path.as_bytes());
            input.push(b'\n');
        }
        let output = self
            .run_repo(
                &identity,
                strings(&["hash-object", "-w", "--no-filters", "--stdin-paths"]),
                read_only_env(),
                Some(input),
                token,
            )
            .await?;
        require_success(&output)?;
        let ids: Vec<String> = utf8(&output.stdout)?.lines().map(str::to_owned).collect();
        if ids.len() != paths.len() {
            return Err(error("Git hashed a different number of files than asked"));
        }
        Ok(ids)
    }

    async fn write_tree(
        &self,
        _repo: &CpRepo,
        entries: &[CpEntry],
        token: &CancellationToken,
    ) -> Result<String> {
        let identity = self.checkpoint_repo(token).await?;
        let scratch = Scratch::new()?;
        let env = || {
            let mut env = read_only_env();
            env.push(("GIT_INDEX_FILE".into(), git_path(&scratch.index())));
            env
        };
        if !entries.is_empty() {
            let mut input = Vec::new();
            for entry in entries {
                input.extend_from_slice(
                    format!("{} {}\t{}", entry.mode, entry.oid, entry.path).as_bytes(),
                );
                input.push(0);
            }
            let output = self
                .run_repo(
                    &identity,
                    strings(&["update-index", "--add", "-z", "--index-info"]),
                    env(),
                    Some(input),
                    token,
                )
                .await?;
            require_success(&output)?;
        }
        let output = self
            .run_repo(&identity, strings(&["write-tree"]), env(), None, token)
            .await?;
        require_success(&output)?;
        Ok(utf8(&output.stdout)?.trim().to_owned())
    }

    async fn commit_tree(
        &self,
        _repo: &CpRepo,
        tree: &str,
        message: &str,
        parent: Option<&str>,
        token: &CancellationToken,
    ) -> Result<String> {
        let identity = self.checkpoint_repo(token).await?;
        let scratch = Scratch::new()?;
        let mut args = no_hooks(&scratch)?;
        args.extend(strings(&["commit-tree", "--no-gpg-sign", tree]));
        if let Some(parent) = parent {
            args.push("-p".into());
            args.push(parent.into());
        }
        let output = self
            .run_repo(
                &identity,
                args,
                identity_env(),
                Some(message.as_bytes().to_vec()),
                token,
            )
            .await?;
        require_success(&output)?;
        Ok(utf8(&output.stdout)?.trim().to_owned())
    }

    async fn update_refs(
        &self,
        _repo: &CpRepo,
        updates: &[(String, Option<String>)],
        token: &CancellationToken,
    ) -> Result<()> {
        if updates.is_empty() {
            return Ok(());
        }
        let identity = self.checkpoint_repo(token).await?;
        let scratch = Scratch::new()?;
        let mut input = String::new();
        for (name, target) in updates {
            if !name.starts_with("refs/span/checkpoints/") {
                return Err(error(
                    "Checkpoints only write refs under refs/span/checkpoints",
                ));
            }
            match target {
                Some(commit) => input.push_str(&format!("update {name} {commit}\n")),
                None => input.push_str(&format!("delete {name}\n")),
            }
        }
        let mut args = no_hooks(&scratch)?;
        args.extend(strings(&["update-ref", "--no-deref", "--stdin"]));
        let output = self
            .run_repo(
                &identity,
                args,
                identity_env(),
                Some(input.into_bytes()),
                token,
            )
            .await?;
        require_success(&output)
    }

    async fn list_refs(
        &self,
        _repo: &CpRepo,
        prefix: &str,
        token: &CancellationToken,
    ) -> Result<Vec<CpRef>> {
        let identity = self.checkpoint_repo(token).await?;
        let output = self
            .run_repo(
                &identity,
                vec![
                    "for-each-ref".into(),
                    "--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)%00%(committerdate:unix)"
                        .into(),
                    prefix.into(),
                ],
                read_only_env(),
                None,
                token,
            )
            .await?;
        require_success(&output)?;
        let text = utf8(&output.stdout)?;
        let mut refs = Vec::new();
        for line in text.lines().filter(|line| !line.is_empty()) {
            let parts: Vec<&str> = line.split('\0').collect();
            if parts.len() != 5 {
                continue;
            }
            refs.push(CpRef {
                name: parts[0].to_owned(),
                commit: parts[1].to_owned(),
                tree: parts[2].to_owned(),
                parent: parts[3].split_whitespace().next().map(str::to_owned),
                time: parts[4].parse().unwrap_or_default(),
            });
        }
        Ok(refs)
    }

    async fn diff_trees(
        &self,
        repo: &CpRepo,
        from: &str,
        to: &str,
        token: &CancellationToken,
    ) -> Result<Vec<CpDiff>> {
        let identity = self.checkpoint_repo(token).await?;
        let mut args = strings(&[
            "diff-tree",
            "-r",
            "-z",
            "--raw",
            "--no-renames",
            "--no-textconv",
            "--no-ext-diff",
            from,
            to,
        ]);
        if !repo.prefix.is_empty() {
            args.push("--".into());
            args.push(repo.prefix.clone().into());
        }
        let output = self
            .run_repo(&identity, args, read_only_env(), None, token)
            .await?;
        require_success(&output)?;
        let mut parts = output.stdout.split(|byte| *byte == 0);
        let mut diffs = Vec::new();
        while let Some(header) = parts.next() {
            if header.is_empty() {
                continue;
            }
            let header = utf8(header)?;
            let Some(path) = parts.next() else { break };
            let fields: Vec<&str> = header.trim_start_matches(':').split(' ').collect();
            if fields.len() < 5 {
                return Err(error("Git returned an unexpected tree diff"));
            }
            let zero = |oid: &str| oid.bytes().all(|b| b == b'0');
            diffs.push(CpDiff {
                old_oid: (!zero(fields[2])).then(|| fields[2].to_owned()),
                new_oid: (!zero(fields[3])).then(|| fields[3].to_owned()),
                old_mode: fields[0].to_owned(),
                new_mode: fields[1].to_owned(),
                path: utf8(path)?,
            });
        }
        Ok(diffs)
    }

    async fn read_blobs(
        &self,
        _repo: &CpRepo,
        oids: &[String],
        token: &CancellationToken,
    ) -> Result<HashMap<String, Vec<u8>>> {
        let mut blobs = HashMap::new();
        if oids.is_empty() {
            return Ok(blobs);
        }
        let identity = self.checkpoint_repo(token).await?;
        // Sizes first, then batches that stay under the runner's output limit.
        let mut listing = String::new();
        for oid in oids {
            listing.push_str(oid);
            listing.push('\n');
        }
        let sizes = self
            .run_repo(
                &identity,
                strings(&["cat-file", "--batch-check"]),
                read_only_env(),
                Some(listing.into_bytes()),
                token,
            )
            .await?;
        require_success(&sizes)?;
        let mut batches: Vec<(String, usize)> = Vec::new();
        for line in utf8(&sizes.stdout)?.lines() {
            let fields: Vec<&str> = line.split(' ').collect();
            if fields.len() != 3 || fields[1] != "blob" {
                return Err(error(format!("Checkpoint object is missing: {line}")));
            }
            let size: usize = fields[2]
                .parse()
                .map_err(|_| error("Git returned an invalid blob size"))?;
            let budget = super::OUTPUT_LIMIT / 2;
            match batches.last_mut() {
                Some((input, total)) if *total + size + 128 <= budget => {
                    input.push_str(fields[0]);
                    input.push('\n');
                    *total += size + 128;
                }
                _ => batches.push((format!("{}\n", fields[0]), size + 128)),
            }
        }
        for (input, _) in batches {
            let output = self
                .run_repo(
                    &identity,
                    strings(&["cat-file", "--batch"]),
                    read_only_env(),
                    Some(input.into_bytes()),
                    token,
                )
                .await?;
            require_success(&output)?;
            let mut rest = output.stdout.as_slice();
            while !rest.is_empty() {
                let end = rest
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .ok_or_else(|| error("Git returned an unexpected blob listing"))?;
                let header = utf8(&rest[..end])?;
                rest = &rest[end + 1..];
                let fields: Vec<&str> = header.split(' ').collect();
                if fields.len() != 3 || fields[1] != "blob" {
                    return Err(error(format!("Checkpoint object is missing: {header}")));
                }
                let size: usize = fields[2]
                    .parse()
                    .map_err(|_| error("Git returned an invalid blob size"))?;
                if rest.len() < size {
                    return Err(error("Git returned a truncated blob"));
                }
                blobs.insert(fields[0].to_owned(), rest[..size].to_vec());
                rest = rest.get(size + 1..).unwrap_or_default();
            }
        }
        Ok(blobs)
    }
}
