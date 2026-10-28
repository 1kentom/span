import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { RUN_TEXT } from "../../lib/agent-hint-text";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { HistoryScope, SessionRow } from "./types";
import { arrowFocus, useEscape } from "./util";

export type SessionGroup = { label: "Today" | "Yesterday" | "Earlier"; rows: SessionRow[] };

const startOfDay = (now: number, daysBack = 0) => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - daysBack);
  return day.getTime();
};

/** Buckets rows by local calendar day, newest first. Empty groups are dropped. */
export function groupSessions(rows: SessionRow[], now: number): SessionGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(now, 1);
  const groups: SessionGroup[] = [
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const row of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
    groups[row.updatedAt >= today ? 0 : row.updatedAt >= yesterday ? 1 : 2].rows.push(row);
  }
  return groups.filter((group) => group.rows.length);
}

/** The row time: a clock time for Today and Yesterday, a short date for earlier days, nothing when unknown. */
export function historyTime(updatedAt: number, now: number): string {
  if (!(updatedAt > 0)) return "";
  const date = new Date(updatedAt);
  return updatedAt >= startOfDay(now, 1) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Wraps every case-insensitive match of `query` in a mark. */
function highlight(text: string, query: string): JSX.Element {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const parts: JSX.Element[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark class="sb-hl">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "3 agents · 2 files" from what the row's metadata knows. One agent is already shown by its avatar. */
function metaLine(row: SessionRow): string {
  const parts: string[] = [];
  if ((row.agents?.length ?? 0) > 1) parts.push(plural(row.agents!.length, "agent"));
  if (row.files) parts.push(plural(row.files, "file"));
  return parts.join(" · ");
}

/** Idle is the normal state of a held chat, so it shows only when prompts wait in its queue. */
const showsState = (row: SessionRow) => Boolean(row.status && (row.status.kind !== "idle" || row.status.label !== RUN_TEXT.idle));

type HistoryListProps = {
  rows: SessionRow[];
  query: string;
  onQuery: (query: string) => void;
  /**
   * Scope filter. The control appears only when `onScope` is given, which a caller should do only when it really has
   * sessions from other folders to show. Without it every row given is shown.
   */
  scope?: HistoryScope;
  onScope?: (scope: HistoryScope) => void;
  /** Epoch milliseconds used for grouping and times. Defaults to now. */
  now?: number;
  formatTime?: (row: SessionRow) => string;
  /** Opens or resumes a row: a click anywhere on a row that is not locked. */
  onOpen: (id: string) => void;
  /** Menu entries appear only for the callbacks the app supplies. Rename is also F2 on a focused row. */
  onRename?: (id: string, title: string) => void;
  onCopyId?: (id: string) => void;
  /** Delete appears only when supplied, and is also Backspace or Delete on a focused row. The row asks before calling it. */
  onDelete?: (id: string) => void;
  /** Close appears only when supplied, and only on the current session. */
  onClose?: (id: string) => void;
};

/** Opens a row's menu from the keyboard: the context menu key or Shift+F10, as for a native context menu. */
const isMenuKey = (event: KeyboardEvent) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

/** Earlier sessions: search, scope and agent filters, day groups, locked rows and a per-row menu. */
export function HistoryList(props: HistoryListProps) {
  const [menu, setMenu] = createSignal<string>();
  const [renaming, setRenaming] = createSignal<string>();
  const [draft, setDraft] = createSignal("");
  const [confirming, setConfirming] = createSignal<string>();
  const [agentFilter, setAgentFilter] = createSignal<string>();
  const [agentMenu, setAgentMenu] = createSignal(false);
  const inScope = createMemo(() => props.rows.filter((row) => !props.onScope || props.scope === "all" || row.inWorkspace));
  /** The agents present in the rows, in order of first appearance among the newest rows. */
  const agentsPresent = createMemo(() => {
    const found = new Map<string, string>();
    for (const row of [...inScope()].sort((a, b) => b.updatedAt - a.updatedAt)) for (const agent of row.agents ?? []) if (!found.has(agent.id)) found.set(agent.id, agent.name);
    return [...found].map(([id, name]) => ({ id, name }));
  });
  const activeAgent = () => agentsPresent().find((agent) => agent.id === agentFilter());
  const visible = createMemo(() => {
    const query = props.query.trim().toLowerCase();
    const agent = activeAgent()?.id;
    return inScope().filter(
      (row) =>
        (!agent || row.agents?.some((entry) => entry.id === agent)) &&
        (!query ||
          row.title.toLowerCase().includes(query) ||
          row.models?.some((model) => model.toLowerCase().includes(query)) ||
          row.agents?.some((entry) => entry.name.toLowerCase().includes(query))),
    );
  });
  const now = () => props.now ?? Date.now();
  const groups = createMemo(() => groupSessions(visible(), now()));
  const time = (row: SessionRow) => (props.formatTime ? props.formatTime(row) : historyTime(row.updatedAt, now()));
  /** Where focus goes back to when the menu is dismissed with Escape. */
  let menuReturn: HTMLElement | undefined;
  const hasMenu = (row: SessionRow) => Boolean(props.onRename || props.onCopyId || props.onDelete || (props.onClose && row.current));
  const openMenu = (row: SessionRow, from?: HTMLElement) => {
    if (!hasMenu(row)) return;
    menuReturn = from;
    setMenu(row.id);
  };
  useEscape(() => {
    setMenu(undefined);
    menuReturn?.focus();
  }, () => menu() !== undefined);
  useEscape(() => setAgentMenu(false), () => agentMenu());
  useEscape(() => setConfirming(undefined), () => confirming() !== undefined && menu() === undefined);
  const startRename = (row: SessionRow) => {
    setMenu(undefined);
    setDraft(row.title);
    setRenaming(row.id);
  };
  const commitRename = (id: string) => {
    const title = draft().trim();
    setRenaming(undefined);
    if (title) props.onRename?.(id, title);
  };
  const rowKeys = (row: SessionRow, event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (isMenuKey(event)) {
      event.preventDefault();
      openMenu(row, event.currentTarget);
    } else if (event.key === "F2" && props.onRename) {
      event.preventDefault();
      startRename(row);
    } else if ((event.key === "Backspace" || event.key === "Delete") && props.onDelete) {
      event.preventDefault();
      setConfirming(row.id);
    }
  };
  /** Clicks on the row's own controls (actions button, menu, confirm, rename field) do not open it. */
  const openFromRow = (row: SessionRow, event: MouseEvent) => {
    if (row.locked || renaming() === row.id || confirming() === row.id) return;
    if (event.target instanceof Element && event.target.closest(".row-menu, .sb-menu, .sb-confirm, input")) return;
    props.onOpen(row.id);
  };
  const scopes: { id: HistoryScope; label: string }[] = [
    { id: "workspace", label: "This workspace" },
    { id: "all", label: "All folders" },
  ];
  const empty = () => (props.query.trim() ? `No sessions match “${props.query.trim()}”.` : "No earlier sessions in this workspace yet.");
  return (
    <section class="sb-history" aria-label="Earlier sessions">
      <div class="sb-history-tools">
        <label class="sb-search">
          <Icon name="SearchNormal1" size={13} />
          <input type="search" aria-label="Search sessions" placeholder="Search sessions" value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} />
        </label>
        <Show when={props.onScope || agentsPresent().length > 1}>
          <div class="sb-history-filters">
            <Show when={props.onScope}>
              <div class="sb-seg" role="group" aria-label="Session scope">
                <For each={scopes}>
                  {(scope) => (
                    <button class="sb-pill" classList={{ on: props.scope === scope.id }} aria-pressed={props.scope === scope.id} onClick={() => props.onScope?.(scope.id)}>
                      {scope.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <span class="sb-flex" />
            <Show when={agentsPresent().length > 1}>
              <div class="sb-agent-filter-wrap">
                <button class="sb-pill sb-agent-filter" classList={{ on: Boolean(activeAgent()) }} aria-haspopup="menu" aria-expanded={agentMenu()} onClick={() => setAgentMenu(!agentMenu())}>
                  <span>{activeAgent()?.name ?? "All agents"}</span>
                  <Icon name="arrow-down4" size={9} />
                </button>
                <Show when={agentMenu()}>
                  <div class="sb-menu sb-agent-menu" role="menu" aria-label="Filter by agent" onKeyDown={(event) => arrowFocus(event, event.currentTarget, "[role='menuitemradio']")} ref={(el) => queueMicrotask(() => el.querySelector<HTMLElement>("[aria-checked='true']")?.focus())}>
                    <For each={[{ id: undefined as string | undefined, name: "All agents" }, ...agentsPresent()]}>
                      {(agent) => (
                        <button
                          class="sb-menu-item"
                          role="menuitemradio"
                          aria-checked={activeAgent()?.id === agent.id}
                          onClick={() => {
                            setAgentFilter(agent.id);
                            setAgentMenu(false);
                          }}
                        >
                          <Show when={agent.id} fallback={<span class="sb-menu-glyph" />}>
                            <BrandIcon id={agent.id} name={agent.name} size={12} />
                          </Show>
                          <span class="sb-menu-label">{agent.name}</span>
                          <Show when={activeAgent()?.id === agent.id}>
                            <Icon name="Check" size={12} />
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={groups().length} fallback={<p class="sb-history-empty" role="status">{empty()}</p>}>
        <For each={groups()}>
          {(group) => (
            <div class="sb-group sb-history-group" role="group" aria-label={group.label}>
              <div class="sb-eyebrow">{group.label}</div>
              <For each={group.rows}>
                {(row) => (
                  <div
                    class="sb-session"
                    classList={{ locked: row.locked, live: Boolean(row.status && row.status.kind !== "idle"), attention: Boolean(row.status?.attention), open: menu() === row.id }}
                    onClick={(event) => openFromRow(row, event)}
                    onContextMenu={(event) => {
                      if (renaming() === row.id || !hasMenu(row)) return;
                      event.preventDefault();
                      openMenu(row, event.currentTarget.querySelector<HTMLElement>(".sb-session-main:not(:disabled), .row-menu") ?? undefined);
                    }}
                  >
                    <span class="sb-avatars" title={row.agents?.length ? row.agents.map((agent) => agent.name).join(", ") : row.brand?.name}>
                      <Show when={row.agents?.length} fallback={<BrandIcon id={row.brand?.id} name={row.brand?.name} size={14} />}>
                        <For each={row.agents}>{(agent) => <BrandIcon id={agent.id} name={agent.name} size={14} />}</For>
                      </Show>
                    </span>
                    <span class="sb-session-body">
                      <Show
                        when={renaming() === row.id}
                        fallback={
                          <button
                            class="sb-session-main"
                            disabled={row.locked}
                            aria-disabled={row.locked}
                            aria-label={row.status && showsState(row) ? `${row.title}, ${row.status.label}` : undefined}
                            aria-keyshortcuts={[props.onRename ? "F2" : "", props.onDelete ? "Backspace" : ""].filter(Boolean).join(" ") || undefined}
                            onKeyDown={(event) => rowKeys(row, event)}
                          >
                            <span class="sb-session-title">
                              <span class="sb-ellipsis">{highlight(row.title, props.query)}</span>
                              <Show when={row.current}>
                                <span class="sb-tag">Current</span>
                              </Show>
                            </span>
                            <Show when={showsState(row) && row.status}>
                              {(status) => (
                                <span class={`sb-session-state sb-badge ${status().kind}`} classList={{ attention: status().attention }}>
                                  <Show when={status().kind !== "idle"}>
                                    <span class="sb-dot" aria-hidden="true" />
                                  </Show>
                                  {status().label}
                                </span>
                              )}
                            </Show>
                            <Show when={row.models?.length}>
                              <span class="sb-chips inline">
                                <For each={row.models}>{(model) => <span class="sb-chip mono">{highlight(model, props.query)}</span>}</For>
                              </span>
                            </Show>
                            <Show when={metaLine(row) || row.delta}>
                              <span class="sb-session-meta">
                                <Show when={metaLine(row)}>
                                  <span>{metaLine(row)}</span>
                                </Show>
                                <Show when={row.delta}>
                                  {(delta) => (
                                    <span class="sb-delta sb-mono">
                                      <span class="add">+{delta().add}</span>
                                      <span class="del">{"−"}{delta().del}</span>
                                    </span>
                                  )}
                                </Show>
                              </span>
                            </Show>
                            <Show when={row.locked}>
                              <span class="sb-session-note">Read-only. This agent doesn't support session/load.</span>
                            </Show>
                          </button>
                        }
                      >
                        <input
                          class="sb-input sb-flex"
                          aria-label="Session name"
                          value={draft()}
                          ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                          onInput={(event) => setDraft(event.currentTarget.value)}
                          onBlur={() => setRenaming(undefined)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename(row.id);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              setRenaming(undefined);
                            }
                          }}
                        />
                      </Show>
                    </span>
                    <span class="sb-session-side">
                      <span class="sb-session-time">{time(row)}</span>
                      <Show when={hasMenu(row) && renaming() !== row.id && confirming() !== row.id}>
                        <button
                          class="sb-icon-btn row-menu"
                          aria-label={`Actions for ${row.title}`}
                          title="Session actions"
                          aria-haspopup="menu"
                          aria-expanded={menu() === row.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (menu() === row.id) setMenu(undefined);
                            else openMenu(row, event.currentTarget);
                          }}
                          onKeyDown={(event) => {
                            if (!isMenuKey(event)) return;
                            event.preventDefault();
                            openMenu(row, event.currentTarget);
                          }}
                        >
                          <Icon name="3DotsMore" size={13} />
                        </button>
                      </Show>
                    </span>
                    <Show when={confirming() === row.id}>
                      <div class="sb-confirm" role="alertdialog" aria-label={`Delete ${row.title}`}>
                        <span class="sb-confirm-text">Delete this chat? It cannot be undone.</span>
                        <button class="sb-btn" onClick={() => setConfirming(undefined)}>Cancel</button>
                        <button class="sb-btn danger" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => { setConfirming(undefined); props.onDelete?.(row.id); }}>Delete</button>
                      </div>
                    </Show>
                    <Show when={menu() === row.id}>
                      <div class="sb-menu sb-row-menu" role="menu" aria-label="Session actions" onKeyDown={(event) => arrowFocus(event, event.currentTarget, "[role='menuitem']")} ref={(el) => queueMicrotask(() => el.querySelector<HTMLElement>("[role='menuitem']")?.focus())}>
                        <Show when={props.onRename}>
                          <button class="sb-menu-item" role="menuitem" onClick={() => startRename(row)}>
                            <Icon name="ActionRename" size={12} />
                            <span class="sb-menu-label">Rename</span>
                            <span class="sb-menu-key">F2</span>
                          </button>
                        </Show>
                        <Show when={props.onCopyId}>
                          <button class="sb-menu-item" role="menuitem" onClick={() => { setMenu(undefined); props.onCopyId?.(row.id); }}>
                            <Icon name="Copy" size={12} />
                            <span class="sb-menu-label">Copy session ID</span>
                          </button>
                        </Show>
                        <Show when={(props.onClose && row.current) || props.onDelete}>
                          <Show when={props.onRename || props.onCopyId}>
                            <div class="sb-menu-sep" role="separator" />
                          </Show>
                          <Show when={props.onClose && row.current}>
                            <button class="sb-menu-item" role="menuitem" onClick={() => { setMenu(undefined); props.onClose?.(row.id); }}>
                              <Icon name="CloseCircle" size={12} />
                              <span class="sb-menu-label">Close session</span>
                            </button>
                          </Show>
                          <Show when={props.onDelete}>
                            <button class="sb-menu-item danger" role="menuitem" onClick={() => { setMenu(undefined); setConfirming(row.id); }}>
                              <Icon name="Trash" size={12} />
                              <span class="sb-menu-label">Delete</span>
                              <span class="sb-menu-key">{"⌫"}</span>
                            </button>
                          </Show>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}
