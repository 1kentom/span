import { type JSX, For, batch, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import Icon from "./Icon";
import { TerminalPanel, type TerminalController, type TerminalTransport } from "./TerminalPanel";

export interface TerminalDockController {
  send(code: string, execute: boolean): Promise<void>;
  closeCurrent(): Promise<void>;
}
export interface TerminalDockProps {
  visible: boolean;
  headerStart?: JSX.Element;
  workspaceRoot: string;
  fontSize?: number;
  fontFamily?: string;
  transport: TerminalTransport;
  onReveal(): void;
  onHide(): void;
  onReady?(controller: TerminalDockController | undefined): void;
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
}

export function TerminalDock(props: TerminalDockProps) {
  const instance = createUniqueId();
  let tablist!: HTMLDivElement;
  const tabId = (id: number) => `${instance}-terminal-tab-${id}`;
  const panelId = (id: number) => `${instance}-terminal-session-${id}`;
  const [tabs, setTabs] = createSignal<number[]>([]);
  const [active, setActive] = createSignal<number>();
  const [closing, setClosing] = createSignal(new Set<number>());
  const [error, setError] = createSignal("");
  const controllers = new Map<number, TerminalController>();
  const failures = new Map<number, string>();
  const waiters = new Map<number, { resolve(controller: TerminalController): void; reject(error: Error): void }[]>();
  let next = 1;
  let disposed = false;
  function createSession() { const id = next++; batch(() => { setTabs(current => [...current, id]); setActive(id); }); return id; }
  function ready(id: number, controller: TerminalController | undefined) {
    if (!controller) { controllers.delete(id); return; }
    controllers.set(id, controller); failures.delete(id);
    for (const waiter of waiters.get(id) || []) waiter.resolve(controller);
    waiters.delete(id);
  }
  function fail(id: number, message: string) {
    failures.set(id, message);
    for (const waiter of waiters.get(id) || []) waiter.reject(new Error(message));
    waiters.delete(id);
  }
  function controller(id: number): Promise<TerminalController> {
    const current = controllers.get(id); if (current) return Promise.resolve(current);
    const failure = failures.get(id); if (failure) return Promise.reject(new Error(failure));
    return new Promise((resolve, reject) => waiters.set(id, [...(waiters.get(id) || []), { resolve, reject }]));
  }
  async function closeSession(id: number) {
    if (closing().has(id)) return;
    setClosing(current => new Set([...current, id]));
    try {
      await controllers.get(id)?.close();
      if (disposed) return;
      fail(id, "Terminal was closed"); controllers.delete(id); failures.delete(id);
      batch(() => {
        const remaining = tabs().filter(value => value !== id);
        if (!remaining.length) props.onHide();
        setTabs(remaining); if (active() === id) setActive(remaining.at(-1));
      });
    } catch (cause) { report(cause); }
    finally { if (!disposed) setClosing(current => { const result = new Set(current); result.delete(id); return result; }); }
  }
  function navigateTabs(event: KeyboardEvent, id: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const available = tabs(); const index = available.indexOf(id);
    const target = available[event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length];
    if (target !== undefined) { setActive(target); tablist.querySelector<HTMLButtonElement>(`[id="${tabId(target)}"]`)?.focus(); }
  }
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  async function action(run: (controller: TerminalController) => void | Promise<void>) {
    const id = active(); if (id === undefined) return;
    try { await run(await controller(id)); } catch (cause) { report(cause); }
  }
  const commands: TerminalDockController = {
    async closeCurrent() {
      if (disposed) throw new Error("Terminal workspace is no longer available");
      const id = active();
      if (id !== undefined) await closeSession(id);
    },
    async send(code, execute) {
      if (disposed) throw new Error("Terminal workspace is no longer available");
      // A fresh shell preserves the requested workspace cwd without injecting a cd command.
      const id = createSession(); props.onReveal();
      await (await controller(id)).send(code, execute);
    },
  };
  createEffect(() => { if (props.visible && !tabs().length) createSession(); });
  onMount(() => props.onReady?.(commands));
  onCleanup(() => { disposed = true; props.onReady?.(undefined); for (const id of waiters.keys()) fail(id, "Terminal workspace was closed"); });
  return <section class="panel terminal-dock" aria-label="Terminal">
    <header class="terminal-dock-toolbar">
      {props.headerStart}
      <div ref={tablist} class="terminal-dock-tabs" role="tablist" aria-label="Terminal sessions"><For each={tabs()}>{id => <div class="terminal-dock-tab" classList={{ active: active() === id }}><button id={tabId(id)} role="tab" tabIndex={active() === id ? 0 : -1} aria-selected={active() === id} aria-controls={panelId(id)} onKeyDown={event => navigateTabs(event, id)} onClick={() => { setActive(id); queueMicrotask(() => controllers.get(id)?.focus()); }}><Icon name="u-terminal" size={14} /><span class="terminal-tab-name">Shell {id}</span></button><button aria-label={`Close shell ${id}`} disabled={closing().has(id)} onClick={() => void closeSession(id)}><Icon name="menu-cancel" size={13} /></button></div>}</For></div>
      <button class="icon-button terminal-new" aria-label="New terminal" title="New terminal" onClick={() => createSession()}><Icon name="Add" size={14} /></button>
      <div class="terminal-dock-actions">
        <button class="icon-button" aria-label="Copy terminal selection" title="Copy terminal selection" onClick={() => void action(async current => { const text = current.selection(); if (text) await props.clipboard.writeText(text); })}><Icon name="menu-copy" size={14} /></button>
        <button class="icon-button" aria-label="Paste into terminal" title="Paste into terminal" onClick={() => { const id = active(); void action(async current => { const text = await props.clipboard.readText(); if (id !== active() || disposed) throw new Error("Terminal changed before paste completed"); current.paste(text); current.focus(); }); }}><Icon name="menu-paste" size={14} /></button>
        <button class="icon-button terminal-clear" aria-label="Clear terminal display" title="Clear terminal display" onClick={() => void action(current => current.clear())}><Icon name="menu-discard" size={14} /></button>
        <button class="icon-button" aria-label="Interrupt command" title="Interrupt command (Ctrl+C)" onClick={() => void action(current => current.interrupt())}>^C</button>
        <button class="icon-button" aria-label="Hide terminal" title="Hide terminal" onClick={props.onHide}><Icon name="arrow-down4" size={15} /></button>
      </div>
    </header>
    <div class="terminal-dock-cwd" title={props.workspaceRoot}>Started in {props.workspaceRoot || "the default shell directory"}</div>
    {error() && <div role="alert" class="terminal-error">{error()}</div>}
    <For each={tabs()}>{id => {
      const visible = createMemo(() => props.visible && active() === id);
      return <div id={panelId(id)} aria-labelledby={tabId(id)} class="terminal-dock-session" role="tabpanel" style={{ display: active() === id ? "flex" : "none" }}><TerminalPanel fontSize={props.fontSize} fontFamily={props.fontFamily} visible={visible()} embedded label={`Shell ${id}`} workspaceLabel={props.workspaceRoot || "the default shell directory"} transport={props.transport} onReady={value => ready(id, value)} onError={message => fail(id, message)} onHide={() => undefined} /></div>;
    }}</For>
  </section>;
}
