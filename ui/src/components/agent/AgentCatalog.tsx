import { For, Show } from "solid-js";
import type { InstalledAgent } from "../../bindings";
import { curatedAgent, type CatalogRow } from "../../lib/acp-catalog";
import { BrandIcon } from "../BrandIcon";
import { Icon, MenuIcon } from "../Icon";

type AgentCatalogProps = {
  /** Every curated agent. Rows that are already installed are left out here: they show under Found on this computer. */
  rows: CatalogRow[];
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
  removal?: { entry: InstalledAgent; uninstall: boolean };
  /** Why the pending removal cannot go ahead yet, or an empty string. */
  removalBlock: string;
  /** The agent waiting for removal is the connected one. */
  removalConnected: boolean;
  onCancelRemoval: () => void;
  onConfirmRemoval: () => void;
};

/**
 * Curated ACP agents that are not installed yet, with search, per-row install state, and the removal confirmation.
 * Installed agents are listed once, under Found on this computer, with their connect and manage controls.
 */
export function AgentCatalog(props: AgentCatalogProps) {
  const installingRow = (id: string) => props.installingIds.includes(id);
  const rows = () => props.rows.filter((row) => !row.installed);
  const allInstalled = () => props.rows.length > 0 && !rows().length;
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
            <Show
              when={rows().length}
              fallback={<div class="agent-menu-note">{allInstalled() ? "Every curated agent here is installed. Connect one under Found on this computer." : "No curated agents match this search."}</div>}
            >
              <For each={rows()}>
                {(row) => (
                  <div class="agent-catalog-entry" data-agent-id={row.definition.id} aria-busy={installingRow(row.definition.id)}>
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
                        <small>{props.installErrors[row.definition.id] ? "Installation failed. Retry." : row.definition.detail}</small>
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
                  </div>
                )}
              </For>
            </Show>
            <Show when={props.registryBusy}>
              <div class="agent-menu-note" role="status">
                Loading verified registry metadata…
              </div>
            </Show>
          </>
        }
      >
        {(choice) => (
          <div
            class="agent-removal-confirmation"
            role="group"
            aria-label="Confirm agent removal"
            // The request can come from a Found row further down the screen, so bring the question into view.
            ref={(element) => queueMicrotask(() => element.scrollIntoView?.({ block: "nearest" }))}
          >
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
