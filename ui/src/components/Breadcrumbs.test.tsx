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
  it("shows decorative Material icons for Java, SVG and Docker folder entries", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const entries = [
      { path: "src/App.java", name: "App.java", isDir: false },
      { path: "src/Controller.java", name: "Controller.java", isDir: false },
      { path: "src/logo.svg", name: "logo.svg", isDir: false },
      { path: "src/docker", name: "docker", isDir: true },
    ];
    const open = vi.fn();
    disposers.push(render(() => <Breadcrumbs path="src/App.java" listDirectory={async () => entries} onOpen={open} />, root));
    root.querySelector<HTMLButtonElement>(".breadcrumb-part")!.click(); await settle();
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(rows.map(row => row.textContent)).toEqual(["App.java", "Controller.java", "logo.svg", "docker/"]);
    expect(rows.map(row => row.querySelector("img")?.getAttribute("src"))).toEqual(["/material-icons/java.svg", "/material-icons/java.svg", "/material-icons/svg.svg", "/material-icons/folder-docker.svg"]);
    expect(rows.every(row => row.querySelector('.material-file-icon[aria-hidden="true"]'))).toBe(true);
    expect(rows.every(row => [...row.querySelectorAll("img")].every(image => image.alt === "" && image.draggable === false))).toBe(true);
    rows[1].focus(); rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("src/Controller.java");
  });

});
