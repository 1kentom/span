//! At most two live-provider turns in an owned temporary workspace.
//! Usage: cargo run --release -p span-acp --example provider_turn_smoke -- INSTALLED_MANIFEST [--allow-current-sonnet]
//! Prefers advertised Sonnet 4.5; an explicitly allowed fallback must be the current Sonnet.
//! Never reads authentication files or prints protocol, credentials or account details.
use serde_json::Value;
use span_acp::{AgentEvent, AgentService, ConfigOption, InstalledAgent, ToolLocation};
use span_core::CoreWorkspace;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::{
    sync::mpsc,
    time::{Duration, Instant},
};

const ORIGINAL: &str = "hello\n";
const REJECTED: &str = "hello rejected\n";
const ACCEPTED: &str = "hello span\n";
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
struct ReplyExcerpt {
    text: String,
    truncated: bool,
}

impl ReplyExcerpt {
    fn push(&mut self, text: &str) {
        const LIMIT: usize = 8192;
        let remaining = LIMIT.saturating_sub(self.text.chars().count());
        self.text.extend(text.chars().take(remaining));
        self.truncated |= text.chars().count() > remaining;
    }

    fn redacted(&self, path: &Path) -> String {
        let mut text = self.text.clone();
        if self.truncated {
            // Discard a cut-off token, which might contain an incomplete path.
            text.truncate(text.rfind(char::is_whitespace).unwrap_or(0));
        }
        if let Some(root) = path.parent().and_then(Path::to_str) {
            text = text.replace(root, "<owned-workspace>");
            if let Some(alias) = root.strip_prefix("/private") {
                text = text.replace(alias, "<owned-workspace>");
            }
        }
        let mut excerpt: String = text.chars().take(2048).collect();
        if self.truncated || text.chars().count() > 2048 {
            excerpt.push_str(" [reply truncated]");
        }
        format!("{excerpt:?}")
    }
}

struct SelectedModel {
    config_id: String,
    value: String,
    name: String,
    preferred_45: bool,
}

fn preferred_sonnet(options: &[ConfigOption], allow_current: bool) -> Option<SelectedModel> {
    let model = options
        .iter()
        .find(|option| option.category.as_deref() == Some("model"))?;
    let normalized = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let choices: Vec<_> = model
        .groups
        .iter()
        .flat_map(|group| &group.choices)
        .filter(|choice| {
            let value = normalized(&choice.value);
            let name = normalized(&choice.name);
            (value.contains("sonnet") || name.contains("sonnet"))
                && !value.contains("opus")
                && !name.contains("opus")
        })
        .collect();
    let is_45 = |choice: &span_acp::ConfigChoice| {
        normalized(&choice.value).contains("sonnet45")
            || normalized(&choice.name).contains("sonnet45")
    };
    let choice = choices
        .iter()
        .copied()
        .find(|choice| is_45(choice))
        .or_else(|| {
            if allow_current {
                choices
                    .iter()
                    .copied()
                    .find(|choice| choice.value == model.current_value)
            } else {
                None
            }
        })?;
    Some(SelectedModel {
        config_id: model.id.clone(),
        value: choice.value.clone(),
        name: choice.name.clone(),
        preferred_45: is_45(choice),
    })
}

fn same_file(value: &str, target: &Path) -> bool {
    value == "greeting.txt"
        || Path::new(value).is_absolute()
            && Path::new(value).canonicalize().ok().as_deref() == Some(target)
}

fn allowed_permission(
    kind: Option<&str>,
    raw: Option<&Value>,
    locations: &[ToolLocation],
    target: &Path,
) -> bool {
    if !matches!(kind, Some("read" | "edit")) {
        return false;
    }
    let mut paths = Vec::new();
    if let Some(raw) = raw {
        for key in ["path", "file_path", "filePath"] {
            if let Some(path) = raw.get(key).and_then(Value::as_str) {
                paths.push(path);
            }
        }
    }
    paths.extend(locations.iter().map(|location| location.path.as_str()));
    !paths.is_empty() && paths.iter().all(|path| same_file(path, target))
}

