import { describe, expect, it } from "vitest";
import { friendlyError } from "./friendly-error";

describe("friendlyError", () => {
  it("explains a full disk and keeps the raw text as detail", () => {
    const raw = "Create atomic save /Users/u/.config/span/.session.json.span-66682-18: No space left on device (os error 28)";
    const result = friendlyError(raw);
    expect(result.message).toMatch(/disk is full/i);
    expect(result.message).not.toContain("os error");
    expect(result.detail).toBe(raw);
  });
  it("explains permission and read-only failures", () => {
    expect(friendlyError("Write atomic save /x: Permission denied (os error 13)").message).toMatch(/permission/i);
    expect(friendlyError("Create atomic save /x: Read-only file system (os error 30)").message).toMatch(/read-only/i);
  });
  it("passes other messages through without detail", () => {
    expect(friendlyError("Something odd")).toEqual({ message: "Something odd" });
  });
});
