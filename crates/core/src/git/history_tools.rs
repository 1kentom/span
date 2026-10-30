use super::*;

const FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b";

fn page_bounds(skip: u32, limit: u32) -> Result<u32> {
    if skip > 100_000 {
        return Err(error("History offset exceeds 100000"));
    }
    Ok(limit.clamp(1, 100))
}
fn search_literal(value: &str) -> Result<()> {
    if value.len() > 1024 || value.contains(['\0', '\n', '\r']) {
        return Err(error(
            "History search must be a single literal line of at most 1024 bytes",
        ));
    }
    Ok(())
}

impl GitService {
    /// Heads are immutable OIDs. Subsequent pages must reuse the returned heads.
    /// Parent IDs come directly from Git, including parents outside this page.
    pub async fn history_tools(
        &self,
        context_id: &str,
        query: GitHistoryToolsQuery,
        cancellation: CancellationToken,
    ) -> Result<GitHistoryToolsPage> {
        let limit = page_bounds(query.skip, query.limit)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let output = self.checked(&repo, strings(&["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)"]), vec![], None, &cancellation).await?;
        let mut refs = Vec::new();
        for line in output
            .stdout
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
        {
            let fields: Vec<_> = line.split(|b| *b == 0).collect();
            if fields.len() != 5 {
                return Err(error("Malformed reference decorations"));
            }
            // Span checkpoint and pull refs are private implementation storage.
            // Filter before collecting decorations or deriving default graph heads.
            if fields[0].starts_with(b"refs/span/") {
                continue;
            }
            if refs.len() >= 4096 {
                return Err(error("History has too many reference heads"));
            }
            let commit_id = if fields[3] == b"commit" {
                object_id(fields[1])?
            } else if fields[4] == b"commit" {
                object_id(fields[2])?
            } else if fields[3] == b"tag" {
                let tag = object_id(fields[1])?;
                let peeled = self
                    .run_repo(
                        &repo,
                        vec![
                            "rev-parse".into(),
                            "--verify".into(),
                            format!("{tag}^{{commit}}").into(),
                        ],
                        vec![],
                        None,
                        &cancellation,
                    )
                    .await?;
                if !peeled.success {
                    continue;
                }
                object_id(peeled.stdout.strip_suffix(b"\n").unwrap_or(&peeled.stdout))?
            } else {
                continue;
            };
            refs.push(GitHistoryDecoration {
                name: String::from_utf8_lossy(fields[0]).into_owned(),
                commit_id,
            });
        }
        let mut heads = query.heads;
        if heads.is_empty() {
            heads.extend(refs.iter().map(|entry| entry.commit_id.clone()));
            if let Some(head) = self.head(&repo, &cancellation).await? {
                heads.push(head);
            }
            heads.sort();
            heads.dedup();
        }
        if heads.len() > 4096 {
            return Err(error("History has too many reference heads"));
        }
        for head in &mut heads {
            *head = self.commit_oid(&repo, head, &cancellation).await?;
        }
        if heads.is_empty() {
            return Ok(GitHistoryToolsPage {
                heads,
                refs,
                commits: vec![],
                next_skip: None,
            });
        }
        let mut args = strings(&[
            "log",
            "--topo-order",
            "--full-history",
            "-z",
            FORMAT,
            "--fixed-strings",
        ]);
        args.push(format!("--skip={}", query.skip).into());
        args.push(format!("--max-count={}", limit + 1).into());
        if let Some(author) = query.author {
            search_literal(&author)?;
            args.push(format!("--author={author}").into());
        }
        if let Some(message) = query.message {
            search_literal(&message)?;
            args.push(format!("--grep={message}").into());
        }
        args.extend(heads.iter().map(OsString::from));
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
        Ok(GitHistoryToolsPage {
            heads,
            refs,
            commits,
            next_skip,
        })
    }

