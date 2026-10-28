import { Channel } from "@tauri-apps/api/core";
import type { TerminalEvent_Deserialize as TerminalEvent } from "../bindings";
import type { TerminalTransport } from "../components/TerminalPanel";
import { api, isDesktop } from "./client";

/** Adapts generated native terminal events to xterm's byte-oriented callbacks. */
export function createTerminalTransport(cwd: string | null): TerminalTransport {
  const sessions = new Map<string, { active: boolean; channel: Channel<TerminalEvent> }>();
  return {
    async create(cols, rows, handlers) {
      if (!isDesktop) throw new Error("Interactive terminals require the span desktop app.");
      const channel = new Channel<TerminalEvent>();
      const session = { active: true, channel };
      channel.onmessage = event => {
        if (event.kind === "output") {
          let acknowledged = false;
          const acknowledge = () => {
            if (acknowledged) return;
            acknowledged = true;
            void api.terminalAcknowledge(event.id, event.sequence).catch(cause => { if (session.active) handlers.error(String(cause)); });
          };
          if (!session.active) { acknowledge(); return; }
          try { handlers.data(Uint8Array.from(event.data), acknowledge); }
          catch (cause) { acknowledge(); handlers.error(String(cause)); }
        } else if (session.active && event.kind === "exit") handlers.exit(event.code ?? null);
        else if (session.active && event.kind === "error") handlers.error(event.message);
      };
      try {
        const info = await api.terminalCreate(cwd, cols, rows, channel);
        sessions.set(info.id, session);
        return info.id;
      } catch (cause) { session.active = false; throw cause; }
    },
    write: (id, data) => api.terminalWrite(id, data),
    resize: (id, cols, rows) => api.terminalResize(id, cols, rows),
    interrupt: id => api.terminalInterrupt(id),
    async close(id) {
      await api.terminalClose(id);
      const session = sessions.get(id);
      if (session) session.active = false;
      sessions.delete(id);
    },
  };
}
