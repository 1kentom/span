import type { ContextMenuItem } from "../components/ContextMenu";
import { parentPath } from "./navigation";

/** Explorer row actions that leave Span: show the item in the OS file manager, open a shell in its folder. */
export function explorerSystemItems(options: {
  path: string;
  directory: boolean;
  many: boolean;
  desktop: boolean;
  /** Folder reveal needs the desktop command that accepts folders. */
  revealFolders: boolean;
  revealLabel: string;
  terminalReady: boolean;
  onReveal: (path: string) => void;
  onTerminal: (folder: string) => void;
}): ContextMenuItem[] {
  const { path, directory, many, desktop } = options;
  const revealBlocked = many ? "Select a single item" : !desktop ? "Requires the desktop app" : directory && !options.revealFolders ? "Select a file" : undefined;
  const terminalBlocked = many ? "Select a single item" : !desktop ? "Requires the desktop app" : !options.terminalReady ? "Open a folder to start a terminal" : undefined;
  return [
    { id: "reveal-system", label: options.revealLabel, icon: "menu-openFolder", separator: true, disabled: !!revealBlocked, disabledReason: revealBlocked, onSelect: () => options.onReveal(path) },
    { id: "open-terminal", label: "Open in Terminal", icon: "u-terminal", disabled: !!terminalBlocked, disabledReason: terminalBlocked, onSelect: () => options.onTerminal(directory ? path : parentPath(path)) },
  ];
}