    pub async fn revision_content(
        &self,
        context_id: &str,
        revision: &str,
        path: &str,
        cancellation: CancellationToken,
    ) -> Result<GitRevisionContent> {
        relative_path(path)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let revision = self.commit_oid(&repo, revision, &cancellation).await?;
        // A validated OID and colon anchor the object expression; path is never an option.
        let output = self
            .checked(
                &repo,
                vec!["show".into(), format!("{revision}:{path}").into()],
                vec![],
                None,
                &cancellation,
            )
            .await?;
        let truncated = output.stdout.len() > TEXT_LIMIT;
        let binary = output.stdout.contains(&0) || std::str::from_utf8(&output.stdout).is_err();
        let text = if binary || truncated {
            None
        } else {
            String::from_utf8(output.stdout).ok()
        };
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitRevisionContent {
            revision,
            path: path.into(),
            text,
            binary,
            truncated,
        })
    }

    pub async fn revision_diff(
        &self,
        context_id: &str,
        from: &str,
        to: Option<&str>,
        path: Option<&str>,
        cancellation: CancellationToken,
    ) -> Result<GitRevisionDiff> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        let from = self.commit_oid(&repo, from, &cancellation).await?;
        let to = match to {
            Some(id) => Some(self.commit_oid(&repo, id, &cancellation).await?),
            None => None,
        };
        let mut args = strings(&["diff", "--no-ext-diff", "--no-textconv", "--no-color"]);
        args.push(from.clone().into());
        if let Some(to) = &to {
            args.push(to.into());
        }
        args.push("--".into());
        if let Some(path) = path {
            relative_path(path)?;
            args.push(path.into());
        }
        let output = self
            .checked(&repo, args, vec![], None, &cancellation)
            .await?;
        let truncated = output.stdout.len() > TEXT_LIMIT;
        let patch = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(TEXT_LIMIT)])
            .into_owned();
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitRevisionDiff {
            from,
            to,
            path: path.map(str::to_owned),
            patch,
            truncated,
        })
    }

    pub async fn reflog_page(
        &self,
        context_id: &str,
        skip: u32,
        limit: u32,
        cancellation: CancellationToken,
    ) -> Result<GitReflogPage> {
        let limit = page_bounds(skip, limit)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let args = vec![
            "reflog".into(),
            "show".into(),
            "-z".into(),
            "--format=%H%x00%gD%x00%gs".into(),
            format!("--skip={skip}").into(),
            format!("--max-count={}", limit + 1).into(),
            "HEAD".into(),
            "--".into(),
        ];
        let output = self
            .checked(&repo, args, vec![], None, &cancellation)
            .await?;
        let fields: Vec<_> = output.stdout.split(|b| *b == 0).collect();
        let mut entries = Vec::new();
        for row in fields.chunks(3) {
            if row.len() == 1 && row[0].is_empty() {
                break;
            }
            if row.len() != 3 {
                return Err(error("Malformed reflog record"));
            }
            entries.push(GitReflogEntry {
                commit_id: object_id(row[0])?,
                selector: String::from_utf8_lossy(row[1]).into_owned(),
                subject: String::from_utf8_lossy(row[2]).into_owned(),
            });
        }
        let next_skip = (entries.len() > limit as usize).then_some(skip + limit);
        entries.truncate(limit as usize);
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitReflogPage { entries, next_skip })
    }

    /// Numeric ranges only. Git's -L accepts one revision and no pathspecs.
    #[allow(clippy::too_many_arguments)]
    pub async fn line_history(
        &self,
        context_id: &str,
        revision: &str,
        path: &str,
        start: u32,
        end: u32,
        skip: u32,
        limit: u32,
        cancellation: CancellationToken,
    ) -> Result<GitHistoryPage> {
        relative_path(path)?;
        if path.contains([':', '\n', '\r']) {
            return Err(error(
                "Line history does not support paths containing colon or newline",
            ));
        }
        if start == 0 || end < start || end > 10_000_000 {
            return Err(error(
                "Line history requires a valid numeric range from 1 to 10000000",
            ));
        }
        let limit = page_bounds(skip, limit)?;
        let repo = self.repo_for(context_id, &cancellation).await?;
        let revision = self.commit_oid(&repo, revision, &cancellation).await?;
        let args = vec![
            "log".into(),
            "--no-patch".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "-z".into(),
            FORMAT.into(),
            format!("-L{start},{end}:{path}").into(),
            format!("--skip={skip}").into(),
            format!("--max-count={}", limit + 1).into(),
            revision.clone().into(),
        ];
        let output = self
            .checked(&repo, args, vec![], None, &cancellation)
            .await?;
        let mut commits = history::parse_history(&output.stdout)?;
        let next_skip = (commits.len() > limit as usize).then_some(skip + limit);
        commits.truncate(limit as usize);
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitHistoryPage {
            repository_id: repo.id,
            anchor: Some(revision),
            commits,
            next_skip,
        })
    }

    /// Reads policy only. Signing keys and credential helper settings are not returned.
    pub async fn signing_configuration(
        &self,
        context_id: &str,
        cancellation: CancellationToken,
    ) -> Result<GitSigningConfiguration> {
        let repo = self.repo_for(context_id, &cancellation).await?;
        let mut values = Vec::new();
        for key in ["gpg.format", "commit.gpgsign", "tag.gpgsign"] {
            let output = self
                .run_repo(
                    &repo,
                    strings(&["config", "--get", key]),
                    vec![],
                    None,
                    &cancellation,
                )
                .await?;
            if output.success {
                values.push(Some(
                    String::from_utf8_lossy(&output.stdout).trim().to_owned(),
                ));
            } else if output.code == Some(1) {
                values.push(None);
            } else {
                require_success(&output)?;
                values.push(None);
            }
        }
        self.repo_for(context_id, &cancellation).await?;
        Ok(GitSigningConfiguration {
            format: values.remove(0),
            commit_signing: values.remove(0),
            tag_signing: values.remove(0),
        })
    }
}
