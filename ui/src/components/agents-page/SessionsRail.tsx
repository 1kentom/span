import { For, Show, createEffect, createMemo, createSignal, createUniqueId, type JSX } from "solid-js";
import { groupRail, railNav, railOrder, railTime, type RailRow } from "../../lib/agents-page";
import { BrandIcon } from "../BrandIcon";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu";
import { Icon } from "../Icon";

/** Stacked avatars shown before the rest are left out. */
const MAX_AVATARS = 3;

export type RailScope = "workspace" | "all";

export type SessionsRailProps = {
  rows: RailRow[];
  now: number;
  workspaceName: string;
  scope: RailScope;
  onScope: (scope: RailScope) => void;
  busy?: boolean;
  error?: string;
  /** Selecting a row: focus that thread. */
  onOpen: (row: RailRow) => void;
  onNew: () => void;
  /** Why New session cannot run now, or undefined when it can. */
  newBlocked?: string;
  /** Closes the session of a row, when the agent supports it for that row. */
  onClose?: (row: RailRow) => void;
  canClose?: (row: RailRow) => boolean;
  onCopyId?: (row: RailRow) => void;
  /** Row menu actions, each shown only when the agent supports it (the History list's actions). */
  onRename?: (row: RailRow) => void;
  onArchive?: (row: RailRow, archived: boolean) => void;
  onFork?: (row: RailRow) => void;
  onExport?: (row: RailRow) => void;
  /** Shown under the list (the Plan limits footer). */
  footer?: JSX.Element;
  /** Shown as an overlay over the thread (narrow windows): Escape closes it. */
  overlay?: boolean;
  onDismiss?: () => void;
  /** Hides the rail (the header button); the thread stays as it is. */
  onHide?: () => void;
  /** Label of the rail toggle shortcut, for the hide button tooltip. */
  hideShortcut?: string;
  /** Shortcut labels for the search and New session hints. */
  searchShortcut?: string;
  newShortcut?: string;
  /** Bumped by the page to focus the search field (Cmd+K). */
  searchRequest?: number;
};

function StatusOrb(props: { row: RailRow }) {
  return (
    <span class="ap-orb" data-state={props.row.state} aria-hidden="true">
      <Show when={props.row.state === "idle"}>
        <Show when={props.row.delta}>
          <Icon name="Check" size={12} />
        </Show>
      </Show>
    </span>
  );
}

function Avatars(props: { agents: RailRow["agents"] }) {
  return (
    <Show when={props.agents.length}>
      <span class="ap-avatars" title={props.agents.map((agent) => agent.name).join(", ")}>
        <For each={props.agents.slice(0, MAX_AVATARS)}>
          {(agent) => (
            <span class="ap-avatar">
              <BrandIcon id={agent.id} name={agent.name} size={12} />
            </span>
          )}
        </For>
        <Show when={props.agents.length > MAX_AVATARS}>
          <span class="ap-avatar ap-avatar-more">+{props.agents.length - MAX_AVATARS}</span>
        </Show>
      </span>
    </Show>
  );
}

/**
 * The Agents page sessions rail: search, New session, the workspace scope, then the threads grouped as Needs you,
 * Working and Recent, with older and archived threads under a collapsed Settled row. Rows form a listbox with one tab
 * stop (roving focus): arrow keys move, Home and End jump, Enter or Space opens, the context menu key or Shift+F10
 * opens the row menu.
 */
