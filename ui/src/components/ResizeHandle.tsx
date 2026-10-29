import { onCleanup } from "solid-js";
import { cssZoomFactor } from "../lib/zoom";
export function ResizeHandle(props: { label: string; direction: "horizontal" | "vertical"; value: number; min: number; max: number; reverse?: boolean; onResize: (value: number) => void }) {
  let finish: (() => void) | undefined;
  onCleanup(() => finish?.());
  return <div class={`resize-handle resize-${props.direction}`} role="separator" aria-label={props.label} aria-orientation={props.direction === "horizontal" ? "vertical" : "horizontal"} aria-valuenow={Math.round(props.value)} aria-valuemin={props.min} aria-valuemax={props.max} tabIndex={0} onKeyDown={e => {
    const step = e.shiftKey ? 40 : 10;
    const increase = props.direction === "horizontal" ? e.key === "ArrowRight" : e.key === "ArrowDown";
    const decrease = props.direction === "horizontal" ? e.key === "ArrowLeft" : e.key === "ArrowUp";
    if (increase || decrease) { e.preventDefault(); props.onResize(Math.max(props.min, Math.min(props.max, props.value + step * (increase ? 1 : -1) * (props.reverse ? -1 : 1)))); }
  }} onPointerDown={e => {
    if (e.button !== 0) return;
    const start = props.direction === "horizontal" ? e.clientX : e.clientY;
    const value = props.value;
    const move = (event: PointerEvent) => { const position = props.direction === "horizontal" ? event.clientX : event.clientY; props.onResize(Math.max(props.min, Math.min(props.max, value + (position - start) / cssZoomFactor() * (props.reverse ? -1 : 1)))); };
    finish = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", finish!); document.body.style.cursor = ""; document.body.style.userSelect = ""; finish = undefined; };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", finish);
    document.body.style.cursor = props.direction === "horizontal" ? "col-resize" : "row-resize"; document.body.style.userSelect = "none";
    e.preventDefault();
  }} />;
}
