import { For, Show, createSignal } from "solid-js";
import type { InstalledAgent } from "../../bindings";
import { curatedAgent, type CatalogRow } from "../../lib/acp-catalog";
import { BrandIcon } from "../BrandIcon";
import { Icon, MenuIcon } from "../Icon";

type AgentCatalogProps = {
  rows: CatalogRow[];
  /** Installed adapters outside the curated list. */
  others: InstalledAgent[];
  search: string;
  onSearch: (value: string) => void;
  installingIds: string[];
  installErrors: Record<string, string>;
  registryBusy: boolean;
  /** A connection or removal is in progress. Installs do not set this, so other rows stay usable while one installs. */
  working: boolean;
  desktop: boolean;
  onRefresh: () => void;
  onPick: (row: CatalogRow) => void;
  /** Present only when the host can remove agents. Without it no manage control is drawn. */
  onRequestRemoval?: (entry: InstalledAgent, uninstall: boolean) => void;
  removal?: { entry: InstalledAgent; uninstall: boolean };
  /** Why the pending removal cannot go ahead yet, or an empty string. */
  removalBlock: string;
  /** The agent waiting for removal is the connected one. */
  removalConnected: boolean;
  onCancelRemoval: () => void;
  onConfirmRemoval: () => void;
};

/** Curated ACP agents with search, per-row install state, and removal that always asks first. */
export function AgentCatalog(props: AgentCatalogProps) {
  const [managing, setManaging] = createSignal<string>();
  const installingRow = (id: string) => props.installingIds.includes(id);
  const toggle = (id: string) => setManaging((value) => (value === id ? undefined : id));
  const request = (entry: InstalledAgent, uninstall: boolean) => {
    setManaging(undefined);
    props.onRequestRemoval?.(entry, uninstall);
  };
  const Manage = (manage: { id: string; entry: InstalledAgent }) => (
    <Show when={managing() === manage.id}>
      <div class="agent-row-management">
        <button type="button" onClick={() => request(manage.entry, false)}>
          <Icon name="CloseCircle" size={14} />
          Remove from Span
        </button>
        <button type="button" onClick={() => request(manage.entry, true)}>
          <MenuIcon name="trash" size={14} />
          Uninstall managed adapter
        </button>
      </div>
    </Show>
  );

  return (
    <div class="agent-catalog" role="group" aria-label="Agents">
      <Show
        when={props.removal}
        fallback={
          <>
            <div class="agent-menu-heading">
              <span>Agents</span>
              <button type="button" class="sb-icon-btn" aria-label="Refresh agent registry" disabled={props.registryBusy} onClick={() => props.onRefresh()}>
                <Icon name="Refresh2" size={14} />
              </button>
            </div>
            <label class="agent-catalog-search">
              <Icon name="SearchNormal1" size={14} />
              <span class="sb-visually-hidden">Search curated agents</span>
              <input placeholder="Search agents" value={props.search} onInput={(event) => props.onSearch(event.currentTarget.value)} />
            </label>
            <Show when={!props.desktop}>
              <div class="agent-menu-note">Open span desktop to install or connect an ACP agent.</div>
            </Show>
            <Show when={props.rows.length} fallback={<div class="agent-menu-note">No curated agents match this search.</div>}>
              <For each={props.rows}>
                {(row) => (
                  <div class="agent-catalog-entry" aria-busy={installingRow(row.definition.id)}>
                    <button
                      type="button"
                      class="agent-menu-item agent-catalog-row"
                      classList={{ "is-installing": installingRow(row.definition.id) }}
                      disabled={
                        !props.desktop ||
                        ((row.action === "connect" || row.action === "local") && props.working) ||
                        (row.action === "install" && installingRow(row.definition.id)) ||
                        row.action === "unavailable"
                      }
                      onClick={() => props.onPick(row)}
                    >
                      <Show when={row.definition.brand === "glm"} fallback={<BrandIcon id={row.definition.brand} size={20} />}>
                        <span class="agent-glm-mark" aria-hidden="true" />
                      </Show>
                      <span class="agent-menu-copy">
                        <strong>{row.definition.name}</strong>
                        <small>{row.installed ? `Installed · ${row.installed.version}` : props.installErrors[row.definition.id] ? "Installation failed. Retry." : row.definition.detail}</small>
                        <Show when={props.installErrors[row.definition.id]}>
                          {(message) => (
                            <small class="agent-install-error" role="status" title={message()}>
                              {message()}
                            </small>
                          )}
                        </Show>
                      </span>
                      <span class="agent-menu-trailing">
                        {installingRow(row.definition.id) ? (
                          <span class="agent-install-progress" role="status">
                            <span class="agent-install-spinner" aria-hidden="true" />
                            <span>Installing…</span>
                          </span>
                        ) : row.action === "connect" ? (
                          <Icon name="arrow-right4" size={16} />
                        ) : row.action === "install" ? (
                          <span class="agent-install-action">
                            <MenuIcon name="install" size={14} />
                            {props.installErrors[row.definition.id] ? "Retry" : "Install"}
                          </span>
                        ) : row.action === "local" ? (
                          "Use local CLI"
                        ) : props.registryBusy ? (
                          "Loading"
                        ) : (
                          "Unavailable"
                        )}
                      </span>
                    </button>
                    <Show when={props.onRequestRemoval ? row.installed : undefined}>
                      {(entry) => (
                        <>
                          <button
                            type="button"
                            class="agent-row-overflow"
                            aria-label={`Manage ${row.definition.name}`}
                            aria-expanded={managing() === row.definition.id}
                            onClick={() => toggle(row.definition.id)}
                          >
                            ···
                          </button>
                          <Manage id={row.definition.id} entry={entry()} />
                        </>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </Show>
            <Show when={props.registryBusy}>
              <div class="agent-menu-note" role="status">
                Loading verified registry metadata…
              </div>
            </Show>
            <Show when={props.others.length}>
              <details class="agent-other-installed">
                <summary>Other installed adapters ({props.others.length})</summary>
                <div class="agent-menu-note">Kept on this device. These adapters are outside the curated list.</div>
                <For each={props.others}>
                  {(entry) => (
                    <div class="agent-other-row">
                      <span class="agent-menu-copy">
                        <strong>{entry.id}</strong>
                        <small>Managed adapter · {entry.version}</small>
                      </span>
                      <Show when={props.onRequestRemoval}>
                        <button type="button" class="sb-icon-btn" aria-label={`Manage ${entry.id}`} aria-expanded={managing() === entry.id} onClick={() => toggle(entry.id)}>
                          ···
                        </button>
                      </Show>
                      <Manage id={entry.id} entry={entry} />
                    </div>
                  )}
                </For>
              </details>
            </Show>
          </>
        }
      >
        {(choice) => (
          <div class="agent-removal-confirmation" role="group" aria-label="Confirm agent removal">
            <h3>{choice().uninstall ? "Uninstall managed adapter?" : "Remove agent from Span?"}</h3>
            <p>{curatedAgent(choice().entry.id)?.name || choice().entry.id}</p>
            <p>
              {choice().uninstall
                ? "Deletes only this adapter's files managed by Span. Your separate CLI installation, account and project files are kept."
                : "Removes this adapter from Span's installed list. Its managed files stay on this device."}
            </p>
            <Show when={props.removalConnected}>
              <p>The connected session will disconnect first.</p>
            </Show>
            <Show when={props.removalBlock}>
              <p class="agent-removal-block" role="status">
                {props.removalBlock}
              </p>
            </Show>
            <div class="sb-actions">
              <button type="button" class="sb-btn" disabled={props.working} onClick={() => props.onCancelRemoval()}>
                Cancel
              </button>
              <button type="button" class="sb-btn danger" disabled={props.working || Boolean(props.removalBlock)} onClick={() => props.onConfirmRemoval()}>
                {props.working ? "Removing…" : choice().uninstall ? "Uninstall adapter" : "Remove from Span"}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
