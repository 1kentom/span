// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStatusBar } from "./AgentStatusBar";
import { mount } from "./test-utils";

const bar = (extra: { delegating?: boolean; delegationActive?: boolean }) =>
  mount(() => <AgentStatusBar text="Ready" running={false} input={{ connecting: false, toolActive: false, needsYou: false, failed: false }} hints={{ mode: "idle", hints: {} }} {...extra} />);

describe("the shuffle icon in the status row", () => {
  it("shows only while delegation is attached, with a label and no text", () => {
    expect(bar({}).querySelector(".agent-delegating")).toBeNull();
    const host = bar({ delegating: true });
    const icon = host.querySelector(".agent-delegating");
    expect(icon?.getAttribute("aria-label")).toBe("Agents work together");
    expect(icon?.getAttribute("title")).toBe("Agents work together");
    expect(icon?.textContent).toBe("");
    expect(host.textContent).not.toContain("Delegation on");
  });
  it("takes the accent class while a delegated agent is active", () => {
    expect(bar({ delegating: true }).querySelector(".agent-delegating.active")).toBeNull();
    expect(bar({ delegating: true, delegationActive: true }).querySelector(".agent-delegating.active")).not.toBeNull();
  });
  it("is the unmodified library icon, recorded with its hash", () => {
    const dir = resolve("public/icons");
    const manifest = JSON.parse(readFileSync(resolve(dir, "status-provenance.json"), "utf8")) as { assets: { asset: string; sourceSha256: string; assetSha256: string }[] };
    const entry = manifest.assets.find((asset) => asset.asset === "Shuffle.svg")!;
    const hash = createHash("sha256").update(readFileSync(resolve(dir, "Shuffle.svg"))).digest("hex");
    expect(entry.sourceSha256).toBe(hash);
    expect(entry.assetSha256).toBe(hash);
  });
});
