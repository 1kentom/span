import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANVAS_COLORS, revealOnce } from "./startup";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("main window reveal", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("creates the only configured window hidden, on the dark canvas colour", () => {
    const config = JSON.parse(read("../apps/desktop/tauri.conf.json"));
    expect(config.app.windows).toHaveLength(1);
    const [main] = config.app.windows;
    expect(main.visible).toBe(false);
    expect(main.backgroundColor).toBe(CANVAS_COLORS.dark);
    // Size is still the configured default the app has always opened with.
    expect([main.width, main.height]).toEqual([1440, 900]);
  });

  it("shows the window from Rust with a failsafe for a frontend that never reports ready", () => {
    const lib = read("../apps/desktop/src/lib.rs");
    const window = read("../apps/desktop/src/window.rs");
    expect(lib).toContain("window::show_main_window");
    expect(lib).toMatch(/window::show_if_still_hidden\(/);
    for (const color of Object.values(CANVAS_COLORS)) {
      const hex = color.slice(1);
      const [r, g, b] = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16));
      expect(window).toContain(`Color(${r}, ${g}, ${b}, 255)`);
    }
  });

  it("reveals once when ready, or at the cap when the session restore is slow", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const reveal = revealOnce(show, 2000);
    reveal(); reveal();
    await vi.runAllTimersAsync();
    expect(show).toHaveBeenCalledTimes(1);

    const slow = vi.fn();
    revealOnce(slow, 2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(slow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed show so startup never throws", async () => {
    const reveal = revealOnce(() => Promise.reject(new Error("no window")), 10);
    expect(() => reveal()).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
