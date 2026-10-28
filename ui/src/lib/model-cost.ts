/**
 * What a model costs the user, guessed from its id only. ACP carries no pricing, so this only decorates and filters
 * the picker, and only for agents that name models `provider/model` (OpenCode). A model with no provider prefix, such
 * as Claude's or Codex's own, gets no tier: nothing here is ever a guess about those.
 */
export type ModelCost = "free" | "subscription" | "paid";

export const COST_INFO: Record<ModelCost, { label: string; chip: string }> = {
  free: { label: "Free to use", chip: "Free" },
  subscription: { label: "Needs a subscription plan", chip: "Subscription" },
  paid: { label: "Billed per use", chip: "Paid" },
};

export const COST_ORDER: readonly ModelCost[] = ["free", "subscription", "paid"];

/** Explicit free markers in an id or name, plus OpenCode's free Big Pickle model. */
const FREE = /(^|[\s/:._-])free($|[\s/:._-])|big-pickle/i;

export function modelCost(choice: { value: string; name: string }): ModelCost | undefined {
  if (!choice.value.includes("/")) return undefined;
  if (FREE.test(choice.value) || FREE.test(choice.name)) return "free";
  // OpenCode Go is OpenCode's subscription plan; its other hosted models are billed per use.
  if (choice.value.startsWith("opencode-go/")) return "subscription";
  return "paid";
}

/** True when the list mixes free models with others, so a free-only view means something. */
export function hasCostTiers(choices: readonly { value: string; name: string }[]): boolean {
  const tiers = new Set(choices.map(modelCost));
  return tiers.has("free") && (tiers.has("subscription") || tiers.has("paid"));
}

const KEY = "span.agent.freeModelsOnly";
export function readFreeOnly(): boolean {
  try { return window.localStorage.getItem(KEY) !== "false"; } catch { return true; }
}
export function writeFreeOnly(value: boolean) {
  try { window.localStorage.setItem(KEY, String(value)); } catch { /* storage can be unavailable */ }
}
