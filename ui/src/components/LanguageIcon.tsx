import { Show, createMemo } from "solid-js";
import { LANGUAGE_FALLBACK_ICON, languageIconFor } from "../lib/language-icons";
import Icon from "./Icon";
import "../styles/language-icons.css";

/**
 * One language logo by language id (or language server id). Both renderings are in the DOM and the
 * theme picks one in CSS, so switching themes never reloads anything. Unknown languages get the
 * neutral Iconsax glyph. Decorative: the caller names the language in text or a label.
 */
export function LanguageIcon(props: { language?: string | null; size?: number; class?: string }) {
  const asset = createMemo(() => languageIconFor(props.language));
  const size = () => props.size ?? 16;
  return <span class={`language-icon ${props.class ?? ""}`} data-language={asset()?.key ?? "unknown"} data-light={asset()?.light} data-dark={asset()?.dark}
    style={{ width: `${size()}px`, height: `${size()}px` }} aria-hidden="true">
    <Show when={asset()} fallback={<Icon name={LANGUAGE_FALLBACK_ICON} size={size()} />}>{logo => <>
      <img class="language-icon-color" src={logo().src} alt="" draggable={false} />
      <span class="language-icon-mono" style={{ "--language-mask": `url("${logo().src}")` }} />
    </>}</Show>
  </span>;
}

export default LanguageIcon;
