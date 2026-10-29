import { For, Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { TerminalProfile } from "../bindings";
import Icon from "./Icon";

/** Discovers installed executables on demand. Selecting a row starts one shell. */
export function TerminalProfilePicker(props: {
  loadProfiles?: () => Promise<TerminalProfile[]>;
  onCreate(profileId: string): void;
  onError(cause: unknown): void;
}) {
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [profiles, setProfiles] = createSignal<TerminalProfile[]>([]);
  const [position, setPosition] = createSignal({ top: "0px", left: "0px", "max-height": "320px", width: "290px" });
  const systemName = navigator.platform.startsWith("Mac") ? "macOS" : navigator.platform.startsWith("Win") ? "Windows" : "Linux";
  const id = `terminal-profiles-${createUniqueId()}`;
  let trigger!: HTMLButtonElement;
  let popup: HTMLDivElement | undefined;
  let disposed = false;
  let request = 0;
  const rows = () => [...(popup?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
  const close = (restore = false) => { request++; setOpen(false); setLoading(false); if (restore) trigger.focus(); };
  function place() {
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const rect = trigger.getBoundingClientRect();
    const bounds = { top: rect.top / zoom, bottom: rect.bottom / zoom, left: rect.left / zoom };
    const viewportWidth = window.innerWidth / zoom;
    const below = window.innerHeight / zoom - bounds.bottom - 8;
    const above = bounds.top - 8;
    const desired = Math.min(320, popup?.scrollHeight || 80);
    const flip = below < desired && above > below;
    const height = Math.min(320, Math.max(0, flip ? above : below));
    const width = Math.min(290, viewportWidth - 16);
    setPosition({ top: `${flip ? bounds.top - Math.min(desired, height) - 4 : bounds.bottom + 4}px`, left: `${Math.max(8, Math.min(bounds.left, viewportWidth - width - 8))}px`, "max-height": `${height}px`, width: `${width}px` });
  }
  async function show() {
    if (!props.loadProfiles) return;
    const token = ++request;
    setOpen(true); setLoading(true); queueMicrotask(() => { if (!disposed && open()) place(); });
    try {
      const available = await props.loadProfiles();
      if (disposed || token !== request) return;
      setProfiles(available); setLoading(false);
      queueMicrotask(() => { if (!disposed && open()) { place(); rows()[0]?.focus(); } });
    } catch (cause) { if (!disposed && token === request) { close(true); props.onError(cause); } }
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === "Escape" && open()) { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open()) { void show(); return; }
      const list = rows(); const index = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Tab") close();
  }
  onMount(() => {
    const outside = (event: PointerEvent) => { if (!trigger.contains(event.target as Node) && !popup?.contains(event.target as Node)) close(); };
    const blur = () => close();
    const viewport = () => { if (open()) place(); };
    const zoomObserver = new MutationObserver(viewport);
    zoomObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    document.addEventListener("pointerdown", outside, true); window.addEventListener("blur", blur); window.addEventListener("resize", viewport);
    onCleanup(() => { disposed = true; request++; zoomObserver.disconnect(); document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); window.removeEventListener("resize", viewport); });
  });
  return <><button ref={trigger} class="icon-button terminal-profile-trigger" aria-label="Choose terminal shell" title="Choose terminal shell" aria-haspopup="menu" aria-controls={id} aria-expanded={open()} disabled={!props.loadProfiles} onKeyDown={keyboard} onClick={() => open() ? close() : void show()}><Icon name="arrow-down4" size={12} /></button>
    <Show when={open()}><Portal mount={trigger.closest(".ide") || document.body}><div ref={popup} id={id} class="terminal-profile-menu" role="menu" aria-label="Installed terminal shells" style={position()} onKeyDown={keyboard}>
      <div class="terminal-profile-title"><span>New terminal</span><Show when={systemName === "macOS"} fallback={<small>{systemName}</small>}><span class="terminal-platform-mark" role="img" aria-label="macOS" title="macOS" /></Show></div>
      <Show when={loading()} fallback={<><For each={profiles()}>{profile => <button role="menuitem" title={profile.path} onClick={() => { close(); props.onCreate(profile.id); }}><Icon name="u-terminal" size={14} /><span><strong>{profile.name}<Show when={profile.isDefault}><span class="terminal-profile-default">Default</span></Show></strong><small>{profile.path}</small></span></button>}</For><Show when={!profiles().length}><div class="terminal-profile-empty">No installed shells found</div></Show></>}><div class="terminal-profile-empty" role="status">Finding installed shells…</div></Show>
    </div></Portal></Show></>;
}
