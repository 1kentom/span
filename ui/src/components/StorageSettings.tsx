import { Show, createSignal, onMount } from "solid-js";
import type { ClearedUploads, UploadUsage } from "../bindings";
import { formatAssetBytes } from "../lib/asset-preview";
import Icon from "./Icon";
import "../styles/updates.css";

/** The uploads store commands this row needs. Injected so tests never touch Tauri. */
export interface StorageApi {
  usage(): Promise<UploadUsage>;
  /** The store folder in app data. Never inside the workspace. */
  folder(): Promise<string>;
  reveal(): Promise<void>;
  /** Removes this workspace's blobs (orphans included), opened copies and index. */
  clear(): Promise<ClearedUploads>;
}

export interface StorageSettingsProps {
  desktop: boolean;
  /** A folder is open. The store is per workspace, so there is nothing to show without one. */
  workspaceOpen: boolean;
  api?: StorageApi;
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const plural = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`;
/** The size as the confirm states it: short form plus the exact byte count. */
export const exactSize = (bytes: number) => (bytes < 1024 ? formatAssetBytes(bytes) : `${formatAssetBytes(bytes)} (${bytes.toLocaleString("en-US")} bytes)`);
/** Text of the inline confirm, from the usage the row shows. */
export function clearConfirmText(usage: UploadUsage): string {
  const files = usage.count + usage.orphanBlobs;
  const bytes = usage.totalBytes + usage.orphanBytes;
  return `Clear ${plural(files, "file")}, ${exactSize(bytes)}, from this workspace's uploads store? Copies opened from it go too. Workspace files and files saved to assets/ are not touched. This cannot be undone.`;
}

/** Settings > Storage: the uploads store of the open workspace (ADR 0006), with its usage, folder and a confirmed clear. */
export function StorageSettings(props: StorageSettingsProps) {
  const [usage, setUsage] = createSignal<UploadUsage>();
  const [folder, setFolder] = createSignal("");
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const ready = () => props.desktop && props.workspaceOpen && !!props.api;

  async function load() {
    if (!ready()) return;
    setError("");
    try {
      const [nextUsage, nextFolder] = await Promise.all([props.api!.usage(), props.api!.folder()]);
      setUsage(nextUsage);
      setFolder(nextFolder);
    } catch (cause) {
      setError(`Could not read the uploads store: ${errorText(cause)}`);
    }
  }
  onMount(() => void load());

  async function reveal() {
    setError("");
    try {
      await props.api!.reveal();
    } catch (cause) {
      setError(`Could not open the folder: ${errorText(cause)}`);
    }
  }
  async function clear() {
    if (busy()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const cleared = await props.api!.clear();
      setConfirming(false);
      setNotice(`Cleared ${plural(cleared.files, "file")}, ${formatAssetBytes(cleared.bytes)}.`);
      await load();
    } catch (cause) {
      setError(`Could not clear uploads: ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  const empty = () => {
    const current = usage();
    return !current || current.count + current.orphanBlobs === 0;
  };
  return (
    <section class="updates-settings storage-settings" aria-label="Storage">
      <div class="updates-heading">
        <div>
          <h2>Uploads</h2>
          <p>Files you attach to agents are kept per workspace in Span's app data, never in the workspace. Nothing expires on its own.</p>
        </div>
        <Show when={ready()}>
          <button class="button" disabled={!folder()} onClick={() => void reveal()}>
            <Icon name="Folder2" size={13} />
            Reveal folder
          </button>
        </Show>
      </div>
      <Show when={props.desktop} fallback={<p class="updates-result" role="status">The browser preview has no uploads store. Open Span desktop to see storage.</p>}>
        <Show when={props.workspaceOpen} fallback={<p class="updates-result" role="status">Open a folder to see its uploads store.</p>}>
          <Show when={usage()}>
            {(current) => (
              <dl class="updates-facts" aria-label="Uploads store">
                <dt>Folder</dt>
                <dd><code class="updates-key">{folder()}</code></dd>
                <dt>Used</dt>
                <dd>{formatAssetBytes(current().totalBytes)} of {formatAssetBytes(current().maxTotalBytes)}</dd>
                <dt>Files</dt>
                <dd>{current().count} of {current().maxCount}</dd>
                <dt>Largest file</dt>
                <dd>{formatAssetBytes(current().maxFileBytes)} each</dd>
                <dt>Orphaned blobs</dt>
                <dd>{current().orphanBlobs ? `${plural(current().orphanBlobs, "file")}, ${formatAssetBytes(current().orphanBytes)}, kept on disk without an index entry` : "None"}</dd>
                <Show when={current().quarantinedIndexes}>
                  <dt>Unreadable indexes</dt>
                  <dd>{current().quarantinedIndexes} set aside</dd>
                </Show>
              </dl>
            )}
          </Show>
          <Show when={usage()}>
            {(current) => (
              <Show
                when={confirming()}
                fallback={
                  <div>
                    <button class="button" disabled={empty() || busy()} onClick={() => { setNotice(""); setConfirming(true); }}>
                      <Icon name="Trash" size={13} />
                      Clear uploads
                    </button>
                  </div>
                }
              >
                <div class="updates-result" role="group" aria-label="Confirm clear uploads">
                  <p>{clearConfirmText(current())}</p>
                  <div class="dialog-actions">
                    <button class="button" disabled={busy()} onClick={() => setConfirming(false)}>Cancel</button>
                    <button class="button danger" disabled={busy()} onClick={() => void clear()}>{busy() ? "Clearing…" : `Clear ${formatAssetBytes(current().totalBytes + current().orphanBytes)}`}</button>
                  </div>
                </div>
              </Show>
            )}
          </Show>
        </Show>
      </Show>
      <Show when={notice()}><p class="updates-result" role="status">{notice()}</p></Show>
      <Show when={error()}><p class="updates-result error" role="alert">{error()}</p></Show>
    </section>
  );
}
