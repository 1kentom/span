import { For, Show, createMemo, createSignal } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { HistoryScope, SessionRow } from "./types";
import { arrowFocus, useEscape } from "./util";

export type SessionGroup = { label: "Today" | "Yesterday" | "Earlier"; rows: SessionRow[] };

/** Buckets rows by local calendar day, newest first. Empty groups are dropped. */
export function groupSessions(rows: SessionRow[], now: number): SessionGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups: SessionGroup[] = [
    { label: "Today", rows: [] },
    { label: "Yesterday", rows: [] },
    { label: "Earlier", rows: [] },
  ];
  for (const row of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
    groups[row.updatedAt >= today ? 0 : row.updatedAt >= yesterday.getTime() ? 1 : 2].rows.push(row);
  }
  return groups.filter((group) => group.rows.length);
}

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
  /** Epoch milliseconds used for grouping. Defaults to now. */
  now?: number;
  formatTime?: (row: SessionRow) => string;
  onOpen: (id: string) => void;
  /** Menu entries appear only for the callbacks the app supplies. */
  onRename?: (id: string, title: string) => void;
  onCopyId?: (id: string) => void;
  /** Delete appears only when supplied. The row asks for confirmation inline before calling it. */
  onDelete?: (id: string) => void;
  /** Close appears only when supplied, and only on the current session. */
  onClose?: (id: string) => void;
};

