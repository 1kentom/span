//! Run: cargo run --release -p span-core --example rope_bench
//! Core timings only, not a claim that desktop paint or scrolling gates pass.
use span_core::{CoreWorkspace, TextEdit};
use std::{fs, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = 100 * 1024 * 1024;
    let line = "const value = 42; // span benchmark\n";
    let text = line.repeat(bytes / line.len() + 1);
    let directory = tempfile::tempdir()?;
    fs::write(directory.path().join("large.ts"), &text.as_bytes()[..bytes])?;
    drop(text);
    let mut workspace = CoreWorkspace::open(directory.path())?;
    let started = Instant::now();
    let snapshot = workspace.open_buffer("large.ts")?;
    let open = started.elapsed();
    let document_bytes = snapshot.text.len();
    drop(snapshot);
    let started = Instant::now();
    let revision = workspace.edit_buffer_delta(
        "large.ts",
        0,
        vec![TextEdit {
            from: (bytes / 2) as u32,
            to: (bytes / 2) as u32,
            insert: "edited".into(),
        }],
    )?;
    let edit = started.elapsed();
    println!("100 MiB core open (disk read, rope, IPC snapshot): {open:?}");
    println!("Core middle insert (UTF-16 validation, metadata acknowledgement): {edit:?}");
    println!(
        "bytes={document_bytes}, revision={}; fixture generation excluded; OS file cache warm",
        revision.revision
    );
    Ok(())
}
