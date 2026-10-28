// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from "vitest";
const dialog = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  return { open: vi.fn() };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialog.open }));
import { api } from "./client";
afterAll(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

describe("native file picker transport", () => {
  it("requests a single file and returns its absolute path without opening a workspace", async () => {
    dialog.open.mockResolvedValueOnce("/work/src/a.ts");
    expect(await api.pickFile()).toBe("/work/src/a.ts");
    expect(dialog.open).toHaveBeenLastCalledWith({ directory: false, multiple: false, title: "Open a file in span" });
    dialog.open.mockResolvedValueOnce(null);
    expect(await api.pickFile()).toBeNull();
  });
  it("propagates native picker failures to the caller", async () => {
    dialog.open.mockRejectedValueOnce(new Error("Dialog unavailable"));
    await expect(api.pickFile()).rejects.toThrow("Dialog unavailable");
  });
});
