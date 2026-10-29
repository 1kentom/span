//! Narrow editor tool capability. It can read and propose, never decide or Save.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

pub const EDITOR_TOOL_MAX_BYTES: usize = 512 * 1024;
const MAX_READS: usize = 64;
const MAX_PENDING: usize = 8;

/// Explicit host consent for one review chat. The host checks current workspace
/// identity and trust without granting trust or changing ordinary agent sessions.
#[derive(Clone)]
pub struct EditorToolAccess {
    active: Arc<AtomicBool>,
    allowed: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl EditorToolAccess {
    pub fn new(allowed: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self {
            active: Arc::new(AtomicBool::new(true)),
            allowed,
        }
    }
    pub fn allowed(&self) -> bool {
        self.active.load(Ordering::Acquire) && (self.allowed)()
    }
    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.active, &other.active)
    }
}

impl std::fmt::Debug for EditorToolAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EditorToolAccess").finish_non_exhaustive()
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorRead {
    pub path: String,
    pub text: String,
    pub revision: u64,
    pub read_token: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorEdit {
    pub status: &'static str,
    pub revision: u64,
}

/// Bound to one service/session by trusted native code, not an MCP argument.
pub struct EditorTools {
    service: AgentService,
    session: String,
    access: EditorToolAccess,
    reads: Mutex<HashMap<String, (String, u64)>>,
}

impl EditorTools {
    pub fn enabled(&self) -> bool {
        self.access.allowed()
    }

    pub fn read_buffer(&self, path: &str) -> Result<EditorRead, String> {
        let mut bridge = self
            .service
            .state
            .lock()
            .map_err(|_| "Agent state lock poisoned")?;
        check_session(&bridge, &self.session)?;
        if !self.access.allowed() {
            return Err("Editor tools consent or workspace trust was revoked".into());
        }
        let snapshot = self
            .service
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned")?
            .agent_read_existing_bounded(path, EDITOR_TOOL_MAX_BYTES)
            .map_err(|e| e.to_string())?;
        let mut reads = self
            .reads
            .lock()
            .map_err(|_| "Editor read tokens unavailable")?;
        reads.retain(|_, (path, _)| path != &snapshot.path);
        if reads.len() >= MAX_READS {
            return Err("Too many outstanding editor reads".into());
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "Editor token randomness unavailable")?;
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        reads.insert(token.clone(), (snapshot.path.clone(), snapshot.revision));
        bridge.revisions.insert(
            (self.session.clone(), snapshot.path.clone()),
            snapshot.revision,
        );
        Ok(EditorRead {
            path: snapshot.path,
            text: snapshot.text,
            revision: snapshot.revision,
            read_token: token,
        })
    }

    pub async fn propose_edit(
        &self,
        path: &str,
        content: String,
        revision: u64,
        token: &str,
    ) -> Result<EditorEdit, String> {
        if content.len() > EDITOR_TOOL_MAX_BYTES || content.contains('\0') {
            return Err("Editor proposal exceeds the text limit or contains binary data".into());
        }
        let expected = self
            .reads
            .lock()
            .map_err(|_| "Editor read tokens unavailable")?
            .remove(token)
            .ok_or("Unknown, expired or already consumed editor read token")?;
        // The normalized path returned by read_buffer is mandatory. This binds
        // aliases, revision and token without accepting a caller session id.
        if expected != (path.to_owned(), revision) {
            return Err("Editor read token does not match the path and revision".into());
        }
        propose(
            &self.service.state,
            &self.service.workspace,
            &self.service.emit,
            &self.session,
            path,
            content,
            Some((revision, self.access.clone())),
        )
        .await
    }

    /// Serialized with user review so a revoked grant cannot apply later.
    pub fn revoke(&self) {
        let mut discarded = Vec::new();
        if let Ok(mut bridge) = self.service.state.lock() {
            self.access.active.store(false, Ordering::Release);
            let ids: Vec<_> = bridge
                .proposals
                .iter()
                .filter(|(_, p)| p.access.as_ref().is_some_and(|a| a.same(&self.access)))
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(proposal) = discard(&mut bridge, &self.service.workspace, &id) {
                    discarded.push((id, proposal));
                }
            }
        }
        for (id, proposal) in discarded {
            notify_discarded(id, proposal, &self.service.emit);
        }
        if let Ok(mut reads) = self.reads.lock() {
            reads.clear();
        }
    }
}

impl Drop for EditorTools {
    fn drop(&mut self) {
        self.revoke();
    }
}

impl AgentService {
    pub(crate) fn editor_tools(
        &self,
        session: &str,
        access: EditorToolAccess,
    ) -> Result<EditorTools, String> {
        let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
        check_session(&bridge, session)?;
        if !bridge.review_sessions.contains(session) || !access.allowed() {
            return Err("Editor tools require an explicitly authorized review-only session".into());
        }
        Ok(EditorTools {
            service: self.clone(),
            session: session.into(),
            access,
            reads: Mutex::new(HashMap::new()),
        })
    }
}

