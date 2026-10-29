import { type JSX, For, batch, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import Icon from "./Icon";
import type { TerminalCommandLanguage } from "../bindings";
import { TerminalProfilePicker } from "./TerminalProfilePicker";
import { TerminalPanel, type TerminalController, type TerminalTransport } from "./TerminalPanel";

export interface TerminalDockController {
  send(code: string, execute: boolean, language?: string): Promise<void>;
  /** Opens a new shell in an absolute workspace folder (Explorer "Open in Terminal"). */
  openAt(directory: string): void;
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
  const configurations = new Map<number, { command?: { language: TerminalCommandLanguage; code: string }; profileId?: string; directory?: string }>();
  const [shells, setShells] = createSignal<Record<number, string>>({});
  const shellName = (shell: string) => shell.split(/[\\/]/).at(-1) || shell;
  const workspaceName = () => props.workspaceRoot.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || props.workspaceRoot || "Default directory";
  const tabLabel = (id: number) => { const command = configurations.get(id)?.command; return command ? `${command.language === "bash" ? "Bash" : command.language === "zsh" ? "Zsh" : command.language === "sh" ? "Sh" : shells()[id] ? shellName(shells()[id]) : "Shell"} command ${id}` : shells()[id] ? shellName(shells()[id]) : `Shell ${id}`; };
  const controllers = new Map<number, TerminalController>();
  const failures = new Map<number, string>();
  const waiters = new Map<number, { resolve(controller: TerminalController): void; reject(error: Error): void }[]>();
  let next = 1;
  let disposed = false;
  function createSession(configuration: { command?: { language: TerminalCommandLanguage; code: string }; profileId?: string; directory?: string } = {}) { const id = next++; configurations.set(id, configuration); batch(() => { setTabs(current => [...current, id]); setActive(id); }); return id; }
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
        configurations.delete(id); setShells(current => { const result = { ...current }; delete result[id]; return result; });
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
    openAt(directory) {
      if (disposed) throw new Error("Terminal workspace is no longer available");
      createSession({ directory }); props.onReveal();
    },
    async send(code, execute, requestedLanguage = "shell") {
      if (disposed) throw new Error("Terminal workspace is no longer available");
      const language: TerminalCommandLanguage = requestedLanguage === "bash" || requestedLanguage === "zsh" || requestedLanguage === "sh" ? requestedLanguage : "shell";
      const id = createSession(execute ? { command: { language, code } } : {}); props.onReveal();
      const current = await controller(id);
      if (!execute) await current.send(code, false, language);
    },
  };
  createEffect(() => { if (props.visible && !tabs().length) createSession(); });
  onMount(() => props.onReady?.(commands));
  onCleanup(() => { disposed = true; props.onReady?.(undefined); for (const id of waiters.keys()) fail(id, "Terminal workspace was closed"); });
  return <section class="panel terminal-dock" aria-label="Terminal">
    <header class="terminal-dock-toolbar">
      {props.headerStart}
      <div ref={tablist} class="terminal-dock-tabs" role="tablist" aria-label="Terminal sessions"><For each={tabs()}>{id => <div class="terminal-dock-tab" classList={{ active: active() === id }}><button id={tabId(id)} role="tab" tabIndex={active() === id ? 0 : -1} aria-selected={active() === id} aria-controls={panelId(id)} onKeyDown={event => navigateTabs(event, id)} onClick={() => { setActive(id); queueMicrotask(() => controllers.get(id)?.focus()); }}><Icon name="u-terminal" size={14} /><span class="terminal-tab-name" title={shells()[id]}>{tabLabel(id)}</span></button><button aria-label={`Close shell ${id}`} disabled={closing().has(id)} onClick={() => void closeSession(id)}><Icon name="menu-cancel" size={13} /></button></div>}</For></div>
      <button class="icon-button terminal-new" aria-label="New terminal" title="New terminal" onClick={() => createSession()}><Icon name="Add" size={14} /></button>
      <TerminalProfilePicker loadProfiles={props.transport.profiles} onCreate={profileId => createSession({ profileId })} onError={report} />
      <span class="terminal-dock-context" title={props.workspaceRoot} aria-label={`Working directory: ${props.workspaceRoot || "default shell directory"}`}>{workspaceName()}</span>
      <div class="terminal-dock-actions">
        <button class="icon-button" aria-label="Copy terminal selection" title="Copy terminal selection" onClick={() => void action(async current => { const text = current.selection(); if (text) await props.clipboard.writeText(text); })}><Icon name="menu-copy" size={14} /></button>
        <button class="icon-button" aria-label="Paste into terminal" title="Paste into terminal" onClick={() => { const id = active(); void action(async current => { const text = await props.clipboard.readText(); if (id !== active() || disposed) throw new Error("Terminal changed before paste completed"); current.paste(text); current.focus(); }); }}><Icon name="menu-paste" size={14} /></button>
        <button class="icon-button terminal-clear" aria-label="Clear terminal display" title="Clear terminal display" onClick={() => void action(current => current.clear())}><Icon name="menu-discard" size={14} /></button>
        <button class="icon-button" aria-label="Interrupt command" title="Interrupt command (Ctrl+C)" onClick={() => void action(current => current.interrupt())}>^C</button>
        <button class="icon-button" aria-label="Hide terminal" title="Hide terminal" onClick={props.onHide}><Icon name="arrow-down4" size={15} /></button>
      </div>
    </header>
    {error() && <div role="alert" class="terminal-error">{error()}</div>}
    <For each={tabs()}>{id => {
      const visible = createMemo(() => props.visible && active() === id);
      return <div id={panelId(id)} aria-labelledby={tabId(id)} class="terminal-dock-session" role="tabpanel" style={{ display: active() === id ? "flex" : "none" }}><TerminalPanel command={configurations.get(id)?.command} profileId={configurations.get(id)?.profileId} directory={configurations.get(id)?.directory} onShell={shell => setShells(current => ({ ...current, [id]: shell }))} onRunCommand={(code, language) => commands.send(code, true, language)} fontSize={props.fontSize} fontFamily={props.fontFamily} visible={visible()} embedded label={`Shell ${id}`} workspaceLabel={props.workspaceRoot || "the default shell directory"} transport={props.transport} onReady={value => ready(id, value)} onError={message => fail(id, message)} onHide={() => undefined} /></div>;
    }}</For>
  </section>;
}
