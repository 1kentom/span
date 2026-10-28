import { createEffect, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
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
  data(bytes: Uint8Array, acknowledge?: () => void): void;
  exit(code: number | null): void;
  error(message: string): void;
}
export interface TerminalController {
  /** Called only by an explicit user action. Send preserves the exact snippet. */
  send(code: string, execute: boolean): Promise<void>;
  focus(): void;
  clear(): void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  selection(): string;
  paste(text: string): void;
}
export interface TerminalPanelProps {
  visible: boolean;
  workspaceLabel: string;
  transport: TerminalTransport;
  onReady?(controller: TerminalController | undefined): void;
  onHide(): void;
  embedded?: boolean;
  label?: string;
  onError?(message: string): void;
}

export function TerminalPanel(props: TerminalPanelProps) {
  const draftId = `terminal-command-${createUniqueId()}`;
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
  const [draftRunning, setDraftRunning] = createSignal(false);
  let draftVersion = 0;
  let activeDraftRun: object | undefined;
  const updateDraft = (value: string | undefined) => { draftVersion++; setDraft(value); };
  const invalidateDraftRun = () => { activeDraftRun = undefined; setDraftRunning(false); };
  const report = (failure: unknown) => { if (disposed) return; const message = failure instanceof Error ? failure.message : String(failure); setError(message); props.onError?.(message); };
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
      cursorBlink: true, fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
      lineHeight: 1.25, scrollback: 5000, convertEol: false,
      theme: { background: "#18191b", foreground: "#d1d5dc", cursor: "#b5bfda", selectionBackground: "#58667d66" },
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
      data: (bytes, acknowledge) => { if (!disposed && token === generation && terminal) terminal.write(bytes, acknowledge); else acknowledge?.(); },
      exit: code => { if (!disposed && token === generation) { setExited(true); setStatus(code === null ? "Shell exited" : `Shell exited (${code})`); } },
      error: message => { if (!disposed && token === generation) report(message); },
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
        if (!execute) { updateDraft(code); return; }
        terminal?.focus();
        await write(new TextEncoder().encode(!/[\r\n]$/.test(code) ? `${code}\r` : code));
      },
      focus: () => terminal?.focus(),
      clear: () => terminal?.clear(),
      interrupt: async () => { if (!sessionId || exited()) throw new Error("Terminal session is unavailable"); await props.transport.interrupt(sessionId); },
      close,
      selection: () => terminal?.getSelection() ?? "",
      paste: text => { if (!terminal || exited()) throw new Error("Terminal session is unavailable"); terminal.paste(text); },
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
    activeDraftRun = undefined;
    generation++;
    cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    props.onReady?.(undefined);
    terminal?.dispose();
    if (sessionId) void props.transport.close(sessionId).catch(() => undefined);
  });
  const close = async () => {
    if (sessionId) {
      try { await props.transport.close(sessionId); }
      catch (failure) { report(failure); throw failure; }
      sessionId = undefined;
    }
    generation++;
    invalidateDraftRun();
    setReady(false);
    setExited(true);
    setStatus("Shell closed");
    props.onReady?.(undefined);
    props.onHide();
  };
  const restart = async () => {
    if (sessionId) await props.transport.close(sessionId);
    generation++;
    invalidateDraftRun();
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
  const runDraft = async () => {
    const code = draft();
    if (disposed || exited() || activeDraftRun || code === undefined) return;
    const intent = {};
    const token = generation;
    const version = draftVersion;
    const id = sessionId;
    activeDraftRun = intent;
    setDraftRunning(true);
    const current = () => !disposed && generation === token && sessionId === id && activeDraftRun === intent;
    try {
      await write(new TextEncoder().encode(!/[\r\n]$/.test(code) ? `${code}\r` : code));
      if (current() && draftVersion === version) { updateDraft(undefined); terminal?.focus(); }
    } catch (failure) { if (current()) report(failure); }
    finally { if (current()) { activeDraftRun = undefined; setDraftRunning(false); } }
  };
  return <section class="terminal-panel" classList={{ "terminal-panel-hidden": !props.visible }} aria-label={props.label || "Terminal"}>
    <Show when={!props.embedded}><header class="terminal-toolbar">
      <span class="terminal-title">TERMINAL</span>
      <span class="terminal-session">{props.workspaceLabel}</span>
      <span class="terminal-status" role="status">{status()}</span>
      <div class="terminal-actions">
        <Show when={exited() || error()}><button type="button" title="Start new shell" aria-label="Start new shell" onClick={() => void restart().catch(report)}><Icon name="Add" size={14} /></button></Show>
        <button type="button" title="Clear terminal display" aria-label="Clear terminal display" onClick={() => terminal?.clear()}><Icon name="menu-discard" size={14} /></button>
        <button type="button" title="Interrupt command (Ctrl+C)" aria-label="Interrupt command" disabled={!ready() || exited()} onClick={() => { if (sessionId) void props.transport.interrupt(sessionId).catch(report); }}>^C</button>
        <button type="button" title="Hide terminal" aria-label="Hide terminal" onClick={props.onHide}><Icon name="arrow-down4" size={14} /></button>
        <button type="button" title="Close terminal and stop its processes" aria-label="Close terminal and stop its processes" onClick={() => void close().catch(report)}><Icon name="CloseCircle" size={14} /></button>
      </div>
    </header></Show>
    <Show when={props.embedded && exited()}><div class="terminal-exit-status" role="status">{status()}</div></Show>
    <Show when={error()}><div class="terminal-error" role="alert">{error()}</div></Show>
    <Show when={draft() !== undefined}>
      <div class="terminal-draft">
        <label for={draftId}>Review command before running</label><div class="terminal-draft-cwd" title={props.workspaceLabel}>Working directory: {props.workspaceLabel}</div>
        <textarea id={draftId} aria-label="Terminal command draft" spellcheck={false} value={draft() ?? ""} onInput={event => updateDraft(event.currentTarget.value)} />
        <div><button type="button" disabled={exited() || draftRunning()} aria-busy={draftRunning()} onClick={() => void runDraft()}>Run draft</button><button type="button" onClick={() => updateDraft(undefined)}>Discard</button></div>
      </div>
    </Show>
    <div class="terminal-host" ref={host} />
  </section>;
}