async fn turn(
    service: &AgentService,
    session: &str,
    events: &mut mpsc::UnboundedReceiver<AgentEvent>,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    path: &Path,
    accept: bool,
    deadline: Instant,
) -> Result<()> {
    if Instant::now() >= deadline {
        return Err("The shared smoke deadline expired before dispatching a model turn".into());
    }
    let target = if accept { ACCEPTED } else { REJECTED };
    let instruction = if accept {
        "After the editor accepts, finish briefly."
    } else {
        "The editor will reject this edit to verify review safety. After rejection, do not retry or use another tool. Finish briefly."
    };
    let request = format!("This is an isolated ACP editor review test in an owned temporary folder. Use only ACP filesystem read and write callbacks for {}. Read it, then propose replacing its entire content with exactly {:?}. Write through the client's fs/write_text_file callback so the editor can review it. Do not run shell commands, terminal commands, processes, network tools, direct filesystem writes, or access any other file. If these callbacks are unavailable, say so and stop. {instruction}", path.display(), target);
    let prompt_service = service.clone();
    let prompt_session = session.to_owned();
    let mut prompt = tokio::spawn(async move {
        if Instant::now() >= deadline {
            return Err("The shared smoke deadline expired before dispatching a model turn".into());
        }
        prompt_service.prompt(prompt_session, request, vec![]).await
    });
    let timeout = tokio::time::sleep_until(deadline);
    tokio::pin!(timeout);
    let mut reviewed = false;
    let mut expected_snapshot = workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned")?
        .agent_read("greeting.txt")
        .map_err(|error| error.to_string())?;
    let mut reply = ReplyExcerpt::default();
    let result = async {
        loop {
            tokio::select! {
                response = &mut prompt => {
                    // Notifications preceding the response may still be queued.
                    for _ in 0..256 {
                        let Ok(event) = events.try_recv() else { break; };
                        if let AgentEvent::Text { session_id, text, .. } = event {
                            if session_id == session { reply.push(&text); }
                        }
                    }
                    let snapshot = workspace.lock().map_err(|_| "Workspace lock poisoned")?.agent_read("greeting.txt").map_err(|error| error.to_string())?;
                    let expected_disk = if reviewed && accept { ACCEPTED } else { ORIGINAL };
                    if snapshot.text != expected_snapshot.text || snapshot.revision != expected_snapshot.revision || snapshot.saved_revision != expected_snapshot.saved_revision || std::fs::read_to_string(path).map_err(|error| error.to_string())? != expected_disk {
                        return Err(format!("Provider changed the owned file outside the verified review/Save state; provider reply: {}", reply.redacted(path)));
                    }
                    if !reviewed { return Err(format!("Provider completed without the expected ACP write proposal; owned buffer and disk unchanged; provider reply: {}", reply.redacted(path))); }
                    return match response {
                        Ok(Ok(())) => Ok(()),
                        _ => Err("Provider did not finish the accepted turn successfully".into()),
                    };
                }
                _ = &mut timeout => return Err("The two-turn smoke exceeded its shared 90 second deadline".into()),
                event = events.recv() => {
                    let Some(event) = event else { return Err("Provider event stream closed".into()); };
                    match event {
                        AgentEvent::Permission { session_id, request_id, tool_kind, raw_input, locations, options, .. } => {
                            let allowed = session_id == session && allowed_permission(tool_kind.as_deref(), raw_input.as_ref(), &locations, path);
                            let wanted = if allowed { "allow_once" } else { "reject_once" };
                            let option = options.iter().find(|option| option.kind == wanted).map(|option| option.option_id.clone());
                            service.respond_permission(session_id, request_id, option)?;
                            if !allowed { return Err("Provider requested an operation outside the one-file read/edit scope; it was denied".into()); }
                        }
                        AgentEvent::Proposal { session_id, proposal } => {
                            let valid = session_id == session && !reviewed && proposal.path == "greeting.txt" && proposal.hunks.len() == 1 && proposal.hunks[0].before == ORIGINAL && proposal.hunks[0].after == target;
                            let before = workspace.lock().map_err(|_| "Workspace lock poisoned")?.agent_read("greeting.txt").map_err(|error| error.to_string())?;
                            if std::fs::read_to_string(path).map_err(|error| error.to_string())? != ORIGINAL { return Err("Provider wrote directly to disk before review".into()); }
                            let snapshot = service.review_proposal(proposal.id, accept && valid, proposal.base_revision)?;
                            if !valid { return Err("Provider proposed an unexpected edit; it was rejected".into()); }
                            if std::fs::read_to_string(path).map_err(|error| error.to_string())? != ORIGINAL { return Err("Review changed disk before explicit Save".into()); }
                            if accept {
                                if snapshot.text != ACCEPTED || snapshot.saved_revision == snapshot.revision { return Err("Accepted edit was not retained as an unsaved editor buffer".into()); }
                                workspace.lock().map_err(|_| "Workspace lock poisoned")?.save_buffer("greeting.txt", snapshot.revision).map_err(|error| error.to_string())?;
                                let saved = workspace.lock().map_err(|_| "Workspace lock poisoned")?.agent_read("greeting.txt").map_err(|error| error.to_string())?;
                                if std::fs::read_to_string(path).map_err(|error| error.to_string())? != ACCEPTED || saved.saved_revision != saved.revision { return Err("Explicit Save did not persist the accepted edit".into()); }
                                expected_snapshot = saved;
                                println!("Verified accepted ACP proposal, unsaved buffer and explicit Save");
                            } else {
                                if snapshot.text != before.text || snapshot.revision != before.revision || snapshot.saved_revision != before.saved_revision { return Err("Rejected proposal changed the editor buffer".into()); }
                                expected_snapshot = snapshot;
                                println!("Verified rejected ACP proposal preserved editor buffer and disk");
                            }
                            reviewed = true;
                        }
                        AgentEvent::AuthRequired { .. } => return Err("Existing provider authentication was not accepted; no sign-in was attempted".into()),
                        AgentEvent::Elicitation { .. } => return Err("Provider requested unexpected interactive input".into()),
                        AgentEvent::Text { session_id, text, .. } if session_id == session => reply.push(&text),
                        _ => {},
                    }
                }
            }
        }
    }.await;
    if !prompt.is_finished() {
        let _ = service.cancel(session.to_owned());
        prompt.abort();
        let _ = prompt.await;
    }
    result
}

