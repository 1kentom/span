#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = span_desktop_lib::run() {
        eprintln!("span could not start: {error}");
        std::process::exit(1);
    }
}
