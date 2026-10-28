// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BrandIcon } from "./BrandIcon";
import { mount } from "./agent/test-utils";

const identities = [
  { id: "claude-acp" },
  { id: "claude-acp", name: "Claude Agent" },
  { name: "Claude Code" },
  { name: "@agentclientprotocol/claude-agent-acp" },
  { name: "@zed-industries/claude-code-acp" },
  { id: "codex-acp" },
  { id: "opencode" },
  { id: "gemini" },
  { id: "github-copilot" },
  { id: "qwen-code" },
  { id: "mistral-vibe" },
];

describe("BrandIcon", () => {
  it.each(identities)("renders the brand image for %o", (identity) => {
    const host = mount(() => <BrandIcon {...identity} />);
    expect(host.querySelectorAll("img").length).toBe(2);
    expect(host.querySelector(".icon")).toBeNull();
    expect(host.querySelector("img")!.getAttribute("src")).toMatch(/^\/brands\//);
  });
  it("falls back to the generic icon for an unknown identity", () => {
    const host = mount(() => <BrandIcon name="Custom ACP command" />);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".icon")).not.toBeNull();
  });
});
