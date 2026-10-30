import type { LanguageServerId } from "../bindings";
import type { NotificationInput } from "../stores/notifications";

/** A language server that kept falling behind on file changes after its automatic restarts were used up. */
export interface WatchWarning { server: LanguageServerId; message: string }

export interface WatchWarningDeps {
  restart: (server: LanguageServerId) => Promise<unknown>;
  /** Server ids already silenced in user settings. */
  silenced: () => readonly string[] | undefined;
  /** Writes `languageServers.silencedWatchWarnings` in user settings. */
  saveSilenced: (servers: string[]) => Promise<unknown>;
  onError: (cause: unknown) => void;
}

export const SILENCED_WATCH_WARNINGS_KEY = "languageServers.silencedWatchWarnings";
export const RESTART_LABEL = "Restart";
export const SILENCE_LABEL = "Don't warn again for this server";

/** Whether the user turned this server's watch warning off. */
export function isSilenced(server: LanguageServerId, silenced: readonly string[] | undefined): boolean {
  return Boolean(silenced?.includes(server));
}

/** The warning toast: one click restarts the server, the other stops this warning for it in user settings. */
export function watchWarningNotification(warning: WatchWarning, deps: WatchWarningDeps): NotificationInput {
  return {
    level: "warning",
    key: `lsp-watch:${warning.server}`,
    message: warning.message,
    sticky: true,
    actions: [
      { label: RESTART_LABEL, run: () => { void deps.restart(warning.server).catch(deps.onError); } },
      {
        label: SILENCE_LABEL,
        run: () => {
          const current = deps.silenced() ?? [];
          if (current.includes(warning.server)) return;
          void deps.saveSilenced([...current, warning.server]).catch(deps.onError);
        },
      },
    ],
  };
}
