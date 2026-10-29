import { describe, expect, it } from "vitest";
import { CATCH_UP_MS, FLUSH_MS, clampSurrogate, snapReveal, stepReveal, wordBoundary, type RevealState } from "./stream-reveal";

const FRAME = 16;
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ") + "\n";

/** Runs frames until caught up; returns every revealed length and the time it took. */
function run(text: string, start: RevealState, done = false, limit = 1000) {
  let state = start;
  const seen: number[] = [];
  let elapsed = 0;
  while (state.revealed < text.length && seen.length < limit) {
    state = stepReveal(text, state, FRAME, { done });
    elapsed += FRAME;
    seen.push(state.revealed);
  }
  return { seen, elapsed, state };
}

describe("stepReveal pacing", () => {
  it("shows everything at once with reduced motion", () => {
    const text = words(500);
    expect(stepReveal(text, { revealed: 0, rate: 0 }, FRAME, { reducedMotion: true })).toEqual({ revealed: text.length, rate: 0 });
  });

  it("catches up a large backlog within the catch-up window", () => {
    const text = words(800);
    const { elapsed, state } = run(text, { revealed: 0, rate: 0 });
    expect(state.revealed).toBe(text.length);
    expect(elapsed).toBeLessThanOrEqual(CATCH_UP_MS + 3 * FRAME);
  });

  it("reveals a small chunk steadily over several frames instead of at once", () => {
    const text = "Here is a short answer.\n";
    const first = stepReveal(text, { revealed: 0, rate: 0 }, FRAME);
    expect(first.revealed).toBeGreaterThan(0);
    expect(first.revealed).toBeLessThan(text.length);
    const { seen } = run(text, first);
    expect(seen.length).toBeGreaterThan(2);
  });

  it("flushes the remainder quickly when the turn is done", () => {
    const text = words(800);
    const { elapsed, state } = run(text, { revealed: 10, rate: 0 }, true);
    expect(state.revealed).toBe(text.length);
    expect(elapsed).toBeLessThanOrEqual(FLUSH_MS + 2 * FRAME);
  });

  it("never moves backwards or past the received text", () => {
    const text = words(300);
    const { seen } = run(text, { revealed: 0, rate: 0 });
    for (let index = 1; index < seen.length; index++) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]);
    expect(Math.max(...seen)).toBe(text.length);
  });

  it("stops on word boundaries while streaming", () => {
    const text = words(300);
    const { seen } = run(text, { revealed: 0, rate: 0 });
    for (const at of seen) expect(/\w/.test(text[at - 1] ?? "") && /\w/.test(text[at] ?? "")).toBe(false);
  });

  it("does nothing for zero elapsed time", () => {
    expect(stepReveal("hello there\n", { revealed: 0, rate: 0 }, 0).revealed).toBe(0);
  });
});

describe("boundaries", () => {
  it("never splits a surrogate pair", () => {
    const text = "\u{1F600}".repeat(200);
    expect(clampSurrogate(text, 1)).toBe(2);
    expect(clampSurrogate(text, 2)).toBe(2);
    const { seen } = run(text, { revealed: 0, rate: 0 }, true);
    for (const at of seen) {
      const code = text.charCodeAt(at - 1);
      expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
    }
  });

  it("holds back a word that may still be arriving, and shows it once done", () => {
    const text = "hello wor";
    expect(snapReveal(text, 0, text.length)).toBe(6);
    expect(snapReveal(text, 0, text.length, true)).toBe(text.length);
    expect(wordBoundary(text, 8).partial).toBe(true);
  });

  it("shows a code fence opener line whole", () => {
    const text = "Text\n```ts\nconst a = 1;\n";
    const at = snapReveal(text, 5, 7);
    expect(at).toBe(text.indexOf("\n", 5));
    expect(snapReveal("Text\n```t", 5, 8)).toBe(5);
  });

  it("shows a bold run whole or waits for its closer", () => {
    expect(snapReveal("say **bold words** now", 0, 8)).toBe(18);
    expect(snapReveal("say **bold wo", 0, 8)).toBe(4);
    expect(snapReveal("say `code span` now", 0, 7)).toBe(15);
  });

  it("never ends on an opening marker and keeps a closing one", () => {
    expect(snapReveal("say **bold** x", 0, 12)).toBe(12);
    expect(snapReveal("say **bold** and", 0, 11)).toBe(12);
    expect(snapReveal("a [link", 0, 3)).toBe(2);
  });

  it("keeps a finished line without a closer literal instead of waiting forever", () => {
    const text = "a __ b line\nnext line here\n";
    expect(snapReveal(text, 0, 7)).toBeGreaterThanOrEqual(7);
  });

  it("waits for an unfinished link target", () => {
    expect(snapReveal("see [docs](https://exa", 0, 12)).toBe(4);
    const whole = "see [docs](https://example.com) then";
    expect(snapReveal(whole, 0, 12)).toBe(whole.indexOf(")") + 1);
  });

  it("does not show a lone list marker that could render as a heading underline", () => {
    expect(snapReveal("Intro\n-", 0, 7)).toBe(6);
    expect(snapReveal("Intro\n- item more", 0, 7)).toBe(12);
  });

  it("shows a table header only with its delimiter row", () => {
    expect(snapReveal("| a | b |\n|---", 0, 3)).toBe(0);
    const table = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(snapReveal(table, 0, 3)).toBe(table.indexOf("\n", 10));
  });

  it("does not apply inline rules inside a code fence", () => {
    expect(snapReveal("```\nfoo **bar baz\n", 4, 9)).toBe(9);
    expect(snapReveal("foo **bar baz", 0, 5)).toBe(4);
  });
});
