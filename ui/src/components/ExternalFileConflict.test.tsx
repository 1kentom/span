// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { ExternalFileState } from "../bindings";
import { ExternalFileConflict } from "./ExternalFileConflict";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function settle() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }
function mount(state: Partial<ExternalFileState>, options: { currentText?: string; onResolve?: (action: "reload" | "overwrite") => Promise<void>; onClose?: () => void; onCopy?: (text: string) => Promise<void> } = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const [open, setOpen] = createSignal(false);
  const onReview = vi.fn(() => setOpen(true)); const onClose = options.onClose ?? vi.fn(() => setOpen(false)); const onResolve = options.onResolve ?? vi.fn(async () => {});
  const conflict = { path: "src/notes.txt", revision: 2, kind: "conflict", disk: { token: "disk-3", exists: true, text: "saved disk text", truncated: false }, ...state } as ExternalFileState;
  disposers.push(render(() => <ExternalFileConflict state={conflict} currentText={options.currentText ?? "local editor draft"} open={open()} onReview={onReview} onClose={onClose} onResolve={onResolve} onCopy={options.onCopy} />, root));
  return { root, onReview, onClose, onResolve, onCopy: options.onCopy };
}

describe("ExternalFileConflict", () => {
  it("keeps the banner inert until Compare and safely renders bounded plain text previews", async () => {
    const unsafe = "<script>window.pwned=true</script>";
    const t = mount({}, { currentText: unsafe });
    const banner = t.root.querySelector('[role="status"]')!;
    expect(banner.textContent).toContain("changed on disk");
    expect(banner.textContent).toContain("src/notes.txt");
    expect(t.root.querySelector('[role="dialog"]')).toBeNull();
    expect(t.onResolve).not.toHaveBeenCalled();
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click();
    await settle();
    const dialog = t.root.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.textContent).toContain(unsafe);
    expect(dialog.textContent).toContain("saved disk text");
    expect(dialog.querySelector("#external-file-keep-editing")).toBe(document.activeElement);
    dialog.querySelector("h2")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(t.onResolve).not.toHaveBeenCalled();
    expect(t.onClose).not.toHaveBeenCalled();
    dialog.querySelector<HTMLButtonElement>("#external-file-keep-editing")!.click();
    await settle();
    expect(t.onClose).toHaveBeenCalledOnce();
    expect(t.onResolve).not.toHaveBeenCalled();
  });

  it("calls only the explicitly selected resolution and keeps the dialog until its owner closes it", async () => {
    const t = mount({});
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click(); await settle();
    Array.from(t.root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Reload from Disk"))!.click();
    await settle();
    expect(t.onResolve).toHaveBeenCalledExactlyOnceWith("reload");
    expect(t.root.querySelector('[role="dialog"]')).not.toBeNull();
    t.root.querySelector<HTMLButtonElement>(".external-conflict-destructive")!.click();
    await settle();
    expect(t.onResolve).toHaveBeenNthCalledWith(2, "overwrite");
    expect(t.root.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("disables reload for a deleted file and labels overwrite as recreating it", async () => {
    const t = mount({ kind: "deleted", disk: { token: "missing-4", exists: false, text: "", truncated: false } });
    expect(t.root.querySelector('[role="status"]')?.textContent).toContain("deleted on disk");
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click(); await settle();
    const reload = Array.from(t.root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Reload from Disk"))!;
    const recreate = t.root.querySelector<HTMLButtonElement>(".external-conflict-destructive")!;
    expect(reload.disabled).toBe(true);
    expect(recreate.textContent).toContain("Recreate File");
    recreate.click(); await settle();
    expect(t.onResolve).toHaveBeenCalledExactlyOnceWith("overwrite");
  });

  it("keeps overwrite available for invalid UTF-8 while disabling reload and explaining the preview", async () => {
    const t = mount({ error: "Disk contents are not valid UTF-8. Reload is unavailable.", kind: "conflict", disk: { token: "raw-byte-token", exists: true, text: "lossy preview �", truncated: false } });
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click(); await settle();
    const reload = Array.from(t.root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Reload from Disk"))!;
    const overwrite = t.root.querySelector<HTMLButtonElement>(".external-conflict-destructive")!;
    expect(t.root.querySelector('[role="note"]')?.textContent).toContain("not valid UTF-8");
    expect(reload.disabled).toBe(true);
    expect(overwrite.disabled).toBe(false);
    overwrite.click(); await settle();
    expect(t.onResolve).toHaveBeenCalledExactlyOnceWith("overwrite");
  });

  it("offers full-draft copy when disk contents are unavailable, without resolving the conflict", async () => {
    const onCopy = vi.fn(async (_text: string) => {});
    const fullDraft = `${"draft text ".repeat(7000)}full tail`;
    const t = mount({ kind: "unavailable", disk: null, error: "Permission denied while reading the disk file." }, { currentText: fullDraft, onCopy });
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click(); await settle();
    const copy = Array.from(t.root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Copy editor draft"))!;
    expect(copy).toBeTruthy();
    copy.click(); await settle();
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(fullDraft);
    expect(t.onResolve).not.toHaveBeenCalled();
    expect(t.root.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps the comparison and draft visible when an action fails", async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error("Disk write failed"));
    const t = mount({}, { currentText: "unsaved draft", onResolve });
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click(); await settle();
    t.root.querySelector<HTMLButtonElement>(".external-conflict-destructive")!.click(); await settle();
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain("Disk write failed");
    expect(t.root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(t.root.querySelector('[role="dialog"]')?.textContent).toContain("unsaved draft");
    expect(t.onClose).not.toHaveBeenCalled();
    Array.from(t.root.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Refresh comparison"))!.click();
    await settle();
    expect(t.onReview).toHaveBeenCalledTimes(2);
    expect(onResolve).toHaveBeenCalledOnce();
    expect(t.root.querySelector('[role="dialog"]')?.textContent).toContain("Disk write failed");
  });

  it("limits previews without altering the caller's text", async () => {
    const text = `${"x".repeat(64 * 1024)}😀tail`;
    const t = mount({}, { currentText: text });
    t.root.querySelector<HTMLButtonElement>(".external-conflict-review")!.click(); await settle();
    expect(t.root.querySelector(".external-conflict-truncated")?.textContent).toContain("draft itself is unchanged");
    expect(t.root.textContent).not.toContain("tail");
    expect(text.endsWith("😀tail")).toBe(true);
  });
});
