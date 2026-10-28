import type { ConfigOptionView } from "../components/agent/types";

/**
 * Which composer popover shows a session config option. Routing uses the ACP category only, never an agent's name
 * or an option's label: `model` goes to the model list, `thought_level` to the effort slider inside the model
 * popover, and `mode` plus every other select or on/off option the agent reports goes to the mode popover, so
 * nothing the agent offers is lost.
 */
export type Picker = "model" | "effort" | "mode";

export type PickerGroups = Record<Picker, ConfigOptionView[]>;

export function pickerFor(category: string | undefined): Picker {
  if (category === "model") return "model";
  if (category === "thought_level") return "effort";
  return "mode";
}

/** Splits the options into the three pickers. Options without choices are dropped; the mode category leads its group. */
export function groupOptions(options: readonly ConfigOptionView[]): PickerGroups {
  const groups: PickerGroups = { model: [], effort: [], mode: [] };
  for (const option of options) {
    if (option.choices.length) groups[pickerFor(option.category)].push(option);
  }
  groups.mode.sort((a, b) => Number(b.category === "mode") - Number(a.category === "mode"));
  return groups;
}

/** The model popover holds the model list and the effort slider. */
export const hasModelPicker = (groups: PickerGroups) => groups.model.length + groups.effort.length > 0;
export const hasModePicker = (groups: PickerGroups) => groups.mode.length > 0;

/** The option whose current choice labels the mode chip: the mode category, else the first other option. */
export const modeChipOption = (groups: PickerGroups): ConfigOptionView | undefined => groups.mode[0];

const ON = ["true", "on", "enabled", "yes"];
const OFF = ["false", "off", "disabled", "no"];

/** True for an option with exactly two choices that read as on and off. */
export function isBooleanOption(option: ConfigOptionView): boolean {
  if (option.choices.length !== 2) return false;
  const values = option.choices.map((choice) => choice.value.toLowerCase());
  return values.some((value) => ON.includes(value)) && values.some((value) => OFF.includes(value));
}
