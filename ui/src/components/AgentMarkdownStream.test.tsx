// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { AgentMarkdown } from "./AgentMarkdown";
import { initialAgentState, reduceAgentEvent } from "../lib/agent-session";
import type { AgentEvent } from "../bindings";

const cleanup: (() => void)[] = [];
let reduced = false;
beforeEach(() => {
  reduced = false;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout", "queueMicrotask"] });
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mountStream(initial = "") {
  const [text, setText] = createSignal(initial);
  const [streaming, setStreaming] = createSignal(true);
  const host = document.createElement("div");
  document.body.append(host);
  cleanup.push(render(() => <AgentMarkdown text={text()} workspaceRoot="/work" streaming={streaming()} />, host));
  const shown = () => (host.textContent ?? "").replace(/\s+/g, " ").trim();
  return { host, text, setText, setStreaming, shown };
}

const sentence = "The quick brown fox jumps over the lazy dog and keeps running through the field. ";

describe("AgentMarkdown streaming reveal", () => {
  it("reveals a chunk over several frames, never all at once", () => {
    const view = mountStream("");
    view.setText(sentence.repeat(3));
    vi.advanceTimersByTime(16);
    const early = view.shown().length;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(sentence.repeat(3).trim().length);
    vi.advanceTimersByTime(600);
    expect(view.shown()).toBe(sentence.repeat(3).trim());
  });

  it("keeps the full text in state for copy, export and the queue while the display catches up", () => {
    let state = initialAgentState();
    const chunk = (text: string) => ({ kind: "text", text } as unknown as AgentEvent);
    const body = sentence.repeat(10);
    for (let index = 0; index < body.length; index += 37) state = reduceAgentEvent(state, chunk(body.slice(index, index + 37)));
    const last = state.feed[state.feed.length - 1] as { kind: string; text: string };
    expect(last.kind).toBe("text");
    expect(last.text).toBe(body);
    const view = mountStream("");
    view.setText(last.text);
    vi.advanceTimersByTime(16);
    expect(view.shown().length).toBeLessThan(body.trim().length);
    // The prop, which is what copy and export read from the feed, is complete before the reveal finishes.
    expect(view.text()).toBe(body);
  });

  it("flushes the hidden rest within the flush window when the turn ends", () => {
    const view = mountStream("");
    const body = `${sentence.repeat(20)}half wor`;
    view.setText(body);
    vi.advanceTimersByTime(32);
    expect(view.shown().length).toBeLessThan(body.length);
    view.setStreaming(false);
    vi.advanceTimersByTime(200);
    expect(view.shown()).toBe(body.trim());
    expect(view.host.querySelector(".stream-revealing")).toBeNull();
  });

  it("holds back half a word while streaming", () => {
    const view = mountStream("");
    view.setText("Hello there wor");
    vi.advanceTimersByTime(200);
    expect(view.shown()).toBe("Hello there");
    view.setText("Hello there world, done. ");
    vi.advanceTimersByTime(400);
    expect(view.shown()).toBe("Hello there world, done.");
  });

  it("fades newly revealed words in with spans while streaming", () => {
    const view = mountStream("");
    view.setText(sentence.repeat(4));
    vi.advanceTimersByTime(48);
    expect(view.host.querySelectorAll(".stream-fresh").length).toBeGreaterThan(0);
  });

  it("with reduced motion shows the text on the next frame without fading", () => {
    reduced = true;
    const view = mountStream("");
    view.setText(sentence.repeat(4));
    expect(view.shown()).toBe("");
    vi.advanceTimersByTime(16);
    expect(view.shown()).toBe(sentence.repeat(4).trim());
    expect(view.host.querySelectorAll(".stream-fresh").length).toBe(0);
  });

  it("shows text that never streamed at once", () => {
    const host = document.createElement("div");
    document.body.append(host);
    cleanup.push(render(() => <AgentMarkdown text={sentence} workspaceRoot="/work" />, host));
    expect(host.textContent?.trim()).toBe(sentence.trim());
  });

  it("does not replay a long message that mounts mid stream", () => {
    const view = mountStream(sentence.repeat(10));
    expect(view.shown()).toBe(sentence.repeat(10).trim());
  });
});
