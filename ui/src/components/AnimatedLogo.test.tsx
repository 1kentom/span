// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimatedLogo } from "./AnimatedLogo";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
describe("animated span logo", () => {
  it("uses the intact supplied artwork with one accessible name and reserved space", () => {
    const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => <AnimatedLogo size={96} label="Welcome to span" />, root));
    const wrapper = root.querySelector<HTMLElement>('[role="img"]')!;
    const image = root.querySelector("img")!;
    expect(wrapper.getAttribute("aria-label")).toBe("Welcome to span");
    expect(wrapper.style.width).toBe("96px");
    expect(parseFloat(wrapper.style.height)).toBeCloseTo(96 * 969 / 916);
    expect(image.getAttribute("src")).toBe("/span-logo.svg");
    expect(image.alt).toBe("");
    expect(image.getAttribute("width")).toBe("916");
    expect(image.getAttribute("height")).toBe("969");
  });
  it("uses CSS transforms and disables all motion for reduced-motion users", () => {
    const css = readFileSync(resolve("src/styles/animated-logo.css"), "utf8");
    expect(css).toMatch(/@media\(prefers-reduced-motion:no-preference\)/);
    expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.animated-logo-artwork\{animation:none;transform:none;will-change:auto\}\}/);
    expect(css).toContain("@keyframes span-logo-drift");
    expect(css).not.toMatch(/filter:|box-shadow:|transition:all/);
    const component = readFileSync(resolve("src/components/AnimatedLogo.tsx"), "utf8");
    expect(component).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/);
  });
});