const defaultTime = (row: SessionRow) => new Date(row.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Earlier sessions: search, scope filter, day groups, locked rows and a per-row menu. */
export function HistoryList(props: HistoryListProps) {
  const [menu, setMenu] = createSignal<string>();
  const [renaming, setRenaming] = createSignal<string>();
  const [draft, setDraft] = createSignal("");
  const [confirming, setConfirming] = createSignal<string>();
  const visible = createMemo(() => {
    const query = props.query.trim().toLowerCase();
    return props.rows.filter(
      (row) =>
        (!props.onScope || props.scope === "all" || row.inWorkspace) &&
        (!query || row.title.toLowerCase().includes(query) || row.models?.some((model) => model.toLowerCase().includes(query))),
    );
  });
  const groups = createMemo(() => groupSessions(visible(), props.now ?? Date.now()));
  const hasMenu = () => Boolean(props.onRename || props.onCopyId || props.onDelete || props.onClose);
  useEscape(() => setMenu(undefined), () => menu() !== undefined);
  useEscape(() => setConfirming(undefined), () => confirming() !== undefined && menu() === undefined);
  const commitRename = (id: string) => {
    const title = draft().trim();
    setRenaming(undefined);
    if (title) props.onRename?.(id, title);
  };
  const scopes: { id: HistoryScope; label: string }[] = [
    { id: "workspace", label: "This workspace" },
    { id: "all", label: "All folders" },
  ];
  return (
    <section class="sb-history" aria-label="Earlier sessions">
      <div class="sb-history-tools">
        <label class="sb-search">
          <Icon name="SearchNormal1" size={13} />
          <input type="search" aria-label="Search sessions" placeholder="Search sessions" value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} />
        </label>
        <Show when={props.onScope}>
          <div class="sb-seg" role="group" aria-label="Session scope">
            <For each={scopes}>
              {(scope) => (
                <button class="sb-pill" classList={{ on: props.scope === scope.id }} aria-pressed={props.scope === scope.id} onClick={() => props.onScope?.(scope.id)}>{scope.label}</button>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={groups().length} fallback={<p class="sb-sub pad" role="status">No sessions found.</p>}>
        <For each={groups()}>
          {(group) => (
            <div class="sb-group" role="group" aria-label={group.label}>
              <div class="sb-eyebrow">{group.label}</div>
              <For each={group.rows}>
                {(row) => (
                  <div class="sb-session" classList={{ locked: row.locked, live: Boolean(row.status && row.status.kind !== "idle"), attention: Boolean(row.status?.attention) }}>
                    <Show
                      when={renaming() === row.id}
                      fallback={
                        <button class="sb-session-main" disabled={row.locked} aria-disabled={row.locked} aria-label={row.status ? `${row.title}, ${row.status.label}` : undefined} onClick={() => props.onOpen(row.id)}>
                          <span class="sb-session-brand"><BrandIcon id={row.brand?.id} name={row.brand?.name} size={14} /></span>
                          <span class="sb-option-text">
                            <span class="sb-session-title">
                              <span class="sb-ellipsis">{row.title}</span>
                              <Show when={row.current}><span class="sb-tag">Current</span></Show>
                            </span>
                            <Show when={row.models?.length}>
                              <span class="sb-chips inline">
                                <For each={row.models}>{(model) => <span class="sb-chip mono">{model}</span>}</For>
                              </span>
                            </Show>
                            <Show when={row.status}>
                              {(status) => (
                                <span class={`sb-session-state ${status().kind}`} classList={{ attention: status().attention }}>
                                  <Show when={status().kind !== "idle"}><span class="sb-dot" aria-hidden="true" /></Show>
                                  {status().label}
                                </span>
                              )}
                            </Show>
                            <span class="sb-session-meta">
                              <span>{row.meta}</span>
                              <Show when={row.delta}><span class="sb-delta sb-mono"><span class="add">+{row.delta!.add}</span><span class="del">-{row.delta!.del}</span></span></Show>
                            </span>
                            <Show when={row.locked}><span class="sb-sub">Read-only. This agent doesn't support session/load.</span></Show>
                          </span>
                          <span class="sb-session-time">{(props.formatTime ?? defaultTime)(row)}</span>
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
                    <Show when={confirming() === row.id}>
                      <div class="sb-confirm" role="alertdialog" aria-label={`Delete ${row.title}`}>
                        <span class="sb-confirm-text">Delete this chat? It cannot be undone.</span>
                        <button class="sb-btn" onClick={() => setConfirming(undefined)}>Cancel</button>
                        <button class="sb-btn danger" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => { setConfirming(undefined); props.onDelete?.(row.id); }}>Delete</button>
                      </div>
                    </Show>
                    <Show when={hasMenu() && renaming() !== row.id && confirming() !== row.id}>
                      <button class="sb-icon-btn row-menu" aria-label={`Actions for ${row.title}`} aria-haspopup="menu" aria-expanded={menu() === row.id} onClick={() => setMenu(menu() === row.id ? undefined : row.id)}>
                        <Icon name="3DotsMore" size={13} />
                      </button>
                    </Show>
                    <Show when={menu() === row.id}>
                      <div class="sb-menu" role="menu" aria-label="Session actions" onKeyDown={(event) => arrowFocus(event, event.currentTarget, "[role='menuitem']")} ref={(el) => queueMicrotask(() => el.querySelector<HTMLElement>("[role='menuitem']")?.focus())}>
                        <Show when={props.onRename}>
                          <button class="sb-menu-item" role="menuitem" onClick={() => { setMenu(undefined); setDraft(row.title); setRenaming(row.id); }}>
                            <Icon name="Edit2" size={12} /><span>Rename</span>
                          </button>
                        </Show>
                        <Show when={props.onClose && row.current}>
                          <button class="sb-menu-item" role="menuitem" onClick={() => { setMenu(undefined); props.onClose?.(row.id); }}>
                            <Icon name="CloseCircle" size={12} /><span>Close session</span>
                          </button>
                        </Show>
                        <Show when={props.onDelete}>
                          <button class="sb-menu-item" role="menuitem" onClick={() => { setMenu(undefined); setConfirming(row.id); }}>
                            <Icon name="Trash" size={12} /><span>Delete</span>
                          </button>
                        </Show>
                        <Show when={props.onCopyId}>
                          <button class="sb-menu-item" role="menuitem" onClick={() => { setMenu(undefined); props.onCopyId?.(row.id); }}>
                            <Icon name="Copy" size={12} /><span>Copy session ID</span>
                          </button>
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
