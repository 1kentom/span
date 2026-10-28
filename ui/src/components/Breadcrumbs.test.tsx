// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { Breadcrumbs } from "./Breadcrumbs";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
async function settle() { for (let index = 0; index < 5; index += 1) await Promise.resolve(); }

describe("path breadcrumbs", () => {
  it("lists real siblings and traverses child folders before opening a file", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const list = vi.fn(async (path: string) => path === "public" ? [{ path: "public/img", name: "img", isDir: true }, { path: "public/index.html", name: "index.html", isDir: false }] : [{ path: "public/img/icon.svg", name: "icon.svg", isDir: false }]);
    const open = vi.fn(); const reveal = vi.fn();
    disposers.push(render(() => <Breadcrumbs path="public/img/logo.svg" workspace={{ name: "Console-HTX", root: "/work/Console-HTX" }} listDirectory={list} onOpen={open} onReveal={reveal} />, root));
    root.querySelectorAll<HTMLButtonElement>(".breadcrumb-part")[1].click(); await settle();
    expect(list).toHaveBeenLastCalledWith("public");
    const folder = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === "img/")!;
    folder.click(); await settle(); expect(list).toHaveBeenLastCalledWith("public/img"); expect(reveal).toHaveBeenCalledWith("public/img");
    root.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    expect(open).toHaveBeenCalledWith("public/img/icon.svg"); expect(root.querySelector('[role="menu"]')).toBeNull();
  });
  it("supports keyboard context menus with the actual selected path", () => {
    const root = document.createElement("div"); document.body.append(root); const context = vi.fn();
    disposers.push(render(() => <Breadcrumbs path="src/editor.ts" listDirectory={vi.fn()} onOpen={vi.fn()} onContextMenu={context} />, root));
    const file = root.querySelectorAll<HTMLButtonElement>(".breadcrumb-part")[1];
    file.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    expect(context).toHaveBeenCalledOnce(); expect(context.mock.calls[0][1]).toBe("src/editor.ts"); expect(context.mock.calls[0][2]).toBe(false);
    const folder = root.querySelector<HTMLButtonElement>(".breadcrumb-part")!;
    folder.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
    expect(context.mock.calls[1][1]).toBe("src"); expect(context.mock.calls[1][2]).toBe(true);
  });
});
