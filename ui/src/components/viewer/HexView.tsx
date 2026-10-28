import { For, Show, createMemo } from 'solid-js';
import { formatAssetBytes } from '../../lib/asset-preview';
import { hexRows } from '../../lib/viewer';

export function HexView(props: { bytes: Uint8Array; name: string }) {
  const view = createMemo(() => hexRows(props.bytes));
  return <div class="vw-hex-wrap">
    <div class="vw-hex" role="region" aria-label={`Binary view of ${props.name}`} tabIndex={0}>
      <For each={view().rows}>{row => <div class="vw-hex-row"><span class="vw-hex-offset">{row.offset}</span><span class="vw-hex-bytes">{row.bytes}</span><span class="vw-hex-ascii" aria-hidden="true">{row.ascii}</span></div>}</For>
    </div>
    <Show when={view().truncated}><p class="vw-note" role="note">Showing the first {formatAssetBytes(view().shown)} of {formatAssetBytes(props.bytes.length)}.</p></Show>
  </div>;
}
