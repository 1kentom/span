//! Explicit opt-in network smoke: cargo run -p span-acp --example registry_smoke -- AGENT_ID CACHE_DIR WORKSPACE
use span_acp::{fetch_registry, install_registry_agent, AgentEvent, AgentService};
use span_core::CoreWorkspace;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let id = args.get(1).ok_or("Agent ID required")?;
    let cache = PathBuf::from(args.get(2).ok_or("Cache directory required")?);
    let cwd = args.get(3).ok_or("Existing workspace directory required")?;
    let registry = fetch_registry().await?;
    let entry = registry
        .iter()
        .find(|entry| entry.id == *id)
        .ok_or("Agent not found")?;
    println!("Discovered {} {}", entry.id, entry.version);
    let installed = install_registry_agent(id, &cache).await?;
    println!("Installed {} {}", installed.id, installed.version);
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(cwd)?.with_user_settings(None),
    ));
    let service = AgentService::start(
        installed.launch,
        cwd.clone(),
        workspace,
        Arc::new(|event| match event {
            AgentEvent::Status { state, message } => println!("{state}: {message}"),
            AgentEvent::Error { message } => eprintln!("ACP error: {message}"),
            _ => {}
        }),
    )
    .await?;
    println!("Created ACP session {}", service.new_session().await?);
    service.shutdown()?;
    Ok(())
}
