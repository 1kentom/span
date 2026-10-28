// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createSyntaxColorsEffect, overridesFor, type SyntaxColorSettings } from "./syntax-colors-effect";
import { defaultPalette, type SyntaxTheme } from "./syntax-palette";

// Fixture test: a detached element stands in for the document root.
function setup(initialTheme: SyntaxTheme, initialColors: SyntaxColorSettings) {
  const element = document.createElement("div");
  element.setAttribute("data-theme", initialTheme);
  const [theme, setTheme] = createSignal<SyntaxTheme>(initialTheme);
  const [colors, setColors] = createSignal<SyntaxColorSettings>(initialColors);
  const dispose = createRoot(dispose => { createSyntaxColorsEffect(() => element, theme, colors); return dispose; });
  return { element, setTheme, setColors, dispose };
}

describe("fixture: live syntax colour effect", () => {
  it("applies the active theme overrides at startup", () => {
    const s = setup("dark", { dark: { importPath: "#112233" }, light: { importPath: "#445566" } });
    expect(s.element.style.getPropertyValue("--syn-importPath")).toBe("#112233");
    s.dispose();
  });

  it("follows setting changes, theme switches and clears removed overrides", () => {
    const s = setup("dark", { dark: { importPath: "#112233" } });
    s.setColors({ dark: { importPath: "#112233", keyword: "#abc" } });
    expect(s.element.style.getPropertyValue("--syn-keyword")).toBe("#abc");
    s.setColors({ dark: { keyword: "#abc" } });
    expect(s.element.style.getPropertyValue("--syn-importPath")).toBe("");
    s.setColors({ dark: { keyword: "#abc" }, light: { string: "#010203" } });
    s.setTheme("light");
    expect(s.element.getAttribute("data-theme")).toBe("light");
    expect(s.element.style.getPropertyValue("--syn-keyword")).toBe("");
    expect(s.element.style.getPropertyValue("--syn-string")).toBe("#010203");
    s.setColors(undefined);
    expect(s.element.style.getPropertyValue("--syn-string")).toBe("");
    expect(s.element.style.getPropertyValue("--syn-importPath")).toBe("");
    s.dispose();
  });

  it("ignores invalid colours and unknown ids", () => {
    expect(overridesFor({ dark: { keyword: "red", nonsense: "#fff", string: "#ABCDEF" } }, "dark")).toEqual({ string: "#abcdef" });
    expect(overridesFor({ dark: "x" as never }, "dark")).toEqual({});
    expect(overridesFor(null, "dark")).toEqual({});
    expect(defaultPalette("dark").keyword).toBeTruthy();
  });
});
