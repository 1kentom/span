use super::*;

const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b";

#[derive(Default)]
struct Content {
    text: Option<String>,
    binary: bool,
    large: bool,
}
impl Content {
    fn bytes(bytes: Vec<u8>) -> Self {
        if bytes.len() > TEXT_LIMIT {
            return Self {
                large: true,
                ..Self::default()
            };
        }
        if bytes.contains(&0) {
            return Self {
                binary: true,
                ..Self::default()
            };
        }
        match String::from_utf8(bytes) {
            Ok(text) => Self {
                text: Some(text),
                ..Self::default()
            },
            Err(_) => Self {
                binary: true,
                ..Self::default()
            },
        }
    }
}

impl GitService {
    /// Blob baselines are separate from disk and editor text, so drafts stay untouched.
    pub async fn file_baseline(
        &self,
        context_id: &str,
        path: &str,
        cancellation: CancellationToken,
    ) -> Result<GitFileBaseline> {
        relative_path(path)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let before = self.status_for(&repo, &cancellation).await?;
        let head = self
            .tree_content(
                &repo,
                before.repository.head.as_deref(),
                path,
                &cancellation,
            )
            .await?;
        let index = self.index_content(&repo, path, &cancellation).await?;
        let after = self.status_for(&repo, &cancellation).await?;
        if before.index_revision != after.index_revision {
            return Err(error(
                "Git changed while reading file baselines. Refresh Git.",
            ));
        }
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitFileBaseline {
            repository_id: repo.id,
            path: path.into(),
            index_revision: before.index_revision,
            binary: head.binary || index.binary,
            truncated: head.large || index.large,
            head_text: head.text,
            index_text: index.text,
        })
    }

    pub async fn diff(
        &self,
        context_id: &str,
        path: &str,
        side: GitDiffSide,
        expected_index_revision: &str,
        cancellation: CancellationToken,
    ) -> Result<GitDiff> {
        relative_path(path)?;
        if side == GitDiffSide::Commit {
            return Err(error("Select a commit to view its diff"));
        }
        let repo = self.repo_for(context_id, &cancellation).await?;
        let status = self.status_for(&repo, &cancellation).await?;
        if status.index_revision != expected_index_revision {
            return Err(error(
                "Git index changed. Refresh before opening this diff.",
            ));
        }
        let change = status
            .entries
            .iter()
            .find(|entry| entry.path.as_deref() == Some(path));
        if let Some(change) = change {
            if change.conflicted || change.submodule || change.unsupported_reason.is_some() {
                return Err(error("This entry requires an external Git diff (conflict, submodule, or unsupported path)."));
            }
        }
        let old_path = change.and_then(|entry| {
            let renamed_on_side = if side == GitDiffSide::Staged {
                entry.index_status == "R" || entry.index_status == "C"
            } else {
                entry.worktree_status == "R" || entry.worktree_status == "C"
            };
            if renamed_on_side {
                entry.old_path.clone()
            } else {
                None
            }
        });
        let untracked = change.is_some_and(|entry| entry.untracked);
        let (old, new, disk_stamp) = if side == GitDiffSide::Staged {
            let old = self
                .tree_content(
                    &repo,
                    status.repository.head.as_deref(),
                    old_path.as_deref().unwrap_or(path),
                    &cancellation,
                )
                .await?;
            (
                old,
                self.index_content(&repo, path, &cancellation).await?,
                None,
            )
        } else {
            let old = self
                .index_content(&repo, old_path.as_deref().unwrap_or(path), &cancellation)
                .await?;
            let (new, stamp) = disk_content(&repo, path)?;
            (old, new, Some(stamp))
        };
        let mut result = make_diff(
            &repo,
            path,
            old_path.clone(),
            side,
            status.index_revision.clone(),
            old,
            new,
        );
        if untracked {
            let detail = result.summary.take().unwrap_or_default();
            result.summary = Some(format!(
                "Untracked file preview. Stage the file to include it in a commit. {detail}"
            ));
        }
        if !result.binary && !result.truncated && !untracked {
            let mut args = strings(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--no-relative",
                "--no-renames",
            ]);
            if side == GitDiffSide::Staged {
                args.push("--cached".into());
            }
            args.push("--".into());
            if let Some(old) = old_path {
                args.push(old.into());
            }
            args.push(path.into());
            self.fill_patch(&repo, args, &cancellation, &mut result)
                .await?;
        }
        if let Some(before) = disk_stamp {
            if before != disk_stamp_for(&repo, path)? {
                return Err(error(
                    "Working file changed while reading its diff. Refresh Git.",
                ));
            }
        }
        self.repo_for(context_id, &cancellation).await?;
        if self.status_for(&repo, &cancellation).await?.index_revision != expected_index_revision {
            return Err(error(
                "Git index changed while reading its diff. Refresh Git.",
            ));
        }
        Ok(result)
    }

    pub async fn history(
        &self,
        context_id: &str,
        query: GitHistoryQuery,
        cancellation: CancellationToken,
    ) -> Result<GitHistoryPage> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        if query.skip > 100_000 {
            return Err(error("History offset exceeds 100000 commits"));
        }
        let limit = query.limit.clamp(1, 100);
        let anchor = match query.anchor {
            Some(id) => Some(self.commit_oid(&repo, &id, &cancellation).await?),
            None => self.head(&repo, &cancellation).await?,
        };
        let Some(anchor_id) = anchor.as_deref() else {
            return Ok(GitHistoryPage {
                repository_id: repo.id,
                anchor,
                commits: vec![],
                next_skip: None,
            });
        };
        let mut args = strings(&["log", "-z", LOG_FORMAT]);
        args.push(format!("--skip={}", query.skip).into());
        args.push(format!("--max-count={}", limit + 1).into());
        args.push(anchor_id.into());
        args.push("--".into());
        if let Some(path) = query.path {
            relative_path(&path)?;
            args.push(path.into());
        }
        let output = self
            .checked(&repo, args, vec![], None, &cancellation)
            .await?;
        let mut commits = history::parse_history(&output.stdout)?;
        let next_skip = (commits.len() > limit as usize).then_some(query.skip + limit);
        commits.truncate(limit as usize);
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitHistoryPage {
            repository_id: repo.id,
            anchor,
            commits,
            next_skip,
        })
    }

    pub async fn commit_diff(
        &self,
        context_id: &str,
        commit_id: &str,
        path: Option<String>,
        cancellation: CancellationToken,
    ) -> Result<GitDiff> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        let id = self.commit_oid(&repo, commit_id, &cancellation).await?;
        let output = self
            .checked(
                &repo,
                strings(&["log", "-z", LOG_FORMAT, "-1", &id, "--"]),
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let commit = history::parse_history(&output.stdout)?
            .into_iter()
            .next()
            .ok_or_else(|| error("Commit is unavailable"))?;
        let parent = commit.parents.first().map(String::as_str);
        let mut old_path = None;
        if let Some(selected) = path.as_deref() {
            relative_path(selected)?;
            let mut names = strings(&[
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
            if let Some(parent) = parent {
                names.push(parent.into());
            }
            names.push(id.clone().into());
            names.push("--".into());
            let output = self
                .checked(&repo, names, vec![], None, &cancellation)
                .await?;
            let fields: Vec<_> = output.stdout.split(|byte| *byte == 0).collect();
            let mut at = 0;
            while at + 1 < fields.len() {
                let kind = fields[at];
                if kind.starts_with(b"R") || kind.starts_with(b"C") {
                    if at + 2 >= fields.len() {
                        return Err(error("Malformed historical rename metadata"));
                    }
                    if fields[at + 2] == selected.as_bytes() {
                        let previous = std::str::from_utf8(fields[at + 1])
                            .map_err(|_| error("Rename source is not valid UTF-8"))?;
                        relative_path(previous)?;
                        old_path = Some(previous.to_owned());
                    }
                    at += 3;
                } else {
                    at += 2;
                }
            }
        }
        let (old, new) = if let Some(path) = path.as_deref() {
            (
                self.tree_content(
                    &repo,
                    parent,
                    old_path.as_deref().unwrap_or(path),
                    &cancellation,
                )
                .await?,
                self.tree_content(&repo, Some(&id), path, &cancellation)
                    .await?,
            )
        } else {
            (Content::default(), Content::default())
        };
        let mut result = make_diff(
            &repo,
            path.as_deref().unwrap_or(""),
            old_path.clone(),
            GitDiffSide::Commit,
            String::new(),
            old,
            new,
        );
        result.commit_id = Some(id.clone());
        if !result.binary && !result.truncated {
            let mut args = strings(&[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-p",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--no-relative",
                "-r",
            ]);
            if let Some(parent) = parent {
                args.push(parent.into());
            }
            args.push(id.into());
            args.push("--".into());
            if let Some(old_path) = old_path {
                args.push(old_path.into());
            }
            if let Some(path) = path {
                args.push(path.into());
            }
            self.fill_patch(&repo, args, &cancellation, &mut result)
                .await?;
        }
        self.repo_for(context_id, &cancellation).await?;
        Ok(result)
    }

    async fn fill_patch(
        &self,
        repo: &RepoIdentity,
        args: Vec<OsString>,
        token: &CancellationToken,
        result: &mut GitDiff,
    ) -> Result<()> {
        match self.checked(repo, args, vec![], None, token).await {
            Ok(output) => match String::from_utf8(output.stdout) {
                Ok(patch) => result.patch = patch,
                Err(_) => {
                    result.binary = true;
                    result.summary = Some(
                        "Patch contains non-UTF-8 data. Use external Git for this diff.".into(),
                    );
                }
            },
            Err(reason) if reason.to_string().contains("output exceeded") => {
                result.truncated = true;
                result.summary = Some(
                    "Patch exceeds the 8 MiB output limit. Use external Git for the complete diff."
                        .into(),
                );
            }
            Err(reason) => return Err(reason),
        }
        Ok(())
    }

    async fn commit_oid(
        &self,
        repo: &RepoIdentity,
        id: &str,
        token: &CancellationToken,
    ) -> Result<String> {
        let id = object_id(id.as_bytes())?;
        let output = self
            .checked(repo, strings(&["cat-file", "-t", &id]), vec![], None, token)
            .await?;
        if output.stdout != b"commit\n" {
            return Err(error("Selected object is not a commit"));
        }
        Ok(id)
    }

    async fn tree_content(
        &self,
        repo: &RepoIdentity,
        revision: Option<&str>,
        path: &str,
        token: &CancellationToken,
    ) -> Result<Content> {
        let Some(revision) = revision else {
            return Ok(Content::default());
        };
        let id = object_id(revision.as_bytes())?;
        let output = self
            .checked(
                repo,
                strings(&["ls-tree", "-z", &id, "--", path]),
                vec![],
                None,
                token,
            )
            .await?;
        self.entry_content(repo, &output.stdout, path, false, token)
            .await
    }

    async fn index_content(
        &self,
        repo: &RepoIdentity,
        path: &str,
        token: &CancellationToken,
    ) -> Result<Content> {
        let output = self
            .checked(
                repo,
                strings(&["ls-files", "--stage", "-z", "--", path]),
                vec![],
                None,
                token,
            )
            .await?;
        self.entry_content(repo, &output.stdout, path, true, token)
            .await
    }

    async fn entry_content(
        &self,
        repo: &RepoIdentity,
        bytes: &[u8],
        path: &str,
        index: bool,
        token: &CancellationToken,
    ) -> Result<Content> {
        for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let tab = record
                .iter()
                .position(|b| *b == b'\t')
                .ok_or_else(|| error("Malformed Git file entry"))?;
            if &record[tab + 1..] != path.as_bytes() {
                continue;
            }
            let fields: Vec<_> = record[..tab].split(|b| *b == b' ').collect();
            if fields.len() != 3 {
                return Err(error("Malformed Git file metadata"));
            }
            if fields[0] == b"160000" || (!index && fields[1] != b"blob") {
                return Err(error(
                    "Submodules and directories require external Git diff",
                ));
            }
            if index && fields[2] != b"0" {
                return Err(error("Unmerged entries require external Git diff"));
            }
            let oid = object_id(fields[if index { 1 } else { 2 }])?;
            let size = self
                .checked(
                    repo,
                    strings(&["cat-file", "-s", &oid]),
                    vec![],
                    None,
                    token,
                )
                .await?;
            let size: usize = std::str::from_utf8(&size.stdout)
                .map_err(|_| error("Invalid Git blob size"))?
                .trim()
                .parse()
                .map_err(|_| error("Invalid Git blob size"))?;
            if size > TEXT_LIMIT {
                return Ok(Content {
                    large: true,
                    ..Content::default()
                });
            }
            let data = self
                .checked(
                    repo,
                    strings(&["cat-file", "blob", &oid]),
                    vec![],
                    None,
                    token,
                )
                .await?;
            return Ok(Content::bytes(data.stdout));
        }
        Ok(Content::default())
    }
}

