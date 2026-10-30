import { For, Show, batch, createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import Icon, { FileIcon } from "./Icon";
import { NO_PEEK, captureZenLayout, createDoubleEscape, readZenSettings, restoreZenLayout, writeZenSettings, zenChrome, zenClasses, zenPanels, type ZenLayout, type ZenPanels, type ZenPeek, type ZenSettings } from "../lib/zen-mode";
import "../styles/zen.css";

export interface ZenModeOptions<P extends ZenPanels, V extends string, T extends string> {
  panels: Accessor<P>;
  setPanels: (next: P) => void;
  leftView: Accessor<V>;
  setLeftView: (view: V) => void;
  bottomTab: Accessor<T>;
  setBottomTab: (tab: T) => void;
  assistantHeld: Accessor<boolean>;
  setAssistantHeld: (held: boolean) => void;
  agentsMode: Accessor<boolean>;
  /** The agent sidebar is on screen (never in Agents mode). */
  assistantOpen: Accessor<boolean>;
  /** The open file changed: a peeked project panel closes back to zen. */
  activePath: Accessor<string | undefined>;
  /** The window is in OS full screen now. */
  fullscreen: Accessor<boolean>;
  /** Desktop only: enters or leaves OS full screen. */
  setFullscreen?: (on: boolean) => Promise<void>;
  onError?: (message: string) => void;
  /** Settings to start from. Tests pass them; the app reads this device's saved preferences. */
  settings?: ZenSettings;
}

/** Focus targets that stay on screen in zen, first match wins. */
const EDITOR_FOCUS = ".editor-pane.active-group .editor-document[style*='flex'] .cm-content, .editor-pane .editor-document[style*='flex'] .cm-content";
const AGENTS_FOCUS = ".agents-view-layer textarea, .agents-view-layer [role='textbox']";

/** Zen hides the top bar contents and the status bar with CSS, so focus there counts as hidden too. */
function hidden(element: Element): boolean {
  if (!element.isConnected || element.closest(".topbar, .statusbar, [style*='display: none']")) return true;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? !check.call(element) : false;
}

/** Runs a layout change as a short cross fade where the platform supports it, and instantly under reduced motion. */
function transition(update: () => void) {
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = (document as Document & { startViewTransition?: (callback: () => void) => { finished: Promise<void> } }).startViewTransition;
  if (reduce || typeof start !== "function") { update(); return; }
  const root = document.documentElement;
  root.classList.add("zen-transition");
  try { void start.call(document, update).finished.finally(() => root.classList.remove("zen-transition")); }
  catch { root.classList.remove("zen-transition"); update(); }
}

/**
 * Zen mode state for the workbench. The real layout is never written while zen is on: the workbench reads `panels()`
 * instead of its stored panels, panel requests become overlay peeks, and exit restores the snapshot taken on entry.
 */
export function createZenMode<P extends ZenPanels, V extends string, T extends string>(options: ZenModeOptions<P, V, T>) {
  const [active, setActive] = createSignal(false);
  const [peek, setPeek] = createSignal<ZenPeek>(NO_PEEK);
  const [settings, setSettingsState] = createSignal<ZenSettings>(options.settings ?? readZenSettings());
  const [announcement, setAnnouncement] = createSignal("");
  const [revealed, setRevealed] = createSignal(false);
  let snapshot: ZenLayout<V, T> | undefined;
  let enteredFullscreen = false;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;

  const setSettings = (next: ZenSettings) => { setSettingsState(next); writeZenSettings(next); };
  const chrome = () => zenChrome(settings(), { assistantOpen: options.assistantOpen(), agentsMode: options.agentsMode() });
  /** The layout the workbench draws: the stored one outside zen, the zen layout inside it. */
  const panels = (): P => active() ? zenPanels(options.panels(), peek()) : options.panels();

  /** Focus that sat in a panel zen just hid moves to the editor (or the thread on the Agents page). */
  function keepFocus() {
    const current = document.activeElement;
    if (current && current !== document.body && !hidden(current)) return;
    const target = document.querySelector<HTMLElement>(options.agentsMode() ? AGENTS_FOCUS : EDITOR_FOCUS);
    target?.focus({ preventScroll: true });
  }
  function reveal() {
    setRevealed(true);
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => setRevealed(false), 1600);
  }

  function enter() {
    if (active()) return;
    snapshot = captureZenLayout({ panels: options.panels(), leftView: options.leftView(), bottomTab: options.bottomTab(), assistantHeld: options.assistantHeld() });
    transition(() => batch(() => { setPeek(NO_PEEK); setActive(true); }));
    setAnnouncement("Zen mode on. Press Escape twice to leave.");
    reveal();
    requestAnimationFrame(keepFocus);
    if (untrack(settings).fullScreen && options.setFullscreen && !options.fullscreen()) {
      enteredFullscreen = true;
      options.setFullscreen(true).catch(error => { enteredFullscreen = false; options.onError?.(`Could not enter full screen: ${String(error)}`); });
    }
  }
  function exit() {
    if (!active()) return;
    const saved = snapshot; snapshot = undefined;
    transition(() => batch(() => {
      if (saved) {
        const restored = restoreZenLayout(saved, { panels: options.panels() });
        options.setPanels(restored.panels);
        options.setLeftView(restored.leftView);
        options.setBottomTab(restored.bottomTab);
        options.setAssistantHeld(restored.assistantHeld);
      }
      setPeek(NO_PEEK);
      setActive(false);
    }));
    setAnnouncement("Zen mode off.");
    clearTimeout(revealTimer); setRevealed(false);
    if (enteredFullscreen && options.setFullscreen) {
      enteredFullscreen = false;
      options.setFullscreen(false).catch(error => options.onError?.(`Could not leave full screen: ${String(error)}`));
    }
  }
  const toggle = () => active() ? exit() : enter();

  /**
   * A request to show the project panel or bottom dock while zen is on. It opens as an overlay peek and leaves the
   * stored layout alone. Returns false outside zen so the caller applies it normally.
   */
  function requestPanel(kind: keyof ZenPeek, shown: boolean): boolean {
    if (!active()) return false;
    setPeek(current => ({ ...current, [kind]: shown }));
    if (!shown) requestAnimationFrame(keepFocus);
    return true;
  }
  const closeProjectPeek = () => { if (peek().project) requestPanel("project", false); };

  // A peeked project panel (Search, Files) closes once the user is back in the editor or opens a file from it.
  createEffect(on(options.activePath, closeProjectPeek, { defer: true }));
  createEffect(() => {
    if (!active() || !peek().project) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".explorer-panel, [role='menu'], [role='dialog'], .context-menu, .modal-backdrop")) return;
      closeProjectPeek();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("focusin", outside); });
  });

  // Escape twice leaves zen. A press counts only when nothing else answered it: the capture listener sees every
  // press, the bubble listener only those nobody stopped, and the decision waits until all handlers have run.
  const escapes = createDoubleEscape();
  createEffect(() => {
    if (!active()) { escapes.reset(); return; }
    const reached = new WeakSet<KeyboardEvent>();
    const bubble = (event: KeyboardEvent) => { if (event.key === "Escape") reached.add(event); };
    const capture = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.repeat) return;
      const at = event.timeStamp || performance.now();
      setTimeout(() => {
        if (!active()) return;
        const target = event.target instanceof Element ? event.target : undefined;
        // Escape inside a peeked panel closes the peek, nothing more.
        if (!event.defaultPrevented && reached.has(event) && peek().project && target?.closest(".explorer-panel")) { escapes.reset(); closeProjectPeek(); return; }
        const consumed = event.defaultPrevented || !reached.has(event) || !!document.querySelector("[aria-modal='true']");
        if (escapes.press(consumed, at)) exit();
      });
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    onCleanup(() => { window.removeEventListener("keydown", capture, true); window.removeEventListener("keydown", bubble); });
  });
  onCleanup(() => clearTimeout(revealTimer));

  return {
    active,
    peek,
    panels,
    settings,
    setSettings,
    chrome,
    announcement,
    revealed,
    enter,
    exit,
    toggle,
    requestPanel,
    /** Class names for the workbench root. */
    classes: () => `${zenClasses(active(), chrome(), options.agentsMode())}${active() && revealed() ? " zen-revealed" : ""}${active() && peek().project ? " zen-peek-project" : ""}`,
  };
}