fn check_session(bridge: &Bridge, session: &str) -> Result<(), String> {
    if bridge.closed || !bridge.sessions.contains(session) || bridge.cancelled.contains(session) {
        Err("Unknown or cancelled editor session".into())
    } else {
        Ok(())
    }
}

pub(super) fn read(
    state: &Arc<Mutex<Bridge>>,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    session: &str,
    path: &str,
) -> Result<span_core::BufferSnapshot, String> {
    let mut bridge = state.lock().map_err(|_| "Agent state lock poisoned")?;
    check_session(&bridge, session)?;
    let snapshot = workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned")?
        .agent_read(path)
        .map_err(|e| e.to_string())?;
    bridge
        .revisions
        .insert((session.into(), snapshot.path.clone()), snapshot.revision);
    Ok(snapshot)
}

pub(super) fn discard(
    bridge: &mut Bridge,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    id: &str,
) -> Option<Proposal> {
    let proposal = bridge.proposals.remove(id)?;
    if let Ok(mut workspace) = workspace.lock() {
        if let Ok(snapshot) = workspace.agent_read(&proposal.path) {
            let _ = workspace.resolve_proposal(id, false, snapshot.revision);
        }
    }
    Some(proposal)
}

pub(super) fn notify_discarded(id: String, proposal: Proposal, emit: &EventSink) {
    emit(AgentEvent::ProposalResolved {
        session_id: proposal.session,
        proposal_id: id,
        accepted: false,
    });
    let _ = proposal.reply.send(ReviewDecision::default());
}

struct Pending {
    state: Arc<Mutex<Bridge>>,
    workspace: Arc<Mutex<CoreWorkspace>>,
    id: String,
    emit: EventSink,
}
impl Drop for Pending {
    fn drop(&mut self) {
        let discarded = self
            .state
            .lock()
            .ok()
            .and_then(|mut bridge| discard(&mut bridge, &self.workspace, &self.id));
        if let Some(proposal) = discarded {
            notify_discarded(self.id.clone(), proposal, &self.emit);
        }
    }
}

pub(super) async fn propose(
    state: &Arc<Mutex<Bridge>>,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    emit: &EventSink,
    session: &str,
    path: &str,
    content: String,
    guard: Option<(u64, EditorToolAccess)>,
) -> Result<EditorEdit, String> {
    let staged = {
        let mut bridge = state.lock().map_err(|_| "Agent state lock poisoned")?;
        check_session(&bridge, session)?;
        if let Some((_, access)) = &guard {
            if !access.allowed() {
                return Err("Editor tools consent or workspace trust was revoked".into());
            }
            if bridge
                .proposals
                .values()
                .filter(|p| p.session == session)
                .count()
                >= MAX_PENDING
            {
                return Err("Too many pending editor proposals".into());
            }
        }
        let mut workspace = workspace.lock().map_err(|_| "Workspace lock poisoned")?;
        let snapshot = if guard.is_some() {
            workspace.agent_read_existing_bounded(path, EDITOR_TOOL_MAX_BYTES)
        } else {
            workspace.agent_read(path)
        }
        .map_err(|e| e.to_string())?;
        let revision = guard
            .as_ref()
            .map(|(revision, _)| *revision)
            .or_else(|| {
                bridge
                    .revisions
                    .get(&(session.into(), snapshot.path.clone()))
                    .copied()
            })
            .unwrap_or(snapshot.revision);
        let proposal = workspace
            .stage_proposal(&snapshot.path, revision, content)
            .map_err(|e| e.to_string())?;
        if proposal.hunks.is_empty() {
            workspace
                .resolve_proposal(&proposal.id, false, snapshot.revision)
                .map_err(|e| e.to_string())?;
            return Ok(EditorEdit {
                status: "already_matches",
                revision: snapshot.revision,
            });
        }
        let (tx, rx) = oneshot::channel();
        bridge.proposals.insert(
            proposal.id.clone(),
            Proposal {
                session: session.into(),
                path: proposal.path.clone(),
                hunk_ids: proposal.hunks.iter().map(|h| h.id.clone()).collect(),
                reply: tx,
                access: guard.map(|(_, a)| a),
            },
        );
        (proposal, rx)
    };
    let (proposal, decision) = staged;
    let id = proposal.id.clone();
    let _pending = Pending {
        state: state.clone(),
        workspace: workspace.clone(),
        id: id.clone(),
        emit: emit.clone(),
    };
    emit(AgentEvent::Proposal {
        session_id: session.into(),
        proposal,
    });
    let decision = decision.await.unwrap_or_default();
    if decision.complete {
        Ok(EditorEdit {
            status: "accepted_in_buffer",
            revision: decision.revision,
        })
    } else if decision.applied {
        Err("Only selected edit hunks were accepted. Other changes were rejected. Read the editor buffer again before continuing.".into())
    } else {
        Err("User rejected or cancelled the proposed editor edit".into())
    }
}
