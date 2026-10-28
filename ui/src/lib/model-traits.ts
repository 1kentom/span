/**
 * Span-maintained hints about models. ACP does not define model traits, so
 * everything here is a guess from a model's display name or description, used
 * only to decorate the picker. Nothing here decides behaviour or capability.
 * This is the only module with model knowledge: extend the tables below.
 * Unknown models get no trait, never a guess.
 */

export type ModelTrait = "fast" | "frontier" | "balanced" | "reasoning" | "recommended";

export type TraitInfo = {
  /** Short accessible label, also the tooltip. */
  label: string;
  /** Text for the chip after the model name. */
  chip: string;
  /** Icon in public/icons, if the trait has one. */
  icon?: string;
};

export const TRAIT_INFO: Record<ModelTrait, TraitInfo> = {
  fast: { label: "Fast model", chip: "Fast", icon: "FlashLinear" },
  frontier: { label: "Most capable", chip: "Most capable", icon: "MagicStar" },
  balanced: { label: "Balanced model", chip: "Balanced" },
  reasoning: { label: "Reasoning model", chip: "Reasoning" },
  recommended: { label: "Recommended", chip: "Recommended" },
};

/** Which chip wins when a model has several non-fast traits. */
export const CHIP_PRIORITY: readonly ModelTrait[] = ["recommended", "frontier", "reasoning", "balanced"];

type Rule = { pattern: RegExp; trait: ModelTrait };

/** Matched against the lowercased display name. `\b` keeps "mini" out of "gemini". */
export const NAME_RULES: readonly Rule[] = [
  { pattern: /\b(haiku|mini|flash|nano|lite|spark|instant|turbo|fast)\b/, trait: "fast" },
  { pattern: /\b(opus|fable|pro|max|ultra)\b/, trait: "frontier" },
  { pattern: /\bsonnet\b/, trait: "balanced" },
  { pattern: /\b(thinking|reasoning|o\d)\b/, trait: "reasoning" },
  { pattern: /recommended|\bdefault\b/, trait: "recommended" },
];

/** Matched against the lowercased description. Keep this list small. */
export const DESCRIPTION_RULES: readonly Rule[] = [
  // "Fastest for quick answers" (Claude), "Fast and affordable model for easier tasks" (Codex).
  { pattern: /\bfast(er|est)?\b|\bquick(er|est)?\b/, trait: "fast" },
  // "Most capable for ..." and "Frontier intelligence for the most demanding work" (Codex).
  { pattern: /most capable|toughest|hardest|most demanding|\bfrontier\b/, trait: "frontier" },
  // "Latest workhorse model for coding and everyday work", "Older balanced model for straightforward work".
  { pattern: /\bbalanced\b|\bworkhorse\b/, trait: "balanced" },
];

export type TraitInput = { name: string; description?: string };
export type TraitContext = {
  /** True only for the current model, when a boolean config option named fast is on. */
  fastOn?: boolean;
};

const ORDER: readonly ModelTrait[] = ["fast", "frontier", "balanced", "reasoning", "recommended"];

/** Traits for one model choice, in a stable order, without duplicates. */
export function modelTraits(choice: TraitInput, context: TraitContext = {}): ModelTrait[] {
  const found = new Set<ModelTrait>();
  const name = choice.name.toLowerCase();
  const description = (choice.description ?? "").toLowerCase();
  for (const rule of NAME_RULES) if (rule.pattern.test(name)) found.add(rule.trait);
  for (const rule of DESCRIPTION_RULES) if (rule.pattern.test(description)) found.add(rule.trait);
  if (context.fastOn) found.add("fast");
  return ORDER.filter((trait) => found.has(trait));
}

/** The one trait shown as a chip after the name, if any. Fast lives on the icon overlay. */
export function chipTrait(traits: readonly ModelTrait[], name: string): ModelTrait | undefined {
  const trait = CHIP_PRIORITY.find((candidate) => traits.includes(candidate));
  // A name that already says "recommended" does not need a chip repeating it.
  if (trait === "recommended" && /recommended/i.test(name)) return undefined;
  return trait;
}

/** Whether a config option is an explicit on/off switch named fast. */
export function isFastSwitchOn(option: { id: string; name: string; currentValue: string }): boolean {
  const named = /^fast(\s*mode)?$/i.test(option.id.trim()) || /^fast(\s*mode)?$/i.test(option.name.trim());
  return named && ["true", "on", "enabled", "yes"].includes(option.currentValue.toLowerCase());
}
