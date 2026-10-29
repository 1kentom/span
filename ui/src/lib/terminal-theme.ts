import type { ITheme } from "@xterm/xterm";

/** Resolve the editor's computed CSS palette into xterm's renderer colours. */
export function terminalTheme(style: Pick<CSSStyleDeclaration, "getPropertyValue">): ITheme {
  const color = (token: string, fallback: string) => style.getPropertyValue(token).trim() || fallback;
  const background = color("--island", "#18191b");
  const foreground = color("--text", "#e0e1e4");
  return {
    background, foreground,
    cursor: color("--strong", foreground), cursorAccent: background,
    selectionBackground: color("--sel", "#363739"),
    selectionForeground: color("--strong", foreground),
    selectionInactiveBackground: color("--hover", "#222325"),
    scrollbarSliderBackground: color("--scroll", "#2f3033"),
    scrollbarSliderHoverBackground: color("--dim", "#898e94"),
    scrollbarSliderActiveBackground: color("--faint", "#6e747b"),
    black: color("--terminal-black", color("--faint", "#6e747b")),
    red: color("--terminal-red", color("--error", "#d26979")),
    green: color("--terminal-green", color("--success", "#70bd8d")),
    yellow: color("--terminal-yellow", color("--warning", "#d4ae67")),
    blue: color("--terminal-blue", "#87c3ff"),
    magenta: color("--terminal-magenta", color("--accent", "#726cf9")),
    cyan: color("--terminal-cyan", "#8cc9d2"),
    white: color("--terminal-white", foreground),
    brightBlack: color("--terminal-bright-black", color("--dim", "#898e94")),
    brightRed: color("--terminal-bright-red", color("--diffDelText", "#d3a0a7")),
    brightGreen: color("--terminal-bright-green", color("--diffAddText", "#a3cbb0")),
    brightYellow: color("--terminal-bright-yellow", "#dfc69d"),
    brightBlue: color("--terminal-bright-blue", "#a7d4ff"),
    brightMagenta: color("--terminal-bright-magenta", "#b1a0dd"),
    brightCyan: color("--terminal-bright-cyan", "#b1e1e7"),
    brightWhite: color("--terminal-bright-white", color("--strong", "#fff")),
  };
}


/** Keep a monospace fallback even when a selected local font is unavailable. */
export function terminalFontFamily(family: string | undefined): string {
  const names = (family || "JetBrains Mono").split(",").map(name => name.trim()).filter(Boolean);
  const generic = /^(?:ui-monospace|monospace|system-ui|serif|sans-serif)$/i;
  const normalized = names.map(name => generic.test(name) ? name : JSON.stringify(name.replace(/^(["'])(.*)\1$/, "$2")));
  if (!names.some(name => /^(?:ui-monospace|monospace)$/i.test(name))) normalized.push("monospace");
  return normalized.join(", ");
}

const terminalFonts = new Map<string, Promise<string>>();
/** Fixed cell layout requires equal advances for spaces, narrow and wide Latin glyphs. */
export async function loadTerminalFont(family: string | undefined, size: number): Promise<string> {
  const requested = terminalFontFamily(family);
  if (typeof document === "undefined" || !document.fonts) return requested;
  const key = `${size}:${requested}`;
  const previous = terminalFonts.get(key);
  if (previous) return previous;
  const pending = (async () => {
    const fallback = terminalFontFamily("JetBrains Mono");
    try {
      await Promise.all([document.fonts.load(`${size}px ${requested}`), document.fonts.load(`${size}px ${fallback}`)]);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return fallback;
      context.font = `64px ${requested}`;
      const widths = ["i", "W", "0", " "].map(character => context.measureText(character.repeat(8)).width);
      return Math.max(...widths) - Math.min(...widths) < 0.05 ? requested : fallback;
    } catch { return fallback; }
  })();
  if (terminalFonts.size >= 64) terminalFonts.delete(terminalFonts.keys().next().value!);
  terminalFonts.set(key, pending);
  return pending;
}