fn make_diff(
    repo: &RepoIdentity,
    path: &str,
    old_path: Option<String>,
    side: GitDiffSide,
    index_revision: String,
    old: Content,
    new: Content,
) -> GitDiff {
    let binary = old.binary || new.binary;
    let truncated = old.large || new.large;
    GitDiff {
        repository_id: repo.id.clone(),
        path: path.into(),
        old_path,
        side,
        index_revision,
        old_text: old.text,
        new_text: new.text,
        patch: String::new(),
        binary,
        truncated,
        summary: if truncated {
            Some(
                "File exceeds the 1 MiB preview limit. Use external Git for the complete diff."
                    .into(),
            )
        } else if binary {
            Some("Binary or non-UTF-8 content. Use external Git for this diff.".into())
        } else {
            None
        },
        commit_id: None,
    }
}

pub(super) fn disk_stamp_for(repo: &RepoIdentity, path: &str) -> Result<String> {
    let full = repo.root.join(relative_path(path)?);
    let mut parent = full.parent().ok_or_else(|| error("Invalid file parent"))?;
    while !parent.exists() {
        parent = parent
            .parent()
            .ok_or_else(|| error("Invalid file parent"))?;
    }
    if !parent
        .canonicalize()
        .map_err(|e| error(format!("Resolve working file parent: {e}")))?
        .starts_with(&repo.root)
    {
        return Err(error("Working file parent escapes the repository"));
    }
    match fs::symlink_metadata(&full) {
        Ok(meta) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                Ok(format!(
                    "{}:{}:{}:{}:{}:{}:{}",
                    meta.dev(),
                    meta.ino(),
                    meta.len(),
                    meta.mtime(),
                    meta.mtime_nsec(),
                    meta.ctime(),
                    meta.ctime_nsec()
                ))
            }
            #[cfg(not(unix))]
            {
                Ok(format!(
                    "{}:{:?}:{:?}",
                    meta.len(),
                    meta.modified().ok(),
                    meta.file_type()
                ))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(e) => Err(error(format!("Read working file metadata: {e}"))),
    }
}
fn disk_content(repo: &RepoIdentity, path: &str) -> Result<(Content, String)> {
    let before = disk_stamp_for(repo, path)?;
    if before == "missing" {
        return Ok((Content::default(), before));
    }
    let full = repo.root.join(relative_path(path)?);
    let meta = fs::symlink_metadata(&full).map_err(|e| error(format!("Read working file: {e}")))?;
    let content = if meta.file_type().is_symlink() {
        Content::bytes(
            fs::read_link(&full)
                .map_err(|e| error(format!("Read symlink: {e}")))?
                .as_os_str()
                .as_encoded_bytes()
                .to_vec(),
        )
    } else if meta.is_file() {
        let file = open_working_file(repo, path)?;
        let mut bytes = Vec::new();
        file.take(TEXT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| error(format!("Read working file: {e}")))?;
        Content::bytes(bytes)
    } else {
        return Err(error("Only files and symlinks have diff previews"));
    };
    if before != disk_stamp_for(repo, path)? {
        return Err(error("Working file changed while reading. Refresh Git."));
    }
    Ok((content, before))
}