export type ZenMode = ReturnType<typeof createZenMode>;

/**
 * The only chrome left in zen: a drag strip along the top edge with a small pill naming the open file and an exit
 * button. The pill shows while the pointer is at the top edge, while it has focus, and briefly on entry.
 */
export function ZenChrome(props: { zen: ZenMode; title: string; path?: string; shortcut?: string }) {
  return <>
    <div class="zen-live" role="status" aria-live="polite">{props.zen.announcement()}</div>
    <Show when={props.zen.active()}>
      <div class="zen-edge" data-tauri-drag-region>
        <div class="zen-pill">
          <Show when={props.path} fallback={<Icon name="Code1" size={13} />}>{path => <FileIcon path={path()} />}</Show>
          <span class="zen-pill-title" title={props.path ?? props.title}>{props.title}</span>
          <button type="button" class="zen-exit" aria-label="Exit Zen mode" title={props.shortcut ? `Exit Zen mode (${props.shortcut}, or Escape twice)` : "Exit Zen mode (Escape twice)"} onClick={() => props.zen.exit()}>
            <Icon name="ZenExit" size={13} />
          </button>
        </div>
      </div>
    </Show>
  </>;
}

const ZEN_ROWS: { key: keyof ZenSettings; label: string; help: string }[] = [
  { key: "hideTabs", label: "Hide editor tabs", help: "Zen mode hides the tab strip. Switch files with Go to File or Toggle Files." },
  { key: "hideLineNumbers", label: "Hide line numbers", help: "Zen mode hides the line number gutter. Run and fold markers stay." },
  { key: "centerLayout", label: "Center the editor", help: "With the AI Assistant closed, zen mode centers the editor at a comfortable reading width." },
  { key: "fullScreen", label: "Enter full screen", help: "Zen mode also enters full screen in the desktop app, and leaves it again on exit." },
];

/** Settings > Appearance rows. Saved on this device, not in settings.jsonc. */
export function ZenModeSettings(props: { value: ZenSettings; onChange: (next: ZenSettings) => void; shortcut?: string }) {
  return <section class="sp-preferences zen-settings" aria-labelledby="zen-settings-heading">
    <div class="sp-group-heading"><h2 id="zen-settings-heading">Zen mode</h2></div>
    <p class="sp-help">Show only the editor and the AI Assistant.{props.shortcut ? ` Toggle with ${props.shortcut}, leave with Escape twice.` : " Leave with Escape twice."}</p>
    <For each={ZEN_ROWS}>{row => {
      const id = `zen-${row.key}`;
      return <div class="sp-preference">
        <div class="sp-preference-label"><label for={id}>{row.label}</label><p id={`${id}-help`}>{row.help}</p><span class="sp-setting-path">Saved on this device</span></div>
        <div class="sp-preference-control"><button id={id} class="sp-switch" role="switch" aria-label={row.label} aria-describedby={`${id}-help`} aria-checked={props.value[row.key]} onClick={() => props.onChange({ ...props.value, [row.key]: !props.value[row.key] })}><span /></button></div>
      </div>;
    }}</For>
  </section>;
}
