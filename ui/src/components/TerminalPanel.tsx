import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { Icon } from "./Icon";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";

/** UI callbacks only. The desktop adapter uses the generated Rust IPC contracts. */
export interface TerminalTransport {
  create(cols: number, rows: number, handlers: TerminalHandlers): Promise<string>;
  write(id: string, data: Uint8Array): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  interrupt(id: string): Promise<void>;
  close(id: string): Promise<void>;
}
export interface TerminalHandlers {
  data(bytes: Uint8Array): void;
  exit(code: number | null): void;
  error(message: string): void;
}
export interface TerminalController {
  /** Called only by an explicit user action. Send preserves the exact snippet. */
  send(code: string, execute: boolean): Promise<void>;
  focus(): void;
}
export interface TerminalPanelProps {
  visible: boolean;
  workspaceLabel: string;
  transport: TerminalTransport;
  onReady?(controller: TerminalController | undefined): void;
  onHide(): void;
}

export function TerminalPanel(props: TerminalPanelProps) {
  let host!: HTMLDivElement;
  let terminal: Terminal | undefined;
  let fit: FitAddon | undefined;
  let observer: ResizeObserver | undefined;
  let sessionId: string | undefined;
  let initialization: Promise<void> | undefined;
  let disposed = false;
  let resizeFrame = 0;
  let generation = 0;
  let inputQueue: Promise<void> = Promise.resolve();
  const [status, setStatus] = createSignal("Starting shell");
  const [error, setError] = createSignal<string>();
  const [ready, setReady] = createSignal(false);
  const [exited, setExited] = createSignal(false);
  const [draft, setDraft] = createSignal<string>();
  const report = (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)); };
  const write = (data: Uint8Array) => {
    const currentId = sessionId;
    if (!currentId || exited()) return Promise.reject(new Error("Terminal session is unavailable"));
    // Preserve key and paste order even when IPC acknowledgements arrive later.
    inputQueue = inputQueue.catch(() => undefined).then(() => props.transport.write(currentId, data));
    return inputQueue;
  };
  const resize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!props.visible || !terminal || !fit || disposed || host.clientWidth === 0) return;
      fit.fit();
      if (sessionId && !exited()) void props.transport.resize(sessionId, terminal.cols, terminal.rows).catch(report);
    });
  };
  const start = async () => {
    const token = ++generation;
    const [{ Terminal: Xterm }, { FitAddon: Fit }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    if (disposed || token !== generation) return;
    terminal = new Xterm({
      cursorBlink: true, fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
      lineHeight: 1.25, scrollback: 5000, convertEol: false,
      theme: { background: "#17191d", foreground: "#d1d5dc", cursor: "#b5bfda", selectionBackground: "#58667d66" },
      allowProposedApi: false,
    });
    fit = new Fit();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    // WebGL is an optional renderer. Context loss falls back to the DOM renderer.
    if (typeof WebGL2RenderingContext !== "undefined") {
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        if (!disposed && token === generation) {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          terminal.loadAddon(webgl);
        }
      } catch { /* The default renderer supports machines without WebGL. */ }
    }
    if (disposed || token !== generation) return;
    terminal.onData(data => { void write(new TextEncoder().encode(data)).catch(report); });
    terminal.onBinary(data => { void write(Uint8Array.from(data, character => character.charCodeAt(0))).catch(report); });
    const id = await props.transport.create(terminal.cols, terminal.rows, {
      data: bytes => { if (!disposed) terminal?.write(bytes); },
      exit: code => { if (!disposed) { setExited(true); setStatus(code === null ? "Shell exited" : `Shell exited (${code})`); } },
      error: message => { if (!disposed) setError(message); },
    });
    if (disposed || token !== generation) { await props.transport.close(id); return; }
    sessionId = id;
    setReady(true);
    if (!exited()) setStatus("Shell");
    observer = new ResizeObserver(resize);
    observer.observe(host);
    props.onReady?.({
      async send(code, execute) {
        if (disposed || exited()) throw new Error("Terminal session is unavailable");
        if (!execute) { setDraft(code); return; }
        terminal?.focus();
        await write(new TextEncoder().encode(!/[\r\n]$/.test(code) ? `${code}\r` : code));
      },
      focus: () => terminal?.focus(),
    });
    resize();
    terminal.focus();
  };
  createEffect(() => {
    if (props.visible) {
      if (!initialization) initialization = start().catch(report);
      else { resize(); terminal?.focus(); }
    }
  });
  onCleanup(() => {
    disposed = true;
    generation++;
    cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    props.onReady?.(undefined);
    terminal?.dispose();
    if (sessionId) void props.transport.close(sessionId).catch(() => undefined);
  });
  const close = async () => {
    generation++;
    setReady(false);
    if (sessionId) {
      try { await props.transport.close(sessionId); }
      catch (failure) { report(failure); return; }
      sessionId = undefined;
    }
    setExited(true);
    setStatus("Shell closed");
    props.onReady?.(undefined);
    props.onHide();
  };
  const restart = async () => {
    generation++;
    if (sessionId) await props.transport.close(sessionId);
    sessionId = undefined;
    setReady(false);
    setExited(false);
    setError(undefined);
    setStatus("Starting shell");
    observer?.disconnect();
    terminal?.dispose();
    host.replaceChildren();
    initialization = start().catch(report);
    await initialization;
  };
  return <section class="terminal-panel" classList={{ "terminal-panel-hidden": !props.visible }} aria-label="Terminal">
    <header class="terminal-toolbar">
      <span class="terminal-title">TERMINAL</span>
      <span class="terminal-session">{props.workspaceLabel}</span>
      <span class="terminal-status" role="status">{status()}</span>
      <div class="terminal-actions">
        <Show when={exited() || error()}><button type="button" title="Start new shell" aria-label="Start new shell" onClick={() => void restart().catch(report)}><Icon name="add" size={14} /></button></Show>
        <button type="button" title="Clear terminal display" aria-label="Clear terminal display" onClick={() => terminal?.clear()}><Icon name="eraser-1" size={14} /></button>
        <button type="button" title="Interrupt command (Ctrl+C)" aria-label="Interrupt command" disabled={!ready() || exited()} onClick={() => { if (sessionId) void props.transport.interrupt(sessionId).catch(report); }}>^C</button>
        <button type="button" title="Hide terminal" aria-label="Hide terminal" onClick={props.onHide}><Icon name="arrow-down4" size={14} /></button>
        <button type="button" title="Close terminal and stop its processes" aria-label="Close terminal and stop its processes" onClick={() => void close()}><Icon name="close-circle" size={14} /></button>
      </div>
    </header>
    <Show when={error()}><div class="terminal-error" role="alert">{error()}</div></Show>
    <Show when={draft() !== undefined}>
      <div class="terminal-draft">
        <label for="terminal-command-draft">Review command before running</label>
        <textarea id="terminal-command-draft" aria-label="Terminal command draft" spellcheck={false} value={draft() ?? ""} onInput={event => setDraft(event.currentTarget.value)} />
        <div><button type="button" disabled={exited()} onClick={() => {
          const code = draft();
          if (code === undefined) return;
          void write(new TextEncoder().encode(!/[\r\n]$/.test(code) ? `${code}\r` : code)).then(() => { setDraft(undefined); terminal?.focus(); }).catch(report);
        }}>Run draft</button><button type="button" onClick={() => setDraft(undefined)}>Discard</button></div>
      </div>
    </Show>
    <div class="terminal-host" ref={host} />
  </section>;
}
