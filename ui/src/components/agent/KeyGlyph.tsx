import { Show } from "solid-js";
import Icon from "../Icon";

/** The Enter key as key cap data. Pass it to KeyGlyph, which renders the library return icon, never this text glyph. */
export const ENTER_KEY = "\u21b5";

/** Glyphs that stand for the Enter key in hint data. They render as the library return icon, not as a text glyph. */
const ENTER_GLYPHS = new Set([ENTER_KEY, "\u21a9", "\u23ce"]);

export function isEnterGlyph(value: string): boolean {
  return ENTER_GLYPHS.has(value);
}

/** One key cap's content: the Enter key is an icon with a screen reader label, every other key stays text. */
export function KeyGlyph(props: { value: string; size?: number }) {
  return (
    <Show when={isEnterGlyph(props.value)} fallback={props.value}>
      <Icon name="key-enter" size={props.size ?? 12} class="key-enter" />
      <span class="sb-sr">Enter</span>
    </Show>
  );
}
