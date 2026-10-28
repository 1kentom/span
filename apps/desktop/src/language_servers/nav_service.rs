//! Navigation requests of the language server service. Every request follows the same
//! path as `lsp_definition`: wait for the queued edits, run against the server with the
//! request's cancellation token, and drop the reply when the document, the workspace or
//! the server epoch moved meanwhile.

use super::navigation::{self as nav, *};
use super::*;

/// Everything a server-scoped (not document-scoped) request needs.
pub struct ItemCall {
    manager: Manager,
    server: ServerId,
    root: PathBuf,
    workspace: PathBuf,
    token: CancellationToken,
}

struct ItemTarget {
    epoch: u64,
    generation: u64,
    workspace: PathBuf,
}

fn position_params(c: &Call, position: PositionDto) -> lsp::TextDocumentPositionParams {
    lsp::TextDocumentPositionParams::new(
        lsp::TextDocumentIdentifier::new(c.uri.clone()),
        position.into(),
    )
}

fn goto_params(c: &Call, position: PositionDto) -> lsp::GotoDefinitionParams {
    lsp::GotoDefinitionParams {
        text_document_position_params: position_params(c, position),
        work_done_progress_params: Default::default(),
        partial_result_params: Default::default(),
    }
}

impl LanguageServers {
    pub async fn references(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        include_declaration: bool,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::ReferenceParams {
                text_document_position: position_params(&c, position),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
                context: lsp::ReferenceContext {
                    include_declaration,
                },
            };
            let r = c
                .manager
                .references(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_locations(&c.workspace, r))
        })
        .await
    }

    pub async fn implementation(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = goto_params(&c, position);
            let r = c
                .manager
                .implementation(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(dto::map_definition(&c.workspace, r))
        })
        .await
    }

    pub async fn type_definition(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = goto_params(&c, position);
            let r = c
                .manager
                .type_definition(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(dto::map_definition(&c.workspace, r))
        })
        .await
    }

    pub async fn declaration(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<LocationDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = goto_params(&c, position);
            let r = c
                .manager
                .declaration(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(dto::map_definition(&c.workspace, r))
        })
        .await
    }

    pub async fn document_symbols(
        self: &Arc<Self>,
        path: &str,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<SymbolDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::DocumentSymbolParams {
                text_document: lsp::TextDocumentIdentifier::new(c.uri),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            };
            let r = c
                .manager
                .document_symbols(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_document_symbols(r))
        })
        .await
    }

    pub async fn document_highlights(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<DocumentHighlightDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::DocumentHighlightParams {
                text_document_position_params: position_params(&c, position),
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            };
            let r = c
                .manager
                .document_highlights(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_highlights(r))
        })
        .await
    }

    pub async fn signature_help(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Option<SignatureHelpDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::SignatureHelpParams {
                context: None,
                text_document_position_params: position_params(&c, position),
                work_done_progress_params: Default::default(),
            };
            let r = c
                .manager
                .signature_help(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_signature_help(r))
        })
        .await
    }

    pub async fn prepare_rename(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Option<PrepareRenameDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = position_params(&c, position);
            let r = c
                .manager
                .prepare_rename(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_prepare_rename(r))
        })
        .await
    }

    /// The edit a rename would make, as data. Never touches a buffer or a file.
    pub async fn rename(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        new_name: String,
        request_id: Option<String>,
    ) -> Result<LspResponse<WorkspaceEditDto>, LspErrorDto> {
        if new_name.trim().is_empty() || new_name.contains(['\n', '\r', '\0']) {
            return Err(LspErrorDto::other("invalid new name"));
        }
        self.request(path, request_id, |c| async move {
            let params = lsp::RenameParams {
                text_document_position: position_params(&c, position),
                new_name,
                work_done_progress_params: Default::default(),
            };
            let r = c
                .manager
                .rename(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_workspace_edit(&c.workspace, r))
        })
        .await
    }

    pub async fn call_hierarchy_prepare(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<CallHierarchyItemDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::CallHierarchyPrepareParams {
                text_document_position_params: position_params(&c, position),
                work_done_progress_params: Default::default(),
            };
            let r = c
                .manager
                .prepare_call_hierarchy(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(r.unwrap_or_default()
                .into_iter()
                .map(|i| nav::map_call_item(&c.workspace, c.server, &c.root, i))
                .collect())
        })
        .await
    }

    pub async fn type_hierarchy_prepare(
        self: &Arc<Self>,
        path: &str,
        position: PositionDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
        self.request(path, request_id, |c| async move {
            let params = lsp::TypeHierarchyPrepareParams {
                text_document_position_params: position_params(&c, position),
                work_done_progress_params: Default::default(),
            };
            let r = c
                .manager
                .prepare_type_hierarchy(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(r.unwrap_or_default()
                .into_iter()
                .map(|i| nav::map_type_item(&c.workspace, c.server, &c.root, i))
                .collect())
        })
        .await
    }

    pub async fn call_hierarchy_incoming(
        self: &Arc<Self>,
        item: &CallHierarchyItemDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<IncomingCallDto>>, LspErrorDto> {
        let decoded = nav::decode_token(&item.token, nav::CALL_KIND)?;
        let raw: lsp::CallHierarchyItem = serde_json::from_value(decoded.item)
            .map_err(|_| LspErrorDto::other("invalid hierarchy item token"))?;
        self.item_request(decoded.server, decoded.root, request_id, |c| async move {
            let params = lsp::CallHierarchyIncomingCallsParams {
                item: raw,
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            };
            let r = c
                .manager
                .incoming_calls(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_incoming(&c.workspace, c.server, &c.root, r))
        })
        .await
    }

    pub async fn call_hierarchy_outgoing(
        self: &Arc<Self>,
        item: &CallHierarchyItemDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<OutgoingCallDto>>, LspErrorDto> {
        let decoded = nav::decode_token(&item.token, nav::CALL_KIND)?;
        let raw: lsp::CallHierarchyItem = serde_json::from_value(decoded.item)
            .map_err(|_| LspErrorDto::other("invalid hierarchy item token"))?;
        self.item_request(decoded.server, decoded.root, request_id, |c| async move {
            let params = lsp::CallHierarchyOutgoingCallsParams {
                item: raw,
                work_done_progress_params: Default::default(),
                partial_result_params: Default::default(),
            };
            let r = c
                .manager
                .outgoing_calls(c.server, &c.root, params, Some(c.token))
                .await?;
            Ok(nav::map_outgoing(&c.workspace, c.server, &c.root, r))
        })
        .await
    }

    pub async fn type_hierarchy_supertypes(
        self: &Arc<Self>,
        item: &TypeHierarchyItemDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
        self.type_hierarchy_step(item, request_id, true).await
    }

    pub async fn type_hierarchy_subtypes(
        self: &Arc<Self>,
        item: &TypeHierarchyItemDto,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
        self.type_hierarchy_step(item, request_id, false).await
    }

    async fn type_hierarchy_step(
        self: &Arc<Self>,
        item: &TypeHierarchyItemDto,
        request_id: Option<String>,
        supertypes: bool,
    ) -> Result<LspResponse<Vec<TypeHierarchyItemDto>>, LspErrorDto> {
        let decoded = nav::decode_token(&item.token, nav::TYPE_KIND)?;
        let raw: lsp::TypeHierarchyItem = serde_json::from_value(decoded.item)
            .map_err(|_| LspErrorDto::other("invalid hierarchy item token"))?;
        self.item_request(decoded.server, decoded.root, request_id, |c| async move {
            let r = if supertypes {
                let params = lsp::TypeHierarchySupertypesParams {
                    item: raw,
                    work_done_progress_params: Default::default(),
                    partial_result_params: Default::default(),
                };
                c.manager
                    .type_supertypes(c.server, &c.root, params, Some(c.token))
                    .await?
            } else {
                let params = lsp::TypeHierarchySubtypesParams {
                    item: raw,
                    work_done_progress_params: Default::default(),
                    partial_result_params: Default::default(),
                };
                c.manager
                    .type_subtypes(c.server, &c.root, params, Some(c.token))
                    .await?
            };
            Ok(r.unwrap_or_default()
                .into_iter()
                .map(|i| nav::map_type_item(&c.workspace, c.server, &c.root, i))
                .collect())
        })
        .await
    }

    /// Workspace symbols. With a `path_hint` the server of that (open) file answers;
    /// without one every ready server is asked and the results are merged and capped.
    pub async fn workspace_symbols(
        self: &Arc<Self>,
        query: String,
        path_hint: Option<String>,
        request_id: Option<String>,
    ) -> Result<LspResponse<Vec<WorkspaceSymbolDto>>, LspErrorDto> {
        let params = move || lsp::WorkspaceSymbolParams {
            query: query.clone(),
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        if let Some(hint) = path_hint {
            let params = params();
            return self
                .request(&hint, request_id, |c| async move {
                    let r = c
                        .manager
                        .workspace_symbols(c.server, &c.root, params, Some(c.token))
                        .await?;
                    let mut out = nav::map_workspace_symbols(&c.workspace, r);
                    out.truncate(nav::MAX_WORKSPACE_SYMBOLS);
                    Ok(out)
                })
                .await;
        }

        let guard = self.begin_request(request_id)?;
        let (workspace, generation, targets) = {
            let st = lock(&self.state);
            let workspace = st
                .root
                .clone()
                .ok_or_else(|| LspErrorDto::other("open a folder first"))?;
            let mut targets: Vec<(ServerId, PathBuf, u64)> = st
                .states
                .iter()
                .filter(|((server, _), state)| {
                    **state == LanguageServerStateDto::Ready
                        && !st.settings.disabled.contains(server)
                        && !st.gates.contains_key(server)
                })
                .map(|((server, root), _)| (*server, root.clone(), Self::epoch(&st, *server)))
                .collect();
            targets.sort();
            (workspace, st.generation, targets)
        };
        if targets.is_empty() {
            return Err(LspErrorDto::NotReady {
                message: "no language server is running".into(),
            });
        }
        let mut set = tokio::task::JoinSet::new();
        for (index, (server, root, _)) in targets.iter().cloned().enumerate() {
            let manager = self.manager.clone();
            let token = guard.token.clone();
            let params = params();
            set.spawn(async move {
                (
                    index,
                    manager
                        .workspace_symbols(server, &root, params, Some(token))
                        .await,
                )
            });
        }
        let timeout = self.request_timeout;
        let gather = async {
            let mut results = Vec::new();
            while let Some(joined) = set.join_next().await {
                if let Ok(result) = joined {
                    results.push(result);
                }
            }
            results
        };
        let mut results = tokio::select! {
            _ = guard.token.cancelled() => return Err(LspErrorDto::Cancelled),
            r = tokio::time::timeout(timeout, gather) => match r {
                Ok(results) => results,
                Err(_) => {
                    guard.token.cancel();
                    return Err(LspErrorDto::NotReady {
                        message: "the language server did not answer in time".into(),
                    });
                }
            },
        };
        results.sort_by_key(|(index, _)| *index);
        let mut lists = Vec::new();
        let mut first_error: Option<LspErrorDto> = None;
        for (_, result) in results {
            match result {
                Ok(r) => lists.push(nav::map_workspace_symbols(&workspace, r)),
                Err(e) => {
                    first_error.get_or_insert(e.into());
                }
            }
        }
        // Partial answers are fine; only a total failure is an error.
        if lists.is_empty() {
            return Err(first_error.unwrap_or(LspErrorDto::Unsupported {
                message: "no language server supports workspace symbols".into(),
            }));
        }
        if guard.token.is_cancelled() {
            return Err(LspErrorDto::Cancelled);
        }
        let epoch = {
            let st = lock(&self.state);
            if st.generation != generation
                || targets
                    .iter()
                    .any(|(server, _, epoch)| Self::epoch(&st, *server) != *epoch)
            {
                return Err(LspErrorDto::Stale);
            }
            targets.iter().map(|t| t.2).max().unwrap_or(0)
        };
        Ok(LspResponse {
            revision: 0,
            epoch,
            data: nav::merge_workspace_symbols(lists),
        })
    }

    /// Run a request that belongs to a server rather than to an open document. The reply
    /// is stamped with revision 0 and dropped when the workspace or server epoch moved.
    async fn item_request<T, F, Fut>(
        self: &Arc<Self>,
        server: ServerId,
        root: PathBuf,
        request_id: Option<String>,
        call: F,
    ) -> Result<LspResponse<T>, LspErrorDto>
    where
        F: FnOnce(ItemCall) -> Fut,
        Fut: Future<Output = Result<T, ManagerError>>,
    {
        let guard = self.begin_request(request_id)?;
        let target = {
            let st = lock(&self.state);
            let workspace = st
                .root
                .clone()
                .ok_or_else(|| LspErrorDto::other("open a folder first"))?;
            if st.settings.disabled.contains(&server) {
                return Err(LspErrorDto::Unsupported {
                    message: "this language server is disabled in settings".into(),
                });
            }
            if let Some(gate) = st.gates.get(&server) {
                return Err(self.gate_error(gate, server));
            }
            // Only roots this service started: a token cannot aim a request elsewhere.
            if !st.states.contains_key(&(server, root.clone())) {
                return Err(LspErrorDto::NotReady {
                    message: "language server is not running".into(),
                });
            }
            ItemTarget {
                epoch: Self::epoch(&st, server),
                generation: st.generation,
                workspace,
            }
        };
        let call = call(ItemCall {
            manager: self.manager.clone(),
            server,
            root,
            workspace: target.workspace.clone(),
            token: guard.token.clone(),
        });
        tokio::pin!(call);
        let outcome = tokio::select! {
            _ = guard.token.cancelled() => {
                cancel_grace(call).await;
                return Err(LspErrorDto::Cancelled);
            }
            r = tokio::time::timeout(self.request_timeout, &mut call) => r,
        };
        let data = match outcome {
            Ok(result) => result.map_err(LspErrorDto::from)?,
            Err(_) => {
                guard.token.cancel();
                return Err(LspErrorDto::NotReady {
                    message: "the language server did not answer in time".into(),
                });
            }
        };
        if guard.token.is_cancelled() {
            return Err(LspErrorDto::Cancelled);
        }
        let st = lock(&self.state);
        if st.generation != target.generation || Self::epoch(&st, server) != target.epoch {
            return Err(LspErrorDto::Stale);
        }
        Ok(LspResponse {
            revision: 0,
            epoch: target.epoch,
            data,
        })
    }

    /// A read-only excerpt around `location.range`, for peek and hover previews and for
    /// viewing library source. Files are read straight from disk (or from the open buffer
    /// for workspace files); nothing is opened in a language server. `jdt:` class files
    /// are fetched from JDT LS with `java/classFileContents`.
    pub async fn read_source(
        self: &Arc<Self>,
        location: LocationDto,
        context_lines: u32,
    ) -> Result<SourceSnippetDto, LspErrorDto> {
        let workspace = lock(&self.state)
            .root
            .clone()
            .ok_or_else(|| LspErrorDto::other("open a folder first"))?;
        let resolve_in = workspace.clone();
        let resolve_location = location.clone();
        let resolved = tokio::task::spawn_blocking(move || {
            nav::resolve_source(&resolve_in, &resolve_location)
        })
        .await
        .map_err(|e| LspErrorDto::other(e.to_string()))??;

        let (text, language, path, display, external) = match resolved {
            nav::ResolvedSource::File { path, external } => {
                let language = catalog::language_id_for_path(&path)
                    .unwrap_or("plaintext")
                    .to_owned();
                let open_text = if external {
                    None
                } else {
                    let st = lock(&self.state);
                    st.docs
                        .get(&absolute(&workspace, &location.path))
                        .map(|d| d.text.clone())
                };
                let text = match open_text {
                    Some(text) => nav::check_text(text.into_bytes())?,
                    None => {
                        let read = path.clone();
                        tokio::task::spawn_blocking(move || nav::read_text_file(&read))
                            .await
                            .map_err(|e| LspErrorDto::other(e.to_string()))??
                    }
                };
                let shown = if external {
                    location.path.clone()
                } else {
                    display_path(&workspace, &path)
                };
                let display = if external && location.display_path.is_empty() {
                    shown.clone()
                } else if external {
                    location.display_path.clone()
                } else {
                    shown.clone()
                };
                (text, language, shown, display, external)
            }
            nav::ResolvedSource::Jdt(uri) => {
                let root = {
                    let st = lock(&self.state);
                    st.states
                        .iter()
                        .filter(|((server, _), state)| {
                            *server == ServerId::Jdtls && **state == LanguageServerStateDto::Ready
                        })
                        .map(|((_, root), _)| root.clone())
                        .min()
                };
                let root = root.ok_or_else(|| LspErrorDto::NotReady {
                    message: "the Java language server is not running".into(),
                })?;
                let token = CancellationToken::new();
                let fetched = tokio::time::timeout(
                    self.request_timeout,
                    self.manager.class_file_contents(
                        ServerId::Jdtls,
                        &root,
                        &uri,
                        Some(token.clone()),
                    ),
                )
                .await
                .map_err(|_| {
                    token.cancel();
                    LspErrorDto::NotReady {
                        message: "the language server did not answer in time".into(),
                    }
                })??;
                let text = nav::check_text(
                    fetched
                        .ok_or_else(|| LspErrorDto::other("no source available"))?
                        .into_bytes(),
                )?;
                let display = if location.display_path.is_empty() {
                    uri.clone()
                } else {
                    location.display_path.clone()
                };
                (text, "java".to_owned(), uri, display, true)
            }
        };
        let (start_line, body, highlight_range) =
            nav::snippet(&text, location.range, context_lines)?;
        Ok(SourceSnippetDto {
            path,
            display_path: display,
            language,
            start_line,
            text: body,
            highlight_range,
            external,
            read_only: external,
        })
    }
}