export function SessionsRail(props: SessionsRailProps) {
  const [query, setQuery] = createSignal("");
  const [settledOpen, setSettledOpen] = createSignal(false);
  const [active, setActive] = createSignal<string>();
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[]; label: string }>();
  let search: HTMLInputElement | undefined;
  let scroller: HTMLDivElement | undefined;
  const listId = createUniqueId();
  const grouped = createMemo(() => groupRail(props.rows, { query: query(), now: props.now }));
  /** While searching, matching Settled rows show without opening the section. */
  const showSettled = () => settledOpen() || Boolean(query().trim());
  const mainIds = createMemo(() => railOrder({ groups: grouped().groups, settled: [] }, false));
  const settledIds = createMemo(() => (showSettled() ? grouped().settled.map((row) => row.id) : []));
  const total = () => grouped().groups.reduce((sum, group) => sum + group.rows.length, 0) + grouped().settled.length;
  /** The row that holds the tab stop in a list: the active row if it is there, else the open thread, else the first. */
  const tabStop = (ids: readonly string[]) => {
    const current = active();
    if (current && ids.includes(current)) return current;
    return ids.find((id) => props.rows.find((row) => row.id === id)?.current) ?? ids[0];
  };
  createEffect(() => {
    if (props.searchRequest) queueMicrotask(() => search?.focus());
  });
  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setActive(id);
    queueMicrotask(() => scroller?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus());
  };
  const openMenu = (row: RailRow, x: number, y: number) => {
    const items: ContextMenuItem[] = [
      { id: "open", label: row.current ? "Focused" : "Open session", disabled: Boolean(row.current || row.unavailable), disabledReason: row.unavailable, onSelect: () => props.onOpen(row) },
    ];
    const listed = !row.connectionId;
    if (props.onRename && listed) items.push({ id: "rename", label: "Rename…", onSelect: () => props.onRename?.(row) });
    if (props.onFork && listed) items.push({ id: "fork", label: "Fork", disabled: Boolean(row.unavailable), disabledReason: row.unavailable, onSelect: () => props.onFork?.(row) });
    if (props.onExport && listed) items.push({ id: "export", label: "Export…", onSelect: () => props.onExport?.(row) });
    if (props.onArchive && listed) items.push({ id: "archive", label: row.archived ? "Unarchive" : "Archive", onSelect: () => props.onArchive?.(row, !row.archived) });
    if (props.onClose) items.push({ id: "close", label: "Close session", disabled: !props.canClose?.(row), disabledReason: "Only the focused session can be closed, and only when the agent supports closing", onSelect: () => props.onClose?.(row) });
    if (props.onCopyId) items.push({ id: "copy", label: "Copy session id", onSelect: () => props.onCopyId?.(row) });
    setMenu({ x, y, items, label: `${row.title} actions` });
  };
  const rowKeys = (event: KeyboardEvent, row: RailRow, ids: readonly string[]) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!row.unavailable) props.onOpen(row);
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenu(row, box.left + 24, box.bottom - 4);
      return;
    }
    if (event.key === "ArrowUp" && ids[0] === row.id && ids === mainIds()) {
      event.preventDefault();
      search?.focus();
      return;
    }
    const next = railNav(ids, row.id, event.key);
    if (next) {
      event.preventDefault();
      focusRow(next);
    }
  };
  const Row = (rowProps: { row: RailRow; ids: () => readonly string[] }) => {
    const row = () => rowProps.row;
    const label = () => [row().title, row().statusText, railTime(row().updatedAt, props.now), row().unavailable].filter(Boolean).join(", ");
    return (
      <div
        class="ap-row"
        role="option"
        data-row-id={row().id}
        data-state={row().state}
        aria-selected={Boolean(row().current)}
        aria-disabled={row().unavailable ? "true" : undefined}
        aria-label={label()}
        title={row().unavailable}
        tabIndex={tabStop(rowProps.ids()) === row().id ? 0 : -1}
        onFocus={() => setActive(row().id)}
        onClick={() => {
          setActive(row().id);
          if (!row().unavailable) props.onOpen(row());
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(row(), event.clientX, event.clientY);
        }}
        onKeyDown={(event) => rowKeys(event, row(), rowProps.ids())}
      >
        <StatusOrb row={row()} />
        <span class="ap-row-body">
          <span class="ap-row-line">
            <span class="ap-row-title">{row().title}</span>
            <span class="ap-row-time">{railTime(row().updatedAt, props.now)}</span>
          </span>
          <span class="ap-row-line">
            <span class="ap-row-status">{row().statusText}</span>
            <Avatars agents={row().agents} />
          </span>
          <Show when={row().delta}>
            {(delta) => (
              <span class="ap-row-line ap-row-meta">
                <span class="ap-add">+{delta().add}</span>
                <span class="ap-del">-{delta().del}</span>
              </span>
            )}
          </Show>
        </span>
      </div>
    );
  };
  return (
    <aside
      class="ap-rail"
      classList={{ overlay: props.overlay }}
      aria-label="Sessions"
      onKeyDown={(event) => {
        if (props.overlay && event.key === "Escape" && !event.defaultPrevented && !menu()) {
          event.preventDefault();
          props.onDismiss?.();
        }
      }}
    >
      <header class="ap-pane-head">
        <h2 class="ap-pane-title">Sessions</h2>
        <span class="ap-grow" />
        <Show when={props.onHide}>
          <button type="button" class="ap-icon-btn" aria-label="Hide session list" title={props.hideShortcut ? `Hide session list (${props.hideShortcut})` : "Hide session list"} onClick={() => props.onHide?.()}>
            <Icon name="panel-left" size={15} />
          </button>
        </Show>
      </header>
      <div class="ap-rail-tools">
        <label class="ap-search">
          <Icon name="SearchNormal1" size={13} />
          <input
            ref={search}
            type="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            aria-controls={listId}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusRow(mainIds()[0] ?? settledIds()[0]);
              } else if (event.key === "Escape" && query()) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          <Show when={props.searchShortcut && !query()}>
            <kbd class="ap-kbd">{props.searchShortcut}</kbd>
          </Show>
        </label>
        <button type="button" class="ap-rail-action" disabled={Boolean(props.newBlocked)} title={props.newBlocked} onClick={() => props.onNew()}>
          <Icon name="Edit2" size={14} />
          <span class="ap-grow">New session</span>
          <Show when={props.newShortcut}>
            <kbd class="ap-kbd">{props.newShortcut}</kbd>
          </Show>
        </button>
        <button
          type="button"
          class="ap-rail-action ap-scope"
          aria-haspopup="menu"
          aria-label={`Scope: ${props.scope === "all" ? "All folders" : "This workspace"}`}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu({
              x: box.left,
              y: box.bottom + 4,
              label: "Session scope",
              items: [
                { id: "workspace", label: "This workspace", icon: props.scope === "workspace" ? "Check" : undefined, onSelect: () => props.onScope("workspace") },
                { id: "all", label: "All folders", icon: props.scope === "all" ? "Check" : undefined, onSelect: () => props.onScope("all") },
              ],
            });
          }}
        >
          <Icon name="Folder2" size={14} />
          <span class="ap-grow ap-scope-name">{props.workspaceName}</span>
          <span class="ap-scope-value">{props.scope === "all" ? "All folders" : "This workspace"}</span>
          <Icon name="arrow-down4" size={9} />
        </button>
      </div>
      <div class="ap-rail-scroll" ref={scroller}>
        <Show when={props.error}>
          <p class="ap-note" role="alert">{props.error}</p>
        </Show>
        <div id={listId} class="ap-rail-list" role="listbox" aria-label="Sessions" aria-busy={props.busy ? "true" : undefined}>
          <For each={grouped().groups}>
            {(group) => {
              const headingId = createUniqueId();
              return (
                <div class="ap-group" role="group" aria-labelledby={headingId} data-group={group.id}>
                  <div class="ap-group-head" id={headingId}>
                    {group.label}
                    <span class="ap-count">{group.rows.length}</span>
                  </div>
                  <For each={group.rows}>{(row) => <Row row={row} ids={mainIds} />}</For>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={!total()}>
          <p class="ap-note" role="status">
            {props.busy ? "Loading sessions…" : query().trim() ? "No sessions match." : "No sessions yet. Start one with New session."}
          </p>
        </Show>
        <Show when={grouped().settled.length && !query().trim()}>
          <button type="button" class="ap-settled" aria-expanded={settledOpen()} onClick={() => setSettledOpen(!settledOpen())}>
            <span>Settled · {grouped().settled.length}</span>
            <span class="ap-rule" />
            <Icon name="arrow-down4" size={9} class={settledOpen() ? "ap-flip" : undefined} />
          </button>
        </Show>
        <Show when={showSettled() && grouped().settled.length}>
          <div class="ap-rail-list" role="listbox" aria-label="Settled sessions">
            <div class="ap-group" role="group" aria-label="Settled">
              <Show when={query().trim()}>
                <div class="ap-group-head">
                  Settled<span class="ap-count">{grouped().settled.length}</span>
                </div>
              </Show>
              <For each={grouped().settled}>{(row) => <Row row={row} ids={settledIds} />}</For>
            </div>
          </div>
        </Show>
      </div>
      {props.footer}
      <Show when={menu()}>{(open) => <ContextMenu x={open().x} y={open().y} items={open().items} label={open().label} onClose={() => setMenu(undefined)} />}</Show>
    </aside>
  );
}
