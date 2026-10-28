import { describe, expect, it } from "vitest";
import type { ConfigOptionView } from "../components/agent/types";
import { groupOptions, hasModePicker, hasModelPicker, isBooleanOption, modeChipOption, pickerFor } from "./agent-options";

const select = (id: string, name: string, category: string | undefined, values: string[], current = values[0]): ConfigOptionView => ({
  id,
  name,
  category,
  currentValue: current,
  choices: values.map((value) => ({ value, name: value })),
});

const codex: ConfigOptionView[] = [
  select("mode", "Mode", "mode", ["read-only", "workspace", "agent", "agent-full-access"], "agent"),
  select("model", "Model", "model", ["6.1 Sol", "6 Astra", "6.1 Terra", "6 Sol", "6 Luna", "5.6 Sol", "5.6 Terra", "5.6 Luna"]),
  select("reasoning_effort", "Reasoning effort", "thought_level", ["low", "medium", "high", "xhigh", "max"], "medium"),
  select("collaboration_mode", "Collaboration mode", undefined, ["default", "plan"]),
  select("fast_mode", "Fast mode", undefined, ["off", "on"]),
];
const claude: ConfigOptionView[] = [
  select("model", "Model", "model", ["default", "opus", "haiku", "sonnet"]),
  select("effort", "Effort", "thought_level", ["low", "medium", "high"]),
  select("mode", "Mode", "mode", ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]),
];
const gemini: ConfigOptionView[] = [
  select("mode", "Mode", "mode", ["default", "yolo"]),
  select("model", "Model", "model", ["gemini-2.5-pro", "gemini-2.5-flash"]),
];
const ids = (options: readonly ConfigOptionView[]) => options.map((option) => option.id);

describe("groupOptions", () => {
  it.each([
    ["Codex", codex, ["model"], ["reasoning_effort"], ["mode", "collaboration_mode", "fast_mode"]],
    ["Claude", claude, ["model"], ["effort"], ["mode"]],
    ["Gemini legacy fields", gemini, ["model"], [], ["mode"]],
  ] as const)("routes the %s options by category: model list, effort slider, then mode and the rest", (_agent, options, model, effort, mode) => {
    const groups = groupOptions(options);
    expect(ids(groups.model)).toEqual(model);
    expect(ids(groups.effort)).toEqual(effort);
    expect(ids(groups.mode)).toEqual(mode);
  });

  it("puts the mode category first, then every other option in the order the agent reported", () => {
    const options = [select("b", "B", "experimental", ["x", "y"]), select("a", "A", undefined, ["1", "2"]), select("m", "Mode", "mode", ["ask", "code"])];
    expect(ids(groupOptions(options).mode)).toEqual(["m", "b", "a"]);
  });

  it("sends options with an unknown category and boolean options to the mode popover", () => {
    const toggle = select("web_search", "Web search", undefined, ["true", "false"]);
    const unknown = select("sandbox", "Sandbox", "_vendor_sandbox", ["strict", "loose"]);
    const groups = groupOptions([toggle, unknown]);
    expect(ids(groups.mode)).toEqual(["web_search", "sandbox"]);
    expect(groups.model).toEqual([]);
    expect(groups.effort).toEqual([]);
  });

  it("drops options without choices so no empty heading is drawn", () => {
    const groups = groupOptions([select("model", "Model", "model", []), select("effort", "Effort", "thought_level", []), select("x", "X", undefined, [])]);
    expect(groups).toEqual({ model: [], effort: [], mode: [] });
    expect(hasModelPicker(groups)).toBe(false);
    expect(hasModePicker(groups)).toBe(false);
  });

  it("offers each popover only when it has something to show", () => {
    expect([hasModelPicker(groupOptions(codex)), hasModePicker(groupOptions(codex))]).toEqual([true, true]);
    const onlyEffort = groupOptions([select("effort", "Effort", "thought_level", ["low", "high"])]);
    expect([hasModelPicker(onlyEffort), hasModePicker(onlyEffort)]).toEqual([true, false]);
    const onlyMode = groupOptions([select("mode", "Mode", "mode", ["a", "b"])]);
    expect([hasModelPicker(onlyMode), hasModePicker(onlyMode)]).toEqual([false, true]);
    expect([hasModelPicker(groupOptions([])), hasModePicker(groupOptions([]))]).toEqual([false, false]);
  });

  it("does not depend on agent names or labels", () => {
    const renamed = codex.map((option) => ({ ...option, name: `${option.name} (renamed)` }));
    expect(ids(groupOptions(renamed).mode)).toEqual(["mode", "collaboration_mode", "fast_mode"]);
  });
});

describe("pickerFor", () => {
  it.each([
    ["model", "model"],
    ["thought_level", "effort"],
    ["mode", "mode"],
    [undefined, "mode"],
    ["something_new", "mode"],
  ] as const)("maps category %s to the %s picker", (category, picker) => {
    expect(pickerFor(category)).toBe(picker);
  });
});

describe("modeChipOption", () => {
  it("labels the chip with the mode category, or the first other option when there is none", () => {
    expect(modeChipOption(groupOptions(codex))?.id).toBe("mode");
    expect(modeChipOption(groupOptions([select("fast_mode", "Fast mode", undefined, ["off", "on"])]))?.id).toBe("fast_mode");
    expect(modeChipOption(groupOptions(claude.slice(0, 2)))).toBeUndefined();
  });
});

describe("isBooleanOption", () => {
  it.each([
    [["true", "false"], true],
    [["off", "on"], true],
    [["On", "Off"], true],
    [["enabled", "disabled"], true],
    [["default", "plan"], false],
    [["on"], false],
    [["on", "off", "auto"], false],
  ] as const)("treats %j as boolean: %s", (values, expected) => {
    expect(isBooleanOption(select("x", "X", undefined, [...values]))).toBe(expected);
  });
});

describe("fallbackModels", () => {
  it("lists the other models with free ones first and never the current one", async () => {
    const { fallbackModels } = await import("./agent-options");
    const model = { id: "model", name: "Model", category: "model", currentValue: "a/paid", choices: [{ value: "a/paid", name: "Paid" }, { value: "b/other", name: "Other" }, { value: "opencode/big-pickle", name: "Big Pickle" }, { value: "x/beam-free", name: "Beam Free" }] };
    expect(fallbackModels([model as never]).map((choice) => choice.value)).toEqual(["opencode/big-pickle", "x/beam-free", "b/other"]);
    expect(fallbackModels([])).toEqual([]);
  });
});
