import type { ActionHandlers, ActionId } from "./commands";

/** Code navigation commands. Their default keys and labels live in `actionDefinitions`. */
export const navigationActionIds = [
  "goToDefinition", "goToTypeDefinition", "goToImplementation",
  "peekDefinition", "peekTypeDefinition", "peekImplementation",
  "findReferences", "peekReferences",
  "goToSymbolInFile", "goToSymbolInWorkspace", "quickInfo",
  "showCallHierarchy", "showTypeHierarchy", "renameSymbol",
  "goBack", "goForward",
] as const satisfies readonly ActionId[];
export type NavigationActionId = typeof navigationActionIds[number];
export type NavigationHandler = () => void | Promise<void>;

export const NAVIGATION_UNAVAILABLE_MESSAGE = "Not available for this file";

const registry = new Map<NavigationActionId, NavigationHandler>();
let notifier: ((message: string) => void) | undefined;

/** Where the "not available" message goes. The workbench points this at its visible status line. */
export function setNavigationNotifier(notify: ((message: string) => void) | undefined): void { notifier = notify; }

/** Registers the real implementation of an action. The latest registration wins. The returned function removes only that registration. */
export function registerNavigationHandler(id: NavigationActionId, handler: NavigationHandler): () => void {
  registry.set(id, handler);
  return () => { if (registry.get(id) === handler) registry.delete(id); };
}

/** Runs the registered handler. Returns false (after a visible message) when nothing handles the action. A failing async handler is reported, never thrown. */
export function runNavigationAction(id: NavigationActionId): boolean {
  const handler = registry.get(id);
  if (!handler) { notifier?.(NAVIGATION_UNAVAILABLE_MESSAGE); return false; }
  try {
    const result = handler();
    if (result && typeof result.catch === "function") void result.catch(error => notifier?.(String(error)));
  } catch (error) { notifier?.(String(error)); }
  return true;
}

/** Every navigation id wired to `runNavigationAction`, for the workbench action table. */
export const navigationActions: Required<Pick<ActionHandlers, NavigationActionId>> = Object.fromEntries(
  navigationActionIds.map(id => [id, () => { runNavigationAction(id); }]),
) as Required<Pick<ActionHandlers, NavigationActionId>>;
