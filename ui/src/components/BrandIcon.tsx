import { Show, createMemo, createSignal } from "solid-js";
import { brandIconFor, type BrandIconAsset, type BrandIdentity } from "../lib/brand-icons";
import Icon from "./Icon";
import "../styles/brands.css";

/** `asset` draws a resolved mark (a model vendor's, say) in place of the identity lookup. A mono asset is a currentColor mask. */
export function BrandIcon(props: BrandIdentity & { size?: number; fallback?: string; class?: string; asset?: BrandIconAsset }) {
  const asset = createMemo(() => props.asset ?? brandIconFor(props));
  const [failed, setFailed] = createSignal<string>();
  return <span class={`brand-icon ${props.class || ""}`} style={{ width: `${props.size || 18}px`, height: `${props.size || 18}px`, flex: "none" }} aria-hidden="true">
    <Show when={asset() && failed() !== asset()?.id} fallback={<Icon name={props.fallback || "collaborators"} size={props.size || 18} />}>
      <Show when={asset()?.mono} fallback={<>
        <img class="brand-light" src={asset()?.light} alt="" draggable={false} onError={() => setFailed(asset()?.id)} />
        <img class="brand-dark" src={asset()?.dark} alt="" draggable={false} onError={() => setFailed(asset()?.id)} />
      </>}>
        <span class="brand-mask" style={{ "--brand-mask": `url("${asset()?.light}")` }} />
      </Show>
    </Show>
  </span>;
}
