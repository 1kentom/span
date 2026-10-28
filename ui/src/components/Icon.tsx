import type { JSX } from "solid-js";
import { iconAssetPath, type MenuIconName } from "../lib/menuIcons";

type IconProps = { name: string; size?: number; class?: string; style?: JSX.CSSProperties };
export function Icon(props: IconProps) {
  return <span aria-hidden="true" class={`icon ${props.class || ""}`} style={{ width: `${props.size || 16}px`, height: `${props.size || 16}px`, "mask-image": `url('${iconAssetPath(props.name)}')`, "-webkit-mask-image": `url('${iconAssetPath(props.name)}')`, ...props.style }} />;
}
export function MenuIcon(props: Omit<IconProps, "name"> & { name: MenuIconName }) {
  return <Icon name={`menu-${props.name}`} size={props.size} class={props.class} style={props.style} />;
}
export { FileIcon } from "./FileIcon";
export default Icon;
