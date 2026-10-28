import { afterEach } from "vitest";
import { render } from "solid-js/web";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

export function mount(view: () => any) {
  const host = document.createElement("div");
  document.body.append(host);
  disposers.push(render(view, host));
  return host;
}

export const key = (name: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

export const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
