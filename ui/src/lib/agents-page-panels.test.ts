// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createAgentsPanels, isRailChord, panelTarget, readRailOpen, readSideChoice } from "./agents-page-panels";

const key = (init: Partial<KeyboardEvent>) => ({ key: "1", code: "Digit1", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...init });

beforeEach(() => window.localStorage.clear());

describe("panel commands per mode", () => {
  it("keeps the Editor meanings and maps the same commands onto the Agents page", () => {
    expect(panelTarget("editor", "toggleProject")).toBe("project");
    expect(panelTarget("editor", "toggleAssistant")).toBe("assistant");
    expect(panelTarget("editor", "toggleTerminal")).toBe("terminal");
    expect(panelTarget("editor", "toggleRail")).toBe("none");
    // Cmd+B and Toggle AI Assistant: the side panel. Cmd+J: the terminal. Cmd+1: the rail. Never the AI sidebar.
    expect(panelTarget("agents", "toggleProject")).toBe("side");
    expect(panelTarget("agents", "toggleAssistant")).toBe("side");
    expect(panelTarget("agents", "toggleTerminal")).toBe("terminal");
    expect(panelTarget("agents", "toggleRail")).toBe("rail");
  });

  it("reads Cmd+1 on macOS and Ctrl+1 elsewhere, with no other modifier", () => {
    expect(isRailChord(key({ metaKey: true }), "mac")).toBe(true);
    expect(isRailChord(key({ ctrlKey: true }), "mac")).toBe(false);
    expect(isRailChord(key({ ctrlKey: true }), "linux")).toBe(true);
    expect(isRailChord(key({ ctrlKey: true }), "windows")).toBe(true);
    expect(isRailChord(key({ metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(isRailChord(key({ metaKey: true, altKey: true }), "mac")).toBe(false);
    expect(isRailChord(key({ metaKey: true, key: "2", code: "Digit2" }), "mac")).toBe(false);
    expect(isRailChord(key({ metaKey: true, defaultPrevented: true }), "mac")).toBe(false);
  });
});

describe("panel state per folder", () => {
  it("remembers the rail and side panel choice for each folder and rereads it when the folder changes", () => {
    const { panels, setRoot, dispose } = createRoot((dispose) => {
      const [root, setRoot] = createSignal<string | undefined>("/a");
      return { panels: createAgentsPanels(root), setRoot, dispose };
    });
    expect(panels.railShown()).toBe(true);
    panels.toggleRail();
    panels.setSideDefault(true);
    panels.toggleSide();
    expect(panels.railShown()).toBe(false);
    expect(panels.sideOpen()).toBe(false);
    expect(readRailOpen("/a")).toBe(false);
    expect(readSideChoice("/a")).toBe(false);
    setRoot("/b");
    expect(panels.railShown()).toBe(true);
    expect(panels.sideOpen()).toBe(true);
    setRoot("/a");
    expect(panels.railShown()).toBe(false);
    expect(panels.sideOpen()).toBe(false);
    dispose();
  });

  it("follows the window for the side panel until the user chooses, and uses the overlay in a narrow window", () => {
    createRoot((dispose) => {
      const panels = createAgentsPanels(() => "/c");
      panels.setSideDefault(false);
      expect(panels.sideOpen()).toBe(false);
      panels.setSideDefault(true);
      expect(panels.sideOpen()).toBe(true);
      panels.setNarrow(true);
      expect(panels.railShown()).toBe(false);
      panels.toggleRail();
      expect(panels.railShown()).toBe(true);
      // The overlay is not a remembered choice.
      expect(readRailOpen("/c")).toBe(true);
      panels.setNarrow(false);
      expect(panels.railShown()).toBe(true);
      dispose();
    });
  });

  it("falls back to the earlier global keys and survives storage that throws", () => {
    window.localStorage.setItem("span.agents.railOpen", "false");
    window.localStorage.setItem("span.agents.sideOpenChosen", "true");
    expect(readRailOpen("/d")).toBe(false);
    expect(readSideChoice("/d")).toBe(true);
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readRailOpen("/d")).toBe(true);
      expect(readSideChoice("/d")).toBeUndefined();
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
