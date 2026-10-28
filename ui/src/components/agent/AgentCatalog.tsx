import { For, Show, createSignal } from "solid-js";
import type { AgentUpdate_Serialize as AgentUpdate, InstalledAgent } from "../../bindings";
import { curatedAgent, type CatalogRow } from "../../lib/acp-catalog";
import { BrandIcon } from "../BrandIcon";
import { Icon, MenuIcon } from "../Icon";
import type { PresetRow } from "./types";
import { CommandChip } from "./CommandChip";
import { UpdateBadge, UpdatePanel, updateLabel } from "./UpdateBadge";

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
  /** Known launch commands. A curated row with one connects it directly instead of offering the local CLI draft. */
  presets?: PresetRow[];
  onPreset?: (id: string) => void;
  /** Check-only update results. A confirmed update draws a pill under its row. */
  updates?: AgentUpdate[];
  onOpenExternal?: (url: string) => void;
  /** Copies a shown launch command. Without it the browser clipboard is used. */
  onCopyCommand?: (command: string) => unknown;
};

/** The command a curated row connects through when it is not installed and the host knows a launch command for it. */
export function catalogPreset(row: CatalogRow, presets: readonly PresetRow[] | undefined): PresetRow | undefined {
  if (row.installed || (row.action !== "local" && row.action !== "unavailable")) return undefined;
  return presets?.find((preset) => preset.id === row.definition.id);
}

/**
 * Curated ACP agents that are not installed yet, with search, per-row install state, and the removal confirmation.
 * Installed agents are listed once, under Found on this computer, with their connect and manage controls.
 */
export function AgentCatalog(props: AgentCatalogProps) {
  const installingRow = (id: string) => props.installingIds.includes(id);
  const [openUpdate, setOpenUpdate] = createSignal<string>();
  const updateFor = (id: string) => props.updates?.find((update) => update.id === id);
  const presetFor = (row: CatalogRow) => catalogPreset(row, props.presets);
  const subtitle = (row: CatalogRow) => (props.installErrors[row.definition.id] ? "Installation failed. Retry." : row.definition.detail);
  const pick = (row: CatalogRow) => {
    const preset = presetFor(row);
    if (preset && props.onPreset) props.onPreset(preset.id);
    else props.onPick(row);
  };
  const rows = () => props.rows.filter((row) => !row.installed);
  const allInstalled = () => props.rows.length > 0 && !rows().length;
  return (
    <div class="agent-catalog" role="group" aria-label="Agents">
      <Show
        when={props.removal}
        fallback={
          <>
            <div class="agent-menu-heading">
              <span class="sb-eyebrow-text">
                Agents <span class="sb-count">{rows().length}</span>
              </span>
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
                        ((row.action === "connect" || row.action === "local" || Boolean(presetFor(row))) && props.working) ||
                        (row.action === "install" && installingRow(row.definition.id)) ||
                        (row.action === "unavailable" && !(presetFor(row) && props.onPreset))
                      }
                      onClick={() => pick(row)}
                    >
                      <Show when={row.definition.brand === "glm"} fallback={<BrandIcon id={row.definition.brand} size={20} />}>
                        <span class="agent-glm-mark" aria-hidden="true" />
                      </Show>
                      <span class="agent-menu-copy">
                        <strong>{row.definition.name}</strong>
                        <small title={subtitle(row)}>{subtitle(row)}</small>
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
                        ) : row.action === "connect" || (presetFor(row) && props.onPreset) ? (
                          <span class="agent-action primary">Connect</span>
                        ) : row.action === "install" ? (
                          <span class="agent-action secondary agent-install-action">
                            <MenuIcon name="install" size={13} />
                            {props.installErrors[row.definition.id] ? "Retry" : "Install"}
                          </span>
                        ) : row.action === "local" ? (
                          <span class="agent-action secondary">Use local CLI</span>
                        ) : props.registryBusy ? (
                          "Loading"
                        ) : (
                          "Unavailable"
                        )}
                      </span>
                    </button>
                    <Show when={presetFor(row)}>
                      {(preset) => (
                        <div class="agent-row-extra">
                          <CommandChip command={preset().command} label={`Command for ${preset().name}`} onCopy={props.onCopyCommand} />
                        </div>
                      )}
                    </Show>
                    <Show when={updateLabel(updateFor(row.definition.id)) ? updateFor(row.definition.id) : undefined}>
                      {(update) => (
                        <div class="agent-row-extra">
                          <UpdateBadge update={update()} expanded={openUpdate() === row.definition.id} onToggle={() => setOpenUpdate((value) => (value === row.definition.id ? undefined : row.definition.id))} />
                          <Show when={openUpdate() === row.definition.id}>
                            <UpdatePanel update={update()} onOpenExternal={props.onOpenExternal} />
                          </Show>
                        </div>
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
