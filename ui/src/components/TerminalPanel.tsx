import { createEffect, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { Icon } from "./Icon";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";
import { terminalFontFamily, terminalTheme } from "../lib/terminal-theme";

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
  fontSize?: number;
  fontFamily?: string;
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
  let appearanceObserver: MutationObserver | undefined;
  let sessionId: string | undefined;
  let initialization: Promise<void> | undefined;
  let disposed = false;
  let resizeFrame = 0;
  let generation = 0;
  let inputQueue: Promise<void> = Promise.resolve();
  let startupInput: { token: number; chunks: Uint8Array[]; bytes: number } | undefined;
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
  const write = (data: Uint8Array, token = generation) => {
    if (disposed || token !== generation || exited()) return Promise.reject(new Error("Terminal session is unavailable"));
    const currentId = sessionId;
    if (!currentId) {
      if (!startupInput || startupInput.token !== token) return Promise.reject(new Error("Terminal session is unavailable"));
      if (startupInput.bytes + data.byteLength > 64 * 1024 || startupInput.chunks.length >= 256) return Promise.reject(new Error("Terminal startup input limit reached"));
      startupInput.chunks.push(data.slice());
      startupInput.bytes += data.byteLength;
      return Promise.resolve();
    }
    // Preserve key and paste order even when IPC acknowledgements arrive later.
    inputQueue = inputQueue.catch(() => undefined).then(() => {
      if (disposed || token !== generation || sessionId !== currentId || exited()) throw new Error("Terminal session is unavailable");
      return props.transport.write(currentId, data);
    });
    return inputQueue;
  };
  const resize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (!props.visible || !terminal || !fit || disposed || host.clientWidth === 0) return;
      const style = getComputedStyle(host);
      terminal.options.theme = terminalTheme(style);
      terminal.options.fontFamily = terminalFontFamily(props.fontFamily || style.getPropertyValue("--editor-font-family").trim());
      terminal.options.fontSize = props.fontSize || 13;
      fit.fit();
      const id = sessionId; const token = generation;
      if (id && !exited()) void props.transport.resize(id, terminal.cols, terminal.rows).catch(failure => { if (token === generation && id === sessionId) report(failure); });
    });
  };
  const start = async () => {
    const token = ++generation;
    const [{ Terminal: Xterm }, { FitAddon: Fit }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    if (disposed || token !== generation) return;
    const style = getComputedStyle(host);
    terminal = new Xterm({
      cursorBlink: true, fontFamily: terminalFontFamily(props.fontFamily || style.getPropertyValue("--editor-font-family").trim()), fontSize: props.fontSize || 13,
      lineHeight: 20 / 13, scrollback: 5000, convertEol: false,
      theme: terminalTheme(style),
      allowProposedApi: false,
    });
    fit = new Fit();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    // WebGL is an optional renderer. Context loss falls back to the default renderer.
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
    const reportInput = (failure: unknown) => { if (!disposed && token === generation) report(failure); };
    // Renderer replies can arrive before create returns its native session ID.
    startupInput = { token, chunks: [], bytes: 0 };
    inputQueue = Promise.resolve();
    terminal.onData(data => { void write(new TextEncoder().encode(data), token).catch(reportInput); });
    terminal.onBinary(data => { void write(Uint8Array.from(data, character => character.charCodeAt(0)), token).catch(reportInput); });
    let id: string;
    try {
      id = await props.transport.create(terminal.cols, terminal.rows, {
        data: (bytes, acknowledge) => { if (!disposed && token === generation && terminal) terminal.write(bytes, acknowledge); else acknowledge?.(); },
        exit: code => { if (!disposed && token === generation) { setExited(true); setStatus(code === null ? "Shell exited" : `Shell exited (${code})`); } },
        error: message => { if (!disposed && token === generation) report(message); },
      });
    } catch (failure) {
      if (startupInput?.token === token) startupInput = undefined;
      if (!disposed && token === generation) throw failure;
      return;
    }
    if (disposed || token !== generation) { await props.transport.close(id); return; }
    sessionId = id;
    const pending = startupInput?.token === token ? startupInput.chunks : [];
    startupInput = undefined;
    for (const bytes of pending) void write(bytes, token).catch(reportInput);
    setReady(true);
    if (!exited()) setStatus("Shell");
    observer = new ResizeObserver(resize);
    observer.observe(host);
    appearanceObserver = new MutationObserver(resize);
    appearanceObserver.observe(host.closest(".ide") || document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    props.onReady?.({
      async send(code, execute) {
        if (disposed || exited()) throw new Error("Terminal session is unavailable");
        if (!execute) { updateDraft(code); return; }
        if (props.visible) terminal?.focus();
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
    if (props.visible) terminal.focus();
  };
  createEffect(() => {
    props.fontSize; props.fontFamily;
    if (terminal && props.visible) resize();
  });
  createEffect(() => {
    if (props.visible) {
      if (!initialization) initialization = start().catch(report);
      else { resize(); terminal?.focus(); }
    }
  });
  onCleanup(() => {
    disposed = true;
    startupInput = undefined;
    activeDraftRun = undefined;
    generation++;
    cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    appearanceObserver?.disconnect();
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
    startupInput = undefined;
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
    startupInput = undefined;
    invalidateDraftRun();
    sessionId = undefined;
    setReady(false);
    setExited(false);
    setError(undefined);
    setStatus("Starting shell");
    observer?.disconnect();
    appearanceObserver?.disconnect();
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
      if (current() && draftVersion === version) { updateDraft(undefined); if (props.visible) terminal?.focus(); }
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
