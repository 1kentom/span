import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CHIP_PRIORITY, DESCRIPTION_RULES, NAME_RULES, TRAIT_INFO, chipTrait, isFastSwitchOn, modelTraits } from "./model-traits";

const screenshot: [string, string | undefined, string[]][] = [
  ["Default (recommended)", "Sonnet 5.5", ["recommended"]],
  ["Opus 5.5", "For complex work and everyday tasks", ["frontier"]],
  ["Fable 5.1", "For your toughest challenges", ["frontier"]],
  ["Sonnet 5.5", "Most efficient for simpler tasks", ["balanced"]],
  ["Haiku 5.5", "Fastest for quick answers", ["fast"]],
  ["Haiku 4.5", undefined, ["fast"]],
  ["Sonnet 5", undefined, ["balanced"]],
  ["Opus 5", undefined, ["frontier"]],
  ["Fable 5", "Most capable for your hardest and longest-running tasks", ["frontier"]],
  ["Opus 4.8", undefined, ["frontier"]],
];

describe("model traits", () => {
  it.each(screenshot)("%s", (name, description, expected) => {
    expect(modelTraits({ name, description })).toEqual(expected);
  });
  it("gives Codex and unknown names no trait", () => {
    for (const name of ["gpt-6-luna", "5.6 Luna", "codex-auto-review", "gemini-3", "Custom model", "improve", "Promax1"]) expect(modelTraits({ name }), name).toEqual([]);
  });
  it("matches whole words so gemini is not mini", () => {
    expect(modelTraits({ name: "gemini-2.5-flash-lite" })).toEqual(["fast"]);
    expect(modelTraits({ name: "gemini-2.5-pro" })).toEqual(["frontier"]);
    expect(modelTraits({ name: "gpt-5-mini" })).toEqual(["fast"]);
    expect(modelTraits({ name: "o3" })).toEqual(["reasoning"]);
    expect(modelTraits({ name: "Sonnet 5 thinking" })).toEqual(["balanced", "reasoning"]);
  });
  it("uses description keywords only through the small list", () => {
    expect(modelTraits({ name: "Mystery", description: "Fastest for quick answers" })).toEqual(["fast"]);
    expect(modelTraits({ name: "Mystery", description: "Most capable" })).toEqual(["frontier"]);
    expect(modelTraits({ name: "Mystery", description: "Slow and careful" })).toEqual([]);
    expect(DESCRIPTION_RULES.length).toBeLessThanOrEqual(3);
  });
  it("adds fast from an explicit switch only when told it applies", () => {
    expect(modelTraits({ name: "Opus 5" }, { fastOn: true })).toEqual(["fast", "frontier"]);
    expect(modelTraits({ name: "Opus 5" }, { fastOn: false })).toEqual(["frontier"]);
    expect(isFastSwitchOn({ id: "fast", name: "Fast", currentValue: "true" })).toBe(true);
    expect(isFastSwitchOn({ id: "fast_mode", name: "Fast mode", currentValue: "on" })).toBe(true);
    expect(isFastSwitchOn({ id: "fast", name: "Fast", currentValue: "false" })).toBe(false);
    expect(isFastSwitchOn({ id: "model", name: "Model", currentValue: "true" })).toBe(false);
  });
  it("picks one chip and skips a recommended chip the name already says", () => {
    expect(chipTrait(["fast"], "Haiku")).toBeUndefined();
    expect(chipTrait(["frontier", "recommended"], "Default")).toBe("recommended");
    expect(chipTrait(["recommended"], "Default (recommended)")).toBeUndefined();
    expect(chipTrait(["balanced"], "Sonnet")).toBe("balanced");
  });
  it("exposes an extendable table with labels and real icons", () => {
    expect(NAME_RULES.every((rule) => rule.pattern instanceof RegExp && rule.trait in TRAIT_INFO)).toBe(true);
    expect(TRAIT_INFO.fast.label).toBe("Fast model");
    expect(TRAIT_INFO.frontier.label).toBe("Most capable");
    for (const trait of CHIP_PRIORITY) expect(TRAIT_INFO[trait].chip).toBeTruthy();
    for (const info of Object.values(TRAIT_INFO)) if (info.icon) expect(existsSync(resolve(__dirname, `../../public/icons/${info.icon}.svg`)), info.icon).toBe(true);
  });
});
