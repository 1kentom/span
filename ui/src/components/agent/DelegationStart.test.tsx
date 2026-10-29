// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DelegationCard } from "./DelegationCard";
import { mount, text } from "./test-utils";

describe("DelegationCard while Span starts the agent", () => {
  it("says Starting <agent> with a spinner and offers no cancel or prompt", () => {
    const cancel = vi.fn(async () => {});
    const host = mount(() => <DelegationCard agent="Claude" status="starting" taskId="starting:claude-acp:1" onCancel={cancel} />);
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Starting");
    expect(text(host.querySelector(".sb-delegation-starting"))).toBe("Starting Claude");
    expect(host.querySelector(".sb-delegation")?.getAttribute("aria-label")).toBe("Starting Claude");
    expect(host.querySelector(".sb-spinner")).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("[role=dialog]")).toBeNull();
  });
});
