import { brandIconFor, type BrandIconAsset } from "./brand-icons";

/** A model vendor's mark: the agent brand files where the vendor is also an agent, otherwise a file in /brands/models. */
export type ModelBrand = BrandIconAsset & { name: string };

type Rule = {
  match: RegExp;
  id: string;
  name: string;
  /** An agent brand from brand-icons whose files this vendor reuses. */
  brand?: string;
  /** A file in /brands/models, for a vendor with no agent brand. */
  file?: string;
  mono?: boolean;
};

/**
 * Model id to vendor, after the rule table in taifa-ai's glyphs.ts. Order matters: the first match wins, so
 * Ministral sits before Mistral. Vendors that have no sourced mark (DeepSeek, NVIDIA, Meta, MiniMax) have no
 * rule at all, and stealth models such as Big Pickle or a bare "nova-" id match nothing: guessing a logo is worse
 * than showing the agent mark.
 */
const RULES: Rule[] = [
  { match: /^openai\/|\bgpt/, id: "openai", name: "OpenAI", brand: "openai" },
  { match: /^anthropic\/|\bclaude/, id: "claude", name: "Claude", brand: "claude" },
  { match: /^poolside\//, id: "poolside", name: "Poolside", file: "poolside.svg" },
  { match: /^dots-studio\//, id: "dots-studio", name: "Dots Studio", file: "dots-studio.png" },
  { match: /^z-ai\/|\bglm/, id: "glm", name: "Z.ai", brand: "glm" },
  { match: /^inclusionai\/|\bling-/, id: "inclusionai", name: "InclusionAI", file: "inclusionai.png" },
  { match: /cohere/, id: "cohere", name: "Cohere", file: "cohere.svg" },
  { match: /^ibm-granite\/|\bgranite/, id: "granite", name: "Granite", file: "granite.svg", mono: true },
  // Narrower than the source table's \bnova-: OpenCode serves unrelated stealth models named Nova.
  { match: /^amazon\/|\bamazon[-.]nova/, id: "amazon-nova", name: "Amazon Nova", file: "amazon-nova.png" },
  { match: /^groq\/|\ballam/, id: "groq", name: "Groq", file: "groq.png" },
  { match: /^nex-agi\/|\bnex-n/, id: "nex-agi", name: "Nex AGI", file: "nex-agi.png" },
  { match: /ministral/, id: "mistral", name: "Ministral", brand: "mistral" },
  { match: /mistral/, id: "mistral", name: "Mistral", brand: "mistral" },
  { match: /gemini/, id: "gemini", name: "Gemini", brand: "gemini" },
  { match: /gemma/, id: "gemini", name: "Gemma", brand: "gemini" },
  { match: /qwen/, id: "qwen", name: "Qwen", brand: "qwen" },
];

/** The text after a leading provider segment: "opencode/claude-opus-5-5" becomes "claude-opus-5-5". */
const afterProvider = (text: string) => text.replace(/^[^/\s]+\//, "");

/** The vendor mark for a model, or undefined when the model cannot be mapped. Branding only. */
export function modelBrandFor(model: { value: string; name: string }): ModelBrand | undefined {
  const candidates = [model.value, model.name]
    .filter(Boolean)
    .map((text) => text.trim().toLowerCase())
    .flatMap((text) => [text, afterProvider(text)]);
  const rule = RULES.find((entry) => candidates.some((text) => entry.match.test(text)));
  if (!rule) return undefined;
  if (rule.brand) {
    const asset = brandIconFor({ id: rule.brand });
    return asset && { ...asset, id: rule.id, name: rule.name };
  }
  const path = `/brands/models/${rule.file}`;
  return { id: rule.id, name: rule.name, light: path, dark: path, ...(rule.mono ? { mono: true } : {}) };
}