async fn exercise(
    service: &AgentService,
    events: &mut mpsc::UnboundedReceiver<AgentEvent>,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    path: &Path,
    allow_current_sonnet: bool,
) -> Result<()> {
    let session = service.new_session().await.map_err(|_| {
        "Provider did not open the isolated session using its existing authentication"
    })?;
    let mut options = Vec::new();
    while let Ok(event) = events.try_recv() {
        match event {
            AgentEvent::Ready { features, .. } if features.edits_bypass_review == Some(true) => return Err("This provider writes outside client review; the review smoke will not prompt it".into()),
            AgentEvent::Config { session_id, options: found } if session_id == session => options = found,
            _ => {},
        }
    }
    let mode = options
        .iter()
        .find(|option| option.category.as_deref() == Some("mode"))
        .ok_or("Provider did not advertise its approval mode; no model turn was sent")?;
    if mode.current_value != "default" {
        if !mode
            .groups
            .iter()
            .flat_map(|group| &group.choices)
            .any(|choice| choice.value == "default")
        {
            return Err(
                "Provider does not offer the normal approval mode; no model turn was sent".into(),
            );
        }
        service
            .set_config(session.clone(), mode.id.clone(), "default".into())
            .await
            .map_err(|_| "Provider did not apply the normal approval mode")?;
        while let Ok(event) = events.try_recv() {
            if let AgentEvent::Config {
                session_id,
                options: updated,
            } = event
            {
                if session_id == session {
                    options = updated;
                }
            }
        }
    }
    let selected = preferred_sonnet(&options, allow_current_sonnet)
        .ok_or("Provider did not advertise the permitted Sonnet choice; no model turn was sent")?;
    let id = selected.config_id;
    let value = selected.value;
    service
        .set_config(session.clone(), id.clone(), value.clone())
        .await
        .map_err(|_| "Provider did not apply the requested Sonnet model")?;
    let mut confirmed = false;
    while let Ok(event) = events.try_recv() {
        if let AgentEvent::Config {
            session_id,
            options,
        } = event
        {
            if session_id == session {
                let model_confirmed = options
                    .iter()
                    .any(|option| option.id == id && option.current_value == value);
                let mode_confirmed = options.iter().any(|option| {
                    option.category.as_deref() == Some("mode") && option.current_value == "default"
                });
                confirmed = model_confirmed && mode_confirmed;
            }
        }
    }
    if !confirmed {
        return Err(
            "Provider did not confirm the exact Sonnet choice in normal approval mode; no turn was sent"
                .into(),
        );
    }
    if !selected.preferred_45 {
        println!("Sonnet 4.5 was not advertised; the caller explicitly allowed the current Sonnet choice");
    }
    println!(
        "Selected and confirmed {:?} (model value {:?}) in normal approval mode",
        selected.name, value
    );
    let deadline = Instant::now() + Duration::from_secs(90);
    turn(service, &session, events, workspace, path, false, deadline).await?;
    turn(service, &session, events, workspace, path, true, deadline).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let manifest = args.next().ok_or("Installed agent manifest required")?;
    let allow_current_sonnet = match args.next().as_deref() {
        None => false,
        Some("--allow-current-sonnet") => true,
        _ => return Err("Unknown provider acceptance argument".into()),
    };
    if args.next().is_some() {
        return Err("Too many provider acceptance arguments".into());
    }
    let installed: InstalledAgent = serde_json::from_slice(&std::fs::read(manifest)?)?;
    if installed.id != "claude-acp" {
        return Err("This bounded acceptance run requires the managed Claude ACP adapter".into());
    }
    let directory = tempfile::tempdir()?;
    let root = directory.path().canonicalize()?;
    let path: PathBuf = root.join("greeting.txt");
    std::fs::write(&path, ORIGINAL)?;
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(&root)?.with_user_settings(None),
    ));
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = AgentService::start(
        installed.launch,
        root.to_string_lossy().into_owned(),
        workspace.clone(),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .map_err(|_| "Provider process did not initialize for the isolated smoke")?;
    let result = exercise(
        &service,
        &mut events,
        &workspace,
        &path,
        allow_current_sonnet,
    )
    .await;
    let cleanup = service.shutdown_and_wait().await;
    result?;
    cleanup?;
    println!("Live provider accept/reject review smoke passed; owned process shutdown completed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use span_acp::AgentCommand;

    #[test]
    fn permission_scope_rejects_other_files_unknown_paths_and_execution() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("greeting.txt");
        std::fs::write(&path, ORIGINAL).unwrap();
        let path = path.canonicalize().unwrap();
        let raw = json!({"file_path": path});
        assert!(allowed_permission(Some("read"), Some(&raw), &[], &path));
        assert!(allowed_permission(
            Some("edit"),
            Some(&json!({"path":"greeting.txt"})),
            &[],
            &path
        ));
        assert!(!allowed_permission(Some("execute"), Some(&raw), &[], &path));
        assert!(!allowed_permission(Some("read"), None, &[], &path));
        assert!(!allowed_permission(
            Some("edit"),
            Some(&json!({"path":"other.txt"})),
            &[],
            &path
        ));
        assert!(!allowed_permission(
            Some("read"),
            Some(&raw),
            &[ToolLocation {
                path: "other.txt".into(),
                line: None
            }],
            &path
        ));
    }

    #[test]
    fn reply_excerpt_redacts_streamed_paths_and_bounds_diagnostics() {
        let path = Path::new("/private/tmp/span-owned-fixture/greeting.txt");
        let mut reply = ReplyExcerpt::default();
        reply.push("Unavailable at /private/tmp/span-");
        reply.push("owned-fixture/greeting.txt or /tmp/span-owned-fixture/greeting.txt\n");
        let excerpt = reply.redacted(path);
        assert!(excerpt.contains("<owned-workspace>/greeting.txt"));
        assert!(!excerpt.contains("/private/tmp"));
        assert!(!excerpt.contains("/tmp/span"));
        reply.push(&"bounded ".repeat(2000));
        reply.push("/private/tmp/span-owned-fixture");
        assert!(reply.text.len() <= 8192);
        assert!(reply.redacted(path).len() < 2200);
        assert!(reply.redacted(path).contains("reply truncated"));
    }

    #[test]
    fn sonnet_fallback_requires_explicit_current_choice_and_never_selects_opus() {
        use span_acp::{ConfigChoice, ConfigGroup};
        let choice = |value: &str, name: &str| ConfigChoice {
            value: value.into(),
            name: name.into(),
            description: None,
        };
        let mut options = vec![ConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some("model".into()),
            current_value: "sonnet".into(),
            groups: vec![ConfigGroup {
                name: String::new(),
                choices: vec![
                    choice("default", "Default"),
                    choice("opus", "Opus 5.5"),
                    choice("sonnet", "Sonnet 5.5"),
                    choice("claude-haiku-4-5", "Haiku 4.5"),
                ],
            }],
        }];
        assert!(preferred_sonnet(&options, false).is_none());
        let selected = preferred_sonnet(&options, true).unwrap();
        assert_eq!(selected.value, "sonnet");
        assert!(!selected.preferred_45);
        options[0].current_value = "opus".into();
        assert!(preferred_sonnet(&options, true).is_none());
        options[0].groups[0].choices[1].name = "Sonnet 5.5".into();
        assert!(preferred_sonnet(&options, true).is_none());
        options[0].groups[0].choices[1].name = "Opus 5.5".into();
        options[0].current_value = "sonnet".into();
        options[0].groups[0].choices[2].name = "Opus 5.5".into();
        assert!(preferred_sonnet(&options, true).is_none());
        options[0].groups[0].choices[2].name = "Sonnet 5.5".into();
        options[0].groups[0]
            .choices
            .push(choice("claude-sonnet-4-5-20250929", "Sonnet 4.5"));
        assert_eq!(
            preferred_sonnet(&options, false).unwrap().value,
            "claude-sonnet-4-5-20250929"
        );
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        service: AgentService,
        events: mpsc::UnboundedReceiver<AgentEvent>,
        workspace: Arc<Mutex<CoreWorkspace>>,
        path: PathBuf,
        prompts: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl Fixture {
        async fn start(flag: Option<&str>) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let path = root.join("greeting.txt");
            std::fs::write(&path, ORIGINAL).unwrap();
            let workspace = Arc::new(Mutex::new(
                CoreWorkspace::open(&root).unwrap().with_user_settings(None),
            ));
            let (tx, events) = mpsc::unbounded_channel();
            let prompts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = prompts.clone();
            let mut args = vec![format!(
                "{}/tests/fixtures/provider_review.mjs",
                env!("CARGO_MANIFEST_DIR")
            )];
            args.extend(flag.map(str::to_owned));
            let service = AgentService::start(
                AgentCommand {
                    command: "node".into(),
                    args,
                    env: Default::default(),
                },
                root.to_string_lossy().into_owned(),
                workspace.clone(),
                Arc::new(move |event| {
                    if let AgentEvent::Log { direction, line } = &event {
                        if direction == "Stdin"
                            && serde_json::from_str::<Value>(line)
                                .ok()
                                .is_some_and(|message| message["method"] == "session/prompt")
                        {
                            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    let _ = tx.send(event);
                }),
            )
            .await
            .unwrap();
            Self {
                _directory: directory,
                service,
                events,
                workspace,
                path,
                prompts,
            }
        }
    }

    #[tokio::test]
    async fn owned_process_peer_exercises_reject_then_accept_and_save() {
        let mut fixture = Fixture::start(None).await;
        let result = exercise(
            &fixture.service,
            &mut fixture.events,
            &fixture.workspace,
            &fixture.path,
            false,
        )
        .await;
        let shutdown = fixture.service.shutdown_and_wait().await;
        result.unwrap();
        shutdown.unwrap();
        assert_eq!(fixture.prompts.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(std::fs::read_to_string(&fixture.path).unwrap(), ACCEPTED);
    }

    #[tokio::test]
    async fn a_missing_callback_reports_redacted_provider_reply_and_stops_after_one_turn() {
        let mut fixture = Fixture::start(Some("--no-callbacks")).await;
        let result = exercise(
            &fixture.service,
            &mut fixture.events,
            &fixture.workspace,
            &fixture.path,
            false,
        )
        .await;
        fixture.service.shutdown_and_wait().await.unwrap();
        let error = result.unwrap_err();
        assert!(error.contains("ACP filesystem callbacks are unavailable"));
        assert!(error.contains("<owned-workspace>/greeting.txt"));
        assert!(error.contains("owned buffer and disk unchanged"));
        assert!(!error.contains(fixture.path.parent().unwrap().to_str().unwrap()));
        assert_eq!(fixture.prompts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_to_string(&fixture.path).unwrap(), ORIGINAL);
    }

    #[tokio::test]
    async fn a_direct_write_cannot_be_reported_as_an_unchanged_missing_proposal() {
        let mut fixture = Fixture::start(Some("--direct-write")).await;
        let result = exercise(
            &fixture.service,
            &mut fixture.events,
            &fixture.workspace,
            &fixture.path,
            false,
        )
        .await;
        fixture.service.shutdown_and_wait().await.unwrap();
        assert!(result
            .unwrap_err()
            .contains("outside the verified review/Save state"));
        assert_eq!(fixture.prompts.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn native_write_profiles_send_no_review_smoke_prompt() {
        for flag in ["--claude-native", "--codex-native"] {
            let mut fixture = Fixture::start(Some(flag)).await;
            let result = exercise(
                &fixture.service,
                &mut fixture.events,
                &fixture.workspace,
                &fixture.path,
                false,
            )
            .await;
            fixture.service.shutdown_and_wait().await.unwrap();
            assert!(result.unwrap_err().contains("writes outside client review"));
            assert_eq!(fixture.prompts.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert_eq!(std::fs::read_to_string(&fixture.path).unwrap(), ORIGINAL);
        }
    }

    #[tokio::test]
    async fn current_sonnet_process_peer_requires_explicit_fallback_authorization() {
        for allowed in [false, true] {
            let mut fixture = Fixture::start(Some("--current-sonnet")).await;
            let result = exercise(
                &fixture.service,
                &mut fixture.events,
                &fixture.workspace,
                &fixture.path,
                allowed,
            )
            .await;
            let shutdown = fixture.service.shutdown_and_wait().await;
            shutdown.unwrap();
            if allowed {
                result.unwrap();
            } else {
                assert!(result.is_err());
            }
            assert_eq!(
                fixture.prompts.load(std::sync::atomic::Ordering::SeqCst),
                if allowed { 2 } else { 0 }
            );
            assert_eq!(
                std::fs::read_to_string(&fixture.path).unwrap(),
                if allowed { ACCEPTED } else { ORIGINAL }
            );
        }
    }

    #[tokio::test]
    async fn a_later_wrong_model_or_mode_sends_no_paid_turn() {
        for flag in ["--revert-model", "--revert-mode"] {
            let mut fixture = Fixture::start(Some(flag)).await;
            let result = exercise(
                &fixture.service,
                &mut fixture.events,
                &fixture.workspace,
                &fixture.path,
                false,
            )
            .await;
            let shutdown = fixture.service.shutdown_and_wait().await;
            assert!(result.is_err());
            shutdown.unwrap();
            assert_eq!(fixture.prompts.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert_eq!(std::fs::read_to_string(&fixture.path).unwrap(), ORIGINAL);
        }
    }

    #[tokio::test]
    async fn an_expired_deadline_sends_no_paid_turn() {
        let mut fixture = Fixture::start(None).await;
        let session = fixture.service.new_session().await.unwrap();
        let result = turn(
            &fixture.service,
            &session,
            &mut fixture.events,
            &fixture.workspace,
            &fixture.path,
            false,
            Instant::now() - Duration::from_millis(1),
        )
        .await;
        let shutdown = fixture.service.shutdown_and_wait().await;
        assert!(result.is_err());
        shutdown.unwrap();
        assert_eq!(fixture.prompts.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(std::fs::read_to_string(&fixture.path).unwrap(), ORIGINAL);
    }
}
