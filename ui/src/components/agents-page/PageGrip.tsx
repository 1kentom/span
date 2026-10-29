import { createSignal, onCleanup } from "solid-js";
import { cssZoomFactor } from "../../lib/zoom";

/**
 * The 8px gutter between Agents page panes: drag or arrow keys resize the pane on `side`, double-click or Home resets
 * it, Enter collapses it. Dragging below `collapseBelow` collapses the pane (the design's rail behaviour).
 */
export function PageGrip(props: {
  label: string;
  /** The pane the grip resizes sits on this side of it. */
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  onResize: (value: number) => void;
  onReset: () => void;
  onCollapse?: () => void;
  collapseBelow?: number;
}) {
  const [dragging, setDragging] = createSignal(false);
  let finish: (() => void) | undefined;
  onCleanup(() => finish?.());
  const sign = () => (props.side === "left" ? 1 : -1);
  const clamp = (value: number) => Math.max(props.min, Math.min(props.max, value));
  return (
    <div
      class="ap-grip resize-handle resize-horizontal"
      classList={{ dragging: dragging() }}
      data-side={props.side}
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onDblClick={() => props.onReset()}
      onKeyDown={(event) => {
        if (event.key === "Home") {
          event.preventDefault();
          props.onReset();
        } else if (event.key === "Enter" && props.onCollapse) {
          event.preventDefault();
          props.onCollapse();
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const step = (event.shiftKey ? 40 : 10) * (event.key === "ArrowRight" ? 1 : -1) * sign();
          props.onResize(clamp(props.value + step));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const start = event.clientX;
        const initial = props.value;
        setDragging(true);
        const move = (next: PointerEvent) => {
          const raw = initial + ((next.clientX - start) / cssZoomFactor()) * sign();
          if (props.onCollapse && props.collapseBelow !== undefined && raw < props.collapseBelow) {
            finish?.();
            props.onCollapse();
            return;
          }
          props.onResize(clamp(raw));
        };
        finish = () => {
          setDragging(false);
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", stop);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          finish = undefined;
        };
        const stop = () => finish?.();
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", stop);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        event.preventDefault();
      }}
    >
      <span class="ap-grip-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
