import { render } from "solid-js/web";
import { describe, expect, it } from "vitest";
import { iconAssetPath } from "../../lib/menuIcons";
import { KeyGlyph, isEnterGlyph } from "./KeyGlyph";

function mount(value: string) {
  const host = document.createElement("div");
  const dispose = render(() => <kbd><KeyGlyph value={value} /></kbd>, host);
  return { host, dispose };
}

describe("KeyGlyph", () => {
  it("renders every Enter glyph as the library icon with a screen reader label and no text glyph", () => {
    for (const glyph of ["\u21b5", "\u21a9", "\u23ce"]) {
      expect(isEnterGlyph(glyph)).toBe(true);
      const { host, dispose } = mount(glyph);
      expect(host.querySelector(".key-enter")).not.toBeNull();
      expect(host.querySelector(".key-enter")?.getAttribute("aria-hidden")).toBe("true");
      expect(host.textContent).toBe("Enter");
      dispose();
    }
  });

  it("leaves other keys as text", () => {
    for (const key of ["\u21e7", "\u2325", "Tab", "/", "\u2191"]) {
      const { host, dispose } = mount(key);
      expect(host.querySelector(".key-enter")).toBeNull();
      expect(host.textContent).toBe(key);
      dispose();
    }
  });

  it("uses the vendored return icon from the Iconsax rounded linear set, as a separate file", async () => {
    expect(iconAssetPath("key-enter")).toBe("/icons/key-enter.svg");
    const { existsSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const file = resolve(__dirname, "../../../public/icons/key-enter.svg");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toMatch(/c2pa|<script|href=/i);
  });
});