#[cfg(unix)]
pub(super) fn open_working_file(repo: &RepoIdentity, path: &str) -> Result<fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let relative = relative_path(path)?;
    let mut directory =
        fs::File::open(&repo.root).map_err(|e| error(format!("Open repository: {e}")))?;
    let components: Vec<_> = relative
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    for (position, component) in components.iter().enumerate() {
        let name = std::ffi::CString::new(component.as_encoded_bytes())
            .map_err(|_| error("Invalid working file path"))?;
        let last = position + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // Each descriptor is opened relative to a pinned directory without following symlinks.
        let raw = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if raw < 0 {
            return Err(error(format!(
                "Open working file safely: {}",
                std::io::Error::last_os_error()
            )));
        }
        // A successful openat returns a new owned descriptor.
        let descriptor = unsafe { OwnedFd::from_raw_fd(raw) };
        let file = fs::File::from(descriptor);
        if last {
            if !file
                .metadata()
                .map_err(|e| error(format!("Read file metadata: {e}")))?
                .is_file()
            {
                return Err(error("Working file changed type while reading"));
            }
            return Ok(file);
        }
        directory = file;
    }
    Err(error("Invalid working file path"))
}

#[cfg(not(unix))]
pub(super) fn open_working_file(repo: &RepoIdentity, path: &str) -> Result<fs::File> {
    let full = repo.root.join(relative_path(path)?);
    let canonical = full
        .canonicalize()
        .map_err(|e| error(format!("Resolve working file: {e}")))?;
    if !canonical.starts_with(&repo.root) {
        return Err(error("Working file escapes repository"));
    }
    fs::File::open(canonical).map_err(|e| error(format!("Open working file: {e}")))
}
