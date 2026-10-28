/** Rows of a navigation tree that can take focus, in document order. */
export const treeRows = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>("[data-nav-row]")];

/**
 * Roving arrow key handling shared by the references and hierarchy trees. The caller supplies what
 * Enter, ArrowRight and ArrowLeft mean for the focused row. Returns true when the key was used.
 */
export function handleTreeKey(event: KeyboardEvent, container: HTMLElement, actions: {
  activate?: (row: HTMLElement) => void; expand?: (row: HTMLElement) => boolean | void; collapse?: (row: HTMLElement) => boolean | void; escape?: () => void;
}): boolean {
  const rows = treeRows(container);
  const row = (event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-nav-row]") : null) ?? undefined;
  const index = row ? rows.indexOf(row) : -1;
  const focus = (next: number) => { const target = rows[Math.max(0, Math.min(rows.length - 1, next))]; target?.focus(); target?.scrollIntoView?.({ block: "nearest" }); };
  switch (event.key) {
    case "ArrowDown": focus(index + 1); break;
    case "ArrowUp": focus(index < 0 ? 0 : index - 1); break;
    case "Home": focus(0); break;
    case "End": focus(rows.length - 1); break;
    case "ArrowRight": if (row) actions.expand?.(row); break;
    case "ArrowLeft": if (row) actions.collapse?.(row); break;
    case "Enter": if (row) actions.activate?.(row); break;
    case "Escape": actions.escape?.(); break;
    default: return false;
  }
  event.preventDefault(); event.stopPropagation();
  return true;
}
