import type { JSX } from "solid-js";

export function Icon(props: { name: string; size?: number; class?: string; style?: JSX.CSSProperties }) {
  return <span aria-hidden="true" class={`icon ${props.class || ""}`} style={{ width: `${props.size || 16}px`, height: `${props.size || 16}px`, "mask-image": `url('/icons/${props.name}.svg')`, "-webkit-mask-image": `url('/icons/${props.name}.svg')`, ...props.style }} />;
}
export function FileIcon(props: { path: string; directory?: boolean; open?: boolean }) {
  const name = () => {
    const file = props.path.split("/").pop() || "";
    if (props.directory) return `folder${file === "src" ? "-src" : file === "test" || file === "tests" ? "-test" : ""}${props.open ? "-open" : ""}`;
    if (file.endsWith(".d.ts")) return "typescript-def";
    if (/^tsconfig/.test(file)) return "tsconfig";
    if (/readme/i.test(file)) return "readme";
    if (/^package/.test(file)) return "json";
    if (/^\.git/.test(file)) return "git";
    return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", jsonc: "json", rs: "rust", xml: "xml", iml: "xml", md: "readme", bazel: "bazel" } as Record<string, string>)[file.split(".").pop() || ""] || "document";
  };
  return <span class={`fi fi-${name()}`} aria-hidden="true" />;
}
export default Icon;
