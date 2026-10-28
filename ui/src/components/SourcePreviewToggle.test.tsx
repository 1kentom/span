// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it } from "vitest";
import type { MarkdownView } from "../bindings";
import { SourcePreviewToggle } from "./SourcePreviewToggle";

describe("icon-only source and preview modes", () => {
  it("exposes labeled radios with one keyboard tab stop and no visible text segments", () => {
    const host = document.createElement("div"); document.body.append(host);
    const [value, setValue] = createSignal<MarkdownView>("preview");
    const dispose = render(() => <SourcePreviewToggle value={value()} onChange={setValue} />, host);
    try {
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(["Source", "Preview", "Source and preview"]);
      expect(buttons.map(button => button.title)).toEqual(["Source", "Preview", "Source and preview"]);
      expect(buttons.map(button => button.querySelector<HTMLElement>(".icon")?.style.maskImage)).toEqual(["source", "preview", "both"].map(mode => `url("/icons/markdown-view-${mode}.svg")`));
      expect(buttons.map(button => button.tabIndex)).toEqual([-1, 0, -1]);
      expect(buttons.every(button => button.textContent === "" && button.querySelector('[aria-hidden="true"].icon'))).toBe(true);
      buttons[0].click();
      expect(value()).toBe("source");
      expect(buttons[0].getAttribute("aria-checked")).toBe("true");
      buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(value()).toBe("both"); expect(document.activeElement).toBe(buttons[2]);
      buttons[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(value()).toBe("source"); expect(document.activeElement).toBe(buttons[0]);
    } finally { dispose(); host.remove(); }
  });
});
