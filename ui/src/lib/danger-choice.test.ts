import { describe, expect, it } from "vitest";
import { isDangerousChoice } from "./danger-choice";

describe("isDangerousChoice", () => {
  it.each(["full-access", "agent-full-access", "bypassPermissions", "danger-full-access", "yolo", "Full Access"])("flags %s", (value) => {
    expect(isDangerousChoice(value)).toBe(true);
  });
  it("flags by display name", () => expect(isDangerousChoice("x1", "Bypass permissions")).toBe(true));
  it.each(["default", "plan", "read-only", "acceptEdits", "luna"])("allows %s", (value) => {
    expect(isDangerousChoice(value, value)).toBe(false);
  });
});
