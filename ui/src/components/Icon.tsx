import type { JSX } from "solid-js";
import { iconAssetPath, type MenuIconName } from "../lib/menuIcons";

type IconProps = { name: string; size?: number; class?: string; style?: JSX.CSSProperties };
/** Icons drawn turned a quarter turn everywhere: the "more" dots read as a vertical ellipsis. */
export const QUARTER_TURN_ICONS: readonly string[] = ["3DotsMore"];
export function Icon(props: IconProps) {
  return <span aria-hidden="true" class={`icon ${props.class || ""}`} style={{ width: `${props.size || 16}px`, height: `${props.size || 16}px`, "mask-image": `url('${iconAssetPath(props.name)}')`, "-webkit-mask-image": `url('${iconAssetPath(props.name)}')`, ...(QUARTER_TURN_ICONS.includes(props.name) ? { transform: "rotate(90deg)" } : {}), ...props.style }} />;
}
export function MenuIcon(props: Omit<IconProps, "name"> & { name: MenuIconName }) {
  return <Icon name={`menu-${props.name}`} size={props.size} class={props.class} style={props.style} />;
}
export { FileIcon } from "./FileIcon";
export default Icon;
