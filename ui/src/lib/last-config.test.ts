// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigOption } from "../bindings";
import { chooseRestores, readLastConfig, writeLastConfig } from "./last-config";

const option = (id: string, currentValue: string, values: string[]): ConfigOption => ({
  id, name: id, description: null, category: id, currentValue,
  groups: [{ name: "", choices: values.map((value) => ({ value, name: value, description: null })) }],
});

describe("chooseRestores", () => {
  it("restores the saved model when it is available", () => {
    expect(chooseRestores([option("model", "gpt", ["gpt", "luna"])], { model: "luna" })).toEqual([["model", "luna"]]);
  });
  it("skips a value equal to the current one", () => {
    expect(chooseRestores([option("model", "luna", ["gpt", "luna"])], { model: "luna" })).toEqual([]);
  });
  it("skips a choice that vanished", () => {
    expect(chooseRestores([option("model", "gpt", ["gpt"])], { model: "luna" })).toEqual([]);
  });
  // ADR 0015: a mode option Span manages is restored as the Span mode, never through the raw option.
  it("leaves the agent's mode option to the Span permission mode by default", () => {
    const mode = option("mode", "default", ["default", "agent-full-access", "bypassPermissions", "yolo"]);
    expect(chooseRestores([mode], { mode: "agent-full-access" })).toEqual([]);
    expect(chooseRestores([option("collaboration_mode", "default", ["default", "plan"])], { collaboration_mode: "plan" })).toEqual([]);
  });
  it("restores a remembered mode value of an agent Span does not manage", () => {
    const mode = option("mode", "default", ["default", "agent-full-access", "bypassPermissions", "yolo"]);
    expect(chooseRestores([mode], { mode: "agent-full-access" }, [])).toEqual([["mode", "agent-full-access"]]);
    expect(chooseRestores([mode], { mode: "bypassPermissions" }, [])).toEqual([["mode", "bypassPermissions"]]);
    expect(chooseRestores([mode], { mode: "yolo" }, [])).toEqual([["mode", "yolo"]]);
  });
  it("skips options the session no longer has", () => {
    expect(chooseRestores([option("model", "gpt", ["gpt"])], { effort: "high" })).toEqual([]);
  });
  it("keeps a safe mode", () => {
    expect(chooseRestores([option("mode", "default", ["default", "plan"])], { mode: "plan" }, [])).toEqual([["mode", "plan"]]);
  });
});

describe("last config storage", () => {
  beforeEach(() => window.localStorage.clear());
  it("stores values per agent and merges options", () => {
    writeLastConfig("codex", "model", "luna");
    writeLastConfig("codex", "effort", "high");
    writeLastConfig("claude", "model", "opus");
    expect(readLastConfig("codex")).toEqual({ model: "luna", effort: "high" });
    expect(readLastConfig("claude")).toEqual({ model: "opus" });
    expect(readLastConfig("none")).toEqual({});
  });
  it("survives corrupt storage", () => {
    window.localStorage.setItem("span.agent.lastConfig", "{nope");
    expect(readLastConfig("codex")).toEqual({});
    writeLastConfig("codex", "model", "a");
    expect(readLastConfig("codex")).toEqual({ model: "a" });
  });
});
