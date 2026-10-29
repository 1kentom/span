// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { UploadUsage } from "../bindings";
import { StorageSettings, clearConfirmText, type StorageApi } from "./StorageSettings";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });
function mount(view: () => any) {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(view, root));
  return root;
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const usage = (patch: Partial<UploadUsage> = {}): UploadUsage => ({ count: 3, totalBytes: 3 * 1024 * 1024, maxCount: 2000, maxTotalBytes: 512 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, orphanBlobs: 1, orphanBytes: 2048, quarantinedIndexes: 0, ...patch });
function api(patch: Partial<StorageApi> = {}): StorageApi {
  return {
    usage: vi.fn(async () => usage()),
    folder: vi.fn(async () => "/Users/me/.config/span/uploads/abc"),
    reveal: vi.fn(async () => undefined),
    clear: vi.fn(async () => ({ files: 4, bytes: 3 * 1024 * 1024 + 2048 })),
    ...patch,
  };
}
/** "Label value" for each dt and dd pair of the facts list. */
const facts = (root: HTMLElement) => [...root.querySelectorAll('[aria-label="Uploads store"] dt')].map((dt) => `${text(dt)} ${text(dt.nextElementSibling)}`).join("\n");
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find((item) => text(item) === label);

describe("Settings > Storage", () => {
  it("shows the folder, usage against the caps and orphaned blobs", async () => {
    const root = mount(() => <StorageSettings desktop workspaceOpen api={api()} />);
    await flush();
    const shown = facts(root);
    expect(shown).toContain("Folder /Users/me/.config/span/uploads/abc");
    expect(shown).toContain("Used 3.0 MiB of 512.0 MiB");
    expect(shown).toContain("Files 3 of 2000");
    expect(shown).toContain("Largest file 32.0 MiB each");
    expect(shown).toContain("Orphaned blobs 1 file, 2.0 KiB, kept on disk without an index entry");
    expect(shown).not.toContain("Unreadable indexes");
  });

  it("states the exact size in the confirm text", () => {
    expect(clearConfirmText(usage())).toBe("Clear 4 files, 3.0 MiB (3,147,776 bytes), from this workspace's uploads store? Copies opened from it go too. Workspace files and files saved to assets/ are not touched. This cannot be undone.");
    expect(clearConfirmText(usage({ count: 1, totalBytes: 10, orphanBlobs: 0, orphanBytes: 0 }))).toContain("Clear 1 file, 10 B, from");
  });

  it("clears only after the inline confirm, then shows what went and the new usage", async () => {
    const storage = api();
    let cleared = false;
    storage.usage = vi.fn(async () => (cleared ? usage({ count: 0, totalBytes: 0, orphanBlobs: 0, orphanBytes: 0 }) : usage()));
    storage.clear = vi.fn(async () => { cleared = true; return { files: 4, bytes: 3 * 1024 * 1024 + 2048 }; });
    const root = mount(() => <StorageSettings desktop workspaceOpen api={storage} />);
    await flush();
    button(root, "Clear uploads")!.click();
    expect(storage.clear).not.toHaveBeenCalled();
    const confirm = root.querySelector('[aria-label="Confirm clear uploads"]')!;
    expect(text(confirm)).toContain("3,147,776 bytes");
    button(root, "Cancel")!.click();
    expect(root.querySelector('[aria-label="Confirm clear uploads"]')).toBeNull();
    button(root, "Clear uploads")!.click();
    button(root, "Clear 3.0 MiB")!.click();
    await flush();
    expect(storage.clear).toHaveBeenCalledOnce();
    expect(text(root.querySelector("[role=status]"))).toBe("Cleared 4 files, 3.0 MiB.");
    expect(facts(root)).toContain("Files 0 of 2000");
    expect(button(root, "Clear uploads")!.disabled).toBe(true);
  });

  it("reveals the folder and reports failures", async () => {
    const storage = api({ clear: vi.fn(async () => { throw new Error("busy"); }) });
    const root = mount(() => <StorageSettings desktop workspaceOpen api={storage} />);
    await flush();
    button(root, "Reveal folder")!.click();
    expect(storage.reveal).toHaveBeenCalledOnce();
    button(root, "Clear uploads")!.click();
    button(root, "Clear 3.0 MiB")!.click();
    await flush();
    expect(text(root.querySelector("[role=alert]"))).toBe("Could not clear uploads: busy");
    const broken = mount(() => <StorageSettings desktop workspaceOpen api={api({ usage: async () => { throw new Error("locked"); } })} />);
    await flush();
    expect(text(broken.querySelector("[role=alert]"))).toBe("Could not read the uploads store: locked");
  });

  it("is honest in the browser preview and without a folder", async () => {
    const storage = api();
    const preview = mount(() => <StorageSettings desktop={false} workspaceOpen api={storage} />);
    await flush();
    expect(text(preview)).toContain("The browser preview has no uploads store. Open Span desktop to see storage.");
    expect(button(preview, "Clear uploads")).toBeUndefined();
    expect(button(preview, "Reveal folder")).toBeUndefined();
    const closed = mount(() => <StorageSettings desktop workspaceOpen={false} api={storage} />);
    await flush();
    expect(text(closed)).toContain("Open a folder to see its uploads store.");
    expect(storage.usage).not.toHaveBeenCalled();
  });
});
