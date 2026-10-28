import { describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { ProposalWidget, persistentDocumentChange, transactionEdits } from "./Editor";

function documentChange(before: string, after: string) {
  const change = persistentDocumentChange(Text.of(before.split("\n")), Text.of(after.split("\n")));
  return change ? { ...change, insert: change.insert.toString() } : undefined;
}

describe("document synchronization", () => {
  it("keeps an unchanged document untouched", () => {
    expect(documentChange("const value = 1;", "const value = 1;")).toBeUndefined();
  });

  it("replaces only the changed middle of a document", () => {
    expect(documentChange("const value = 1;\n", "const value = 25;\n")).toEqual({ from: 14, to: 15, insert: "25" });
  });

  it("never divides the shared high surrogate of two emoji", () => {
    expect(documentChange("a😀z", "a😁z")).toEqual({ from: 1, to: 3, insert: "😁" });
  });

  it("never divides a shared low surrogate in the suffix", () => {
    expect(documentChange("\ud83d\ude00", "\ud83c\ude00")).toEqual({ from: 0, to: 2, insert: "\ud83c\ude00" });
  });

  it("locates a change across recovery chunk boundaries", () => {
    const prefix = "a".repeat(4095);
    const suffix = "z".repeat(9000);
    expect(documentChange(`${prefix}😀${suffix}`, `${prefix}😁${suffix}`)).toEqual({ from: 4095, to: 4097, insert: "😁" });
  });

  it("serializes disjoint multi-cursor changes in original UTF-16 coordinates", () => {
    const state = EditorState.create({ doc: "😀 first\nsecond" });
    const transaction = state.update({ changes: [{ from: 3, to: 8, insert: "one" }, { from: 9, to: 15, insert: "two" }] });
    expect(transaction.newDoc.toString()).toBe("😀 one\ntwo");
    expect(transactionEdits(transaction.changes)).toEqual([{ from: 3, to: 8, insert: "one" }, { from: 9, to: 15, insert: "two" }]);
  });
});

describe("inline proposal review", () => {
  it("renders untrusted suggested code as text", () => {
    const suggested = '<script>window.compromised = true</script><img src="x" onerror="alert(1)">';
    const widget = new ProposalWidget({ id: "h1", from: 0, to: 4, before: "base", after: suggested }, 0, true, false, vi.fn());
    const element = widget.toDOM();
    expect(element.querySelector("script, img")).toBeNull();
    expect(element.querySelector(".cm-proposal-after pre")?.textContent).toBe(suggested);
  });

  it("reports explicit per-hunk choices and marks the current choice accessibly", () => {
    const toggle = vi.fn();
    const widget = new ProposalWidget({ id: "h1", from: 0, to: 4, before: "base", after: "next" }, 1, true, false, toggle);
    const element = widget.toDOM();
    const keep = element.querySelector<HTMLButtonElement>('[aria-label="Keep change 2"]')!;
    const skip = element.querySelector<HTMLButtonElement>('[aria-label="Skip change 2"]')!;
    expect(keep.getAttribute("aria-pressed")).toBe("true");
    expect(skip.getAttribute("aria-pressed")).toBe("false");
    skip.click();
    expect(toggle).toHaveBeenCalledWith("h1", false);
    keep.click();
    expect(toggle).toHaveBeenLastCalledWith("h1", true);
  });

  it("bounds a large hunk preview and disables choices during resolution", () => {
    const widget = new ProposalWidget({ id: "h1", from: 0, to: 0, before: "", after: "x".repeat(100_000) }, 0, false, true, vi.fn());
    const element = widget.toDOM();
    const preview = element.querySelector(".cm-proposal-after pre")?.textContent ?? "";
    expect(preview.length).toBeLessThan(12_100);
    expect(preview).toContain("Preview shortened");
    expect([...element.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("updates a chosen hunk without replacing its keyboard focus target", () => {
    const hunk = { id: "h1", from: 0, to: 4, before: "base", after: "next" };
    const toggle = vi.fn();
    const element = new ProposalWidget(hunk, 0, true, false, toggle).toDOM();
    const keep = element.querySelector("button");
    expect(new ProposalWidget(hunk, 0, false, false, toggle).updateDOM(element)).toBe(true);
    expect(element.querySelector("button")).toBe(keep);
    expect(keep?.getAttribute("aria-pressed")).toBe("false");
  });
});
