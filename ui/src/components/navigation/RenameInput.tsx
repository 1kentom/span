import { Show, onCleanup, onMount } from "solid-js";
import { cancelRename, commitRename, type RenameState } from "../../stores/navigation";

/** Inline rename box at the symbol. Enter applies, Escape cancels. */
export function RenameInput(props: { rename: RenameState }) {
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus(); input.select();
    const outside = (event: PointerEvent) => { if (!input.parentElement?.contains(event.target as Node) && !props.rename.busy) cancelRename(); };
    window.addEventListener("pointerdown", outside, true);
    onCleanup(() => window.removeEventListener("pointerdown", outside, true));
  });
  return <div class="nav-rename" style={{ left: `${props.rename.left}px`, top: `${props.rename.top + 4}px` }}>
    <input ref={input} aria-label="Rename symbol" aria-describedby="nav-rename-hint" aria-invalid={props.rename.error ? true : undefined} value={props.rename.original} spellcheck={false} disabled={props.rename.busy}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); void commitRename(input.value); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename(); }
        event.stopPropagation();
      }} />
    <div id="nav-rename-hint" class="nav-hint" role={props.rename.error ? "alert" : "status"}>
      <Show when={props.rename.busy} fallback={props.rename.error || "Enter renames, Escape cancels"}>Renaming…</Show>
    </div>
  </div>;
}
