import { describe, expect, it } from "vitest";
import { markState, type MarkInput } from "./agent-mark";

const rest: MarkInput = { connecting: false, running: false, toolActive: false, needsYou: false, failed: false, justFinished: false };

describe("markState", () => {
  it("rests when nothing is happening", () => expect(markState(rest)).toBe("idle"));
  it("breathes while the model thinks and orbits while a tool runs", () => {
    expect(markState({ ...rest, running: true })).toBe("thinking");
    expect(markState({ ...rest, running: true, toolActive: true })).toBe("running");
    expect(markState({ ...rest, connecting: true })).toBe("thinking");
  });
  it("nudges when the user is needed, even mid-turn", () => {
    expect(markState({ ...rest, running: true, toolActive: true, needsYou: true })).toBe("needs");
  });
  it("shows an error over everything and a pop right after a turn", () => {
    expect(markState({ ...rest, running: true, needsYou: true, failed: true })).toBe("error");
    expect(markState({ ...rest, justFinished: true })).toBe("done");
  });
});
