/** Normalised text (lowercase, separators as hyphens) for matching a mode value or name. */
export function normaliseChoice(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** Values that mean the agent runs tools without asking: full access, bypass permissions, danger modes. */
const DANGER = /full-access|bypass|danger/;

/** True when an already normalised mode value is one that skips approval. The mode icons use this same rule. */
export function isDangerKey(key: string): boolean {
  return DANGER.test(key);
}

/** True for a choice that skips approval, judged from its value or its display name. Used to never restore one. */
export function isDangerousChoice(value: string, name = ""): boolean {
  return [value, name].some((text) => {
    const key = normaliseChoice(text);
    return isDangerKey(key) || /yolo/.test(key);
  });
}
