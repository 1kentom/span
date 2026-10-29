/**
 * The Agents page panels (sessions rail and side panel): open state per workspace folder, shared by the toolbar
 * toggles, the keyboard and the page itself. Widths stay in agents-page.ts. Hiding a panel never unmounts the thread.
 */
import { batch, createEffect, createSignal, on } from "solid-js";
import { SIDE_OPEN_KEY, readStored, writeStored, type AgentMode } from "./agents-page";

/** A per-folder storage key, the folder after the key like the remembered mode. Without a folder, the plain key. */
export const panelKey = (key: string, workspace: string | undefined) => (workspace ? `${key}:${workspace}` : key);

/** The rail is open unless the user hid it in this folder (or, before per-folder keys, anywhere). */
export function readRailOpen(workspace: string | undefined): boolean {
  return (readStored(panelKey("railOpen", workspace)) ?? readStored("railOpen")) !== "false";
}
/** The side panel choice the user made in this folder, else the earlier global choice, else undefined (follow the window). */
export function readSideChoice(workspace: string | undefined): boolean | undefined {
  const stored = readStored(panelKey(SIDE_OPEN_KEY, workspace)) ?? readStored(SIDE_OPEN_KEY);
  return stored === "true" ? true : stored === "false" ? false : undefined;
}

export type AgentsPanels = {
  /** The rail as the user left it in a wide window. */
  railOpen: () => boolean;
  /** Whether the rail shows now: the overlay state in a narrow window, else `railOpen`. */
  railShown: () => boolean;
  showRail: (open: boolean) => void;
  toggleRail: () => void;
  narrow: () => boolean;
  setNarrow: (narrow: boolean) => void;
  sideOpen: () => boolean;
  setSideOpen: (open: boolean) => void;
  toggleSide: () => void;
  /** What the side panel does before the user chooses, from the window width and content (set by the page). */
  setSideDefault: (open: boolean) => void;
  /** A thread other than the open one waits for the user (set by the page): the hidden rail's toggles carry a dot. */
  attention: () => boolean;
  setAttention: (value: boolean) => void;
};

export function createAgentsPanels(workspace: () => string | undefined): AgentsPanels {
  const [railOpen, setRailOpenState] = createSignal(readRailOpen(workspace()));
  const [sideChoice, setSideChoice] = createSignal<boolean | undefined>(readSideChoice(workspace()));
  const [sideDefault, setSideDefault] = createSignal(true);
  const [narrow, setNarrowState] = createSignal(false);
  const [overlayOpen, setOverlayOpen] = createSignal(false);
  const [attention, setAttention] = createSignal(false);
  createEffect(
    on(
      workspace,
      (root) =>
        batch(() => {
          setRailOpenState(readRailOpen(root));
          setSideChoice(readSideChoice(root));
          setOverlayOpen(false);
        }),
      { defer: true },
    ),
  );
  const setRailOpen = (open: boolean) => {
    setRailOpenState(open);
    writeStored(panelKey("railOpen", workspace()), String(open));
  };
  const railShown = () => (narrow() ? overlayOpen() : railOpen());
  const showRail = (open: boolean) => (narrow() ? setOverlayOpen(open) : setRailOpen(open));
  const sideOpen = () => sideChoice() ?? sideDefault();
  const setSideOpen = (open: boolean) => {
    setSideChoice(open);
    writeStored(panelKey(SIDE_OPEN_KEY, workspace()), String(open));
  };
  return {
    railOpen,
    railShown,
    showRail,
    toggleRail: () => showRail(!railShown()),
    narrow,
    setNarrow: (value) => {
      if (value === narrow()) return;
      batch(() => {
        setNarrowState(value);
        setOverlayOpen(false);
      });
    },
    sideOpen,
    setSideOpen,
    toggleSide: () => setSideOpen(!sideOpen()),
    setSideDefault,
    attention,
    setAttention,
  };
}

/** A panel toggle command, as the toolbar, the keyboard and the native menu send it. */
export type PanelCommand = "toggleProject" | "toggleAssistant" | "toggleTerminal" | "toggleRail";
/** What a panel toggle acts on in each mode. In Agents mode the editor's project panel and AI sidebar are never shown. */
export type PanelTarget = "project" | "assistant" | "terminal" | "rail" | "side" | "none";

/**
 * Editor mode keeps its meanings (Cmd+B project panel, Cmd+Alt+B AI Assistant, Cmd+J terminal). Agents mode maps the
 * same commands onto the page: Cmd+B and Toggle AI Assistant toggle the side panel, Cmd+J the terminal, Cmd+1 the rail.
 */
export function panelTarget(mode: AgentMode, command: PanelCommand): PanelTarget {
  if (command === "toggleTerminal") return "terminal";
  if (mode === "agents") return command === "toggleRail" ? "rail" : "side";
  return command === "toggleProject" ? "project" : command === "toggleAssistant" ? "assistant" : "none";
}

/** Cmd+1 on macOS, Ctrl+1 elsewhere, with no other modifier: toggles the sessions rail in Agents mode. */
export function isRailChord(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "defaultPrevented">, platform: "mac" | "windows" | "linux"): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return false;
  const digit = event.code === "Digit1" || event.key === "1";
  return digit && (platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
export const RAIL_SHORTCUT = { mac: "⌘1", other: "Ctrl+1" } as const;
