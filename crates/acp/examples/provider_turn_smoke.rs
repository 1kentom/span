//! Explicit one-prompt live-provider smoke in a temporary workspace.
//! Usage: cargo run --release -p span-acp --example provider_turn_smoke -- INSTALLED_MANIFEST
//! Does not read credentials. Existing provider authentication may be used by the agent.
use span_acp::{AgentEvent, AgentService, InstalledAgent};
use span_core::CoreWorkspace;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = std::env::args()
        .nth(1)
        .ok_or("Installed agent manifest required")?;
    let installed: InstalledAgent = serde_json::from_slice(&std::fs::read(manifest)?)?;
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("greeting.txt");
    std::fs::write(&path, "hello\n")?;
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())?.with_user_settings(None),
    ));
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = AgentService::start(
        installed.launch,
        directory.path().to_string_lossy().into_owned(),
        workspace.clone(),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await?;
    let session = service.new_session().await?;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let request = format!("This is a single isolated ACP editor integration test. Use only ACP filesystem read and write tools for {}. Read it, then propose changing its entire content to exactly hello span followed by one newline. Write through the client's fs/write_text_file callback so the editor can review the proposal. Do not run shell commands, terminal commands, processes, network tools, direct filesystem writes, or access any other file. If these ACP callbacks are unavailable, say so and stop. After the editor accepts, finish briefly.", path.display());
    let mut prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, request, vec![]).await });
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(90));
    tokio::pin!(deadline);
    let mut tool_kinds = HashMap::new();
    let mut reviewed = false;
    let mut result = Err("Provider completed without an ACP write proposal".to_string());
    loop {
        tokio::select! {
            response = &mut prompt => {
                match response {
                    Ok(Ok(())) if reviewed => result = Ok(()),
                    Ok(Ok(())) => {},
                    Ok(Err(error)) => result = Err(error),
                    Err(error) => result = Err(error.to_string()),
                }
                break;
            }
            _ = &mut deadline => {
                let _ = service.cancel(session.clone());
                result = Err("Provider turn exceeded the 90 second smoke deadline".into());
                break;
            }
            event = events.recv() => {
                let Some(event) = event else { break; };
                match event {
                    AgentEvent::Log { direction, line } if direction == "Stdout" => {
                        if let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) {
                            if message["method"] == "session/request_permission" {
                                let call = &message["params"]["toolCall"];
                                if let (Some(id), Some(kind)) = (call["toolCallId"].as_str(), call["kind"].as_str()) { tool_kinds.insert(id.to_owned(), kind.to_owned()); }
                            }
                        }
                    }
                    AgentEvent::Permission { request_id, tool_call_id, options, .. } => {
                        let allowed = tool_kinds.get(&tool_call_id).is_some_and(|kind| matches!(kind.as_str(), "read" | "edit"));
                        let kind = if allowed { "allow_once" } else { "reject_once" };
                        let option = options.iter().find(|option| option.kind == kind).map(|option| option.option_id.clone());
                        service.respond_permission(session.clone(), request_id, option)?;
                        println!("Permission: {}", if allowed { "filesystem operation allowed once" } else { "operation denied" });
                    }
                    AgentEvent::Proposal { proposal, .. } => {
                        let valid = proposal.path == "greeting.txt" && proposal.hunks.len() == 1 && proposal.hunks[0].after == "hello span\n";
                        let snapshot = service.review_proposal(proposal.id, valid, proposal.base_revision)?;
                        if !valid { result = Err("Provider proposed an unexpected edit".into()); break; }
                        if std::fs::read_to_string(&path)? != "hello\n" { result = Err("Provider bypassed review and wrote directly to disk".into()); break; }
                        if snapshot.text != "hello span\n" { result = Err("Accepted editor buffer did not match the requested content".into()); break; }
                        workspace.lock().map_err(|_| "Workspace lock poisoned")?.save_buffer("greeting.txt", snapshot.revision)?;
                        if std::fs::read_to_string(&path)? != "hello span\n" { result = Err("Explicit save did not persist the accepted proposal".into()); break; }
                        reviewed = true;
                        println!("Verified ACP proposal, editor acceptance, unsaved buffer and explicit save");
                    }
                    AgentEvent::Error { message } => eprintln!("Provider error: {message}"),
                    _ => {},
                }
            }
        }
    }
    let _ = service.shutdown();
    if !prompt.is_finished() {
        prompt.abort();
    }
    match result {
        Ok(()) => println!("Live provider turn smoke passed"),
        Err(error) => {
            println!("Live provider turn limitation: {error}");
            return Err(error.into());
        }
    }
    Ok(())
}
