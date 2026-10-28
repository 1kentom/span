//! Safe event emission.
//!
//! `tauri_specta::Event::emit` panics when `Builder::mount_events` has not run yet
//! ("EventRegistry not found in Tauri state"). A second launch can reach the
//! single-instance callback, and a webview can invoke commands, while `setup` is still
//! running, so every emit goes through [`emit`], which skips the event until
//! [`mark_mounted`] has been called right after `mount_events`.
//!
//! Skipping is lossless for the startup queue: requests are stored in
//! `DesktopState::startup_requests` and the frontend drains them with
//! `take_startup_requests` when it starts, so the event is only a nudge.

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime};

/// Marker in Tauri state: the typed events are mounted and may be emitted.
struct EventsMounted;

/// Call once, immediately after `Builder::mount_events`.
pub fn mark_mounted<R: Runtime>(handle: &impl Manager<R>) {
    handle.manage(EventsMounted);
}

pub fn is_mounted<R: Runtime>(handle: &impl Manager<R>) -> bool {
    handle.try_state::<EventsMounted>().is_some()
}

/// Emits `event` to every target. Returns false (and emits nothing) before the events are
/// mounted or when the emit fails; never panics for lack of the registry.
pub fn emit<R, H, E>(handle: &H, event: &E) -> bool
where
    R: Runtime,
    H: Emitter<R> + Manager<R>,
    E: tauri_specta::Event + Serialize + Clone,
{
    if !is_mounted(handle) {
        eprintln!(
            "Skipped event {} sent before the app finished starting",
            E::NAME
        );
        return false;
    }
    match event.emit(handle) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("Could not emit event {}: {error}", E::NAME);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use specta::Type;
    use tauri_specta::{collect_events, Builder, Event};

    #[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
    struct Ping {
        n: u32,
    }

    #[test]
    fn emitting_before_the_events_are_mounted_skips_instead_of_panicking() {
        let app = tauri::test::mock_app();
        assert!(!is_mounted(app.handle()));
        assert!(!emit(app.handle(), &Ping { n: 1 }));
    }

    #[test]
    fn emitting_after_mount_events_and_mark_mounted_delivers() {
        let app = tauri::test::mock_app();
        let builder = Builder::<tauri::test::MockRuntime>::new().events(collect_events![Ping]);
        builder.mount_events(&app);
        assert!(!emit(app.handle(), &Ping { n: 1 }), "not marked yet");
        mark_mounted(app.handle());
        assert!(emit(app.handle(), &Ping { n: 2 }));
    }
}
