import { describe, expect, it } from "vitest";
import { terminalFontFamily, terminalTheme } from "./terminal-theme";
const keys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

describe("terminal app palette", () => {
  it("resolves all ANSI colours, selection and cursor from the current app CSS tokens", () => {
    const tokens: Record<string, string> = { "--island": "#fff", "--text": "#252629", "--strong": "#090909", "--sel": "#e0e1e4", "--hover": "#f2f3f4", "--scroll": "#c3c5c9" };
    for (const [index, key] of keys.entries()) tokens[`--terminal-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] = `#${(index + 1).toString(16).padStart(6, "0")}`;
    const style = { getPropertyValue: (key: string) => tokens[key] || "" };
    const palette = terminalTheme(style);
    expect(palette).toMatchObject({ background: "#fff", foreground: "#252629", cursor: "#090909", cursorAccent: "#fff", selectionBackground: "#e0e1e4", selectionForeground: "#090909", selectionInactiveBackground: "#f2f3f4", scrollbarSliderBackground: "#c3c5c9" });
    expect(keys.map(key => palette[key])).toEqual(keys.map((_key, index) => `#${(index + 1).toString(16).padStart(6, "0")}`));
    tokens["--terminal-blue"] = "#cac5ff"; tokens["--island"] = "#17172b";
    expect(terminalTheme(style)).toMatchObject({ background: "#17172b", cursorAccent: "#17172b", blue: "#cac5ff" });
  });
});


it("keeps every chosen local terminal font on a monospace fallback", () => {
  expect(terminalFontFamily("JetBrains Mono")).toBe('"JetBrains Mono", monospace');
  expect(terminalFontFamily("Menlo")).toBe('"Menlo", monospace');
  expect(terminalFontFamily("ui-monospace")).toBe("ui-monospace");
  expect(terminalFontFamily('"JetBrains Mono", monospace')).toBe('"JetBrains Mono", monospace');
});
