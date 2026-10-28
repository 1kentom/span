import type { JSX } from "solid-js";

export function Icon(props: { name: string; size?: number; class?: string; style?: JSX.CSSProperties }) {
  return <span aria-hidden="true" class={`icon ${props.class || ""}`} style={{ width: `${props.size || 16}px`, height: `${props.size || 16}px`, "mask-image": `url('/icons/${props.name}.svg')`, "-webkit-mask-image": `url('/icons/${props.name}.svg')`, ...props.style }} />;
}
export { FileIcon } from "./FileIcon";
export default Icon;
