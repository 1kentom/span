import { createEffect } from "solid-js";
import { applyPalette, isTokenId, sanitizeOverrides, type SyntaxOverrides, type SyntaxTheme } from "./syntax-palette";

/** Effective `editor.syntaxColors` as stored in settings: theme id to token id to colour. */
export type SyntaxColorSettings = Record<string, Record<string, string>> | undefined | null;

/** Valid overrides of one theme, ignoring unknown theme and token ids. */
export function overridesFor(colors: SyntaxColorSettings, theme: SyntaxTheme): SyntaxOverrides {
  const raw = colors?.[theme];
  if (!raw || typeof raw !== "object") return {};
  return sanitizeOverrides(Object.fromEntries(Object.entries(raw).filter(([key]) => isTokenId(key))));
}

/**
 * Keeps the `--syn-*` variables of `root` in step with the settings: runs at startup and whenever
 * the theme or the colours change, and removes variables whose override disappeared. The root must
 * already carry the active `data-theme`.
 */
export function createSyntaxColorsEffect(root: () => HTMLElement, theme: () => SyntaxTheme, colors: () => SyntaxColorSettings): void {
  createEffect(() => {
    const active = theme();
    const overrides = overridesFor(colors(), active);
    const element = root();
    if (element.getAttribute("data-theme") !== active) element.setAttribute("data-theme", active);
    applyPalette(element, active, overrides);
  });
}
