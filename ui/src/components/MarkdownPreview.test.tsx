// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Text } from "@codemirror/state";
import { MarkdownPreview, markdownDestination, parseMarkdown, renderMarkdownBlock } from "./MarkdownPreview";

const context = { documentPath: "/workspace/docs/guide.md", workspaceRoot: "/workspace" };
function renderMarkdown(text: string) {
  const root = document.createElement("div");
  root.innerHTML = parseMarkdown(text).map((block) => renderMarkdownBlock(block, context)).join("");
  return root;
}
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Markdown rendering", () => {
  it("renders tables, strikethrough, task lists, blockquotes, and nested formatting", () => {
    const root = renderMarkdown("# Guide\n\n| Name | State |\n| :--- | ---: |\n| *Span* | ~~old~~ **new** |\n\n- [x] Complete\n- [ ] Pending\n\n> A `quote`\n");
    expect(root.querySelector("h1")?.textContent).toBe("Guide");
    expect(root.querySelector("td em")?.textContent).toBe("Span");
    expect(root.querySelector("td s")?.textContent).toBe("old");
    expect(root.querySelector("blockquote code")?.textContent).toBe("quote");
    const checks = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checks.map((input) => [input.checked, input.disabled])).toEqual([[true, true], [false, true]]);
  });

  it("gives headings stable unique anchors, including colliding suffixes", () => {
    const root = renderMarkdown("# Hello *world*\n# Hello world\n# Hello world-1\n# Hello world\n");
    expect([...root.querySelectorAll("h1")].map((heading) => heading.id)).toEqual(["hello-world", "hello-world-1", "hello-world-1-1", "hello-world-2"]);
    expect(renderMarkdown("[Jump](#hello-world)").querySelector("a")?.dataset.markdownAnchor).toBe("hello-world");
  });

  it("escapes raw HTML, executable attributes, and code fence payloads", () => {
    const payload = '<script>window.compromised = true</script><img src="x" onerror="alert(1)">';
    const root = renderMarkdown(`${payload}\n\n\`\`\`html\n${payload}\n\`\`\`\n`);
    expect(root.querySelector("script,img,iframe,[onerror],[onclick]")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe(`${payload}\n`);
    expect(root.querySelector("pre code")?.getAttribute("data-language")).toBe("html");
    expect(root.textContent).toContain(payload);
  });

  it("blocks executable and ambiguous URL schemes", () => {
    for (const value of ["javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,evil", "file:///etc/passwd", "//tracking.test/pixel", "https://user:pass@example.com/", "https://example.com/\nscript", "\\\\server\\share"]) {
      expect(markdownDestination(value, context), value).toBeNull();
    }
    const root = renderMarkdown('[one](javascript:alert%281%29) [two](data:text/html,evil) [three](file:///etc/passwd) [four](jav&#x61;script:alert%281%29)');
    expect(root.querySelector("a[href]")).toBeNull();
  });

  it("highlights an HTML fence without turning its content into live elements", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const payload = '<img src="https://tracking.test/pixel" onerror="alert(1)"><script>alert(1)</script>';
    cleanup.push(render(() => <MarkdownPreview text={`\`\`\`html\n${payload}\n\`\`\``} {...context} />, host));
    await vi.waitFor(() => expect(host.querySelector("pre code span")).not.toBeNull());
    expect(host.querySelector("img,script,[onerror]")).toBeNull();
    expect(host.querySelector("pre code")?.textContent).toBe(`${payload}\n`);
  });

  it("never requests images during parsing or initial rendering", () => {
    const root = renderMarkdown('![Remote](https://example.com/pixel.gif) ![Local](./figure.png) ![Bad](data:image/svg+xml,evil)');
    expect(root.querySelector("img,[src]")).toBeNull();
    expect(root.querySelector("button")?.dataset.markdownImage).toBe("https://example.com/pixel.gif");
    expect(root.textContent).toContain("Local image unavailable: ./figure.png");
  });
});

describe("workspace links", () => {
  it("resolves paths against the document and stays under the workspace", () => {
    expect(markdownDestination("../README.md", context)).toEqual({ kind: "file", value: "/workspace/README.md" });
    expect(markdownDestination("./notes%20and%20ideas.md#summary", context)).toEqual({ kind: "file", value: "/workspace/docs/notes and ideas.md" });
    for (const value of ["../../private.md", "%2e%2e/%2e%2e/private.md", "/private.md", "%2fetc/passwd", ".%5c..%5cprivate.md", "%00README.md", "./C%3A/file"]) expect(markdownDestination(value, context), value).toBeNull();
    expect(markdownDestination("file.md", { ...context, documentPath: "/workspace-other/file.md" })).toBeNull();
  });

  it("routes file and external links through explicit callbacks", () => {
    const openFile = vi.fn(); const openExternal = vi.fn();
    const host = document.createElement("div"); document.body.append(host);
    cleanup.push(render(() => <MarkdownPreview text="[Read](../README.md) [Web](https://example.com/)" {...context} onOpenFile={openFile} onOpenExternal={openExternal} />, host));
    host.querySelector<HTMLAnchorElement>("a[data-markdown-file]")!.click();
    host.querySelector<HTMLAnchorElement>("a[data-markdown-external]")!.click();
    expect(openFile).toHaveBeenCalledWith("/workspace/README.md");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("loads a remote image only after its button is activated", () => {
    const host = document.createElement("div"); document.body.append(host);
    cleanup.push(render(() => <MarkdownPreview text="![Diagram](https://example.com/diagram.png)" {...context} />, host));
    expect(host.querySelector("img")).toBeNull();
    host.querySelector<HTMLButtonElement>("button[data-markdown-image]")!.click();
    const image = host.querySelector("img")!;
    expect(image.src).toBe("https://example.com/diagram.png");
    expect(image.referrerPolicy).toBe("no-referrer");
    expect(image.alt).toBe("Diagram");
  });

  it("debounces persistent document edits and retains scroll state", () => {
    vi.useFakeTimers();
    const host = document.createElement("div"); document.body.append(host);
    const [text, setText] = createSignal(Text.of(["# Before"]));
    cleanup.push(render(() => <MarkdownPreview text={text()} {...context} />, host));
    const region = host.querySelector<HTMLElement>('[role="region"]')!;
    region.scrollTop = 123;
    setText(Text.of(["# Intermediate"]));
    vi.advanceTimersByTime(100);
    setText(Text.of(["# After"]));
    vi.advanceTimersByTime(100);
    expect(host.querySelector("h1")?.textContent).toBe("Before");
    vi.advanceTimersByTime(80);
    expect(host.querySelector("h1")?.textContent).toBe("After");
    expect(host.querySelector('[role="region"]')).toBe(region);
    expect(region.scrollTop).toBe(123);
  });
});

describe("preview lifecycle and local assets", () => {
  it("uses one viewport observer and reveals an offscreen anchor on navigation", async () => {
    const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { observers.push({ callback, options, observe: this.observe, unobserve: this.unobserve, disconnect: this.disconnect }); }
    });
    const scroll = vi.fn();
    vi.stubGlobal("scrollIntoView", scroll);
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const host = document.createElement("div"); document.body.append(host);
      const text = `[Last](#section-99)\n\n${Array.from({ length: 100 }, (_, index) => `# Section ${index}\n\nParagraph ${index}\n\n`).join("")}`;
      cleanup.push(render(() => <MarkdownPreview text={text} {...context} />, host));
      expect(observers).toHaveLength(1);
      expect(observers[0].options?.root).toBe(host.querySelector('[role="region"]'));
      expect(host.querySelectorAll("h1").length).toBeLessThan(24);
      expect(host.querySelector('[id="section-99"]')).toBeNull();
      host.querySelector<HTMLAnchorElement>("a[data-markdown-anchor]")!.click();
      await Promise.resolve();
      expect(host.querySelector('[id="section-99"]')?.textContent).toBe("Section 99");
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      const target = observers[0].observe.mock.calls[0][0] as Element;
      observers[0].callback([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(observers[0].unobserve).toHaveBeenCalledWith(target);
    } finally { HTMLElement.prototype.scrollIntoView = previousScroll; }
  });

  it("defers edits while the persistent preview is hidden", () => {
    vi.useFakeTimers();
    const host = document.createElement("div"); document.body.append(host);
    const [text, setText] = createSignal("# Original");
    const [active, setActive] = createSignal(true);
    cleanup.push(render(() => <MarkdownPreview text={text()} active={active()} {...context} />, host));
    const region = host.querySelector('[role="region"]');
    setActive(false); setText("# Updated");
    vi.advanceTimersByTime(500);
    expect(host.querySelector("h1")?.textContent).toBe("Original");
    setActive(true); vi.advanceTimersByTime(180);
    expect(host.querySelector("h1")?.textContent).toBe("Updated");
    expect(host.querySelector('[role="region"]')).toBe(region);
  });

  it("loads only rooted raster images through the supplied loader", async () => {
    const loadImage = vi.fn(async () => ({ mime: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }));
    const host = document.createElement("div"); document.body.append(host);
    cleanup.push(render(() => <MarkdownPreview text="![Diagram](./diagram.png) ![Escape](../../secret.png)" {...context} loadImage={loadImage} />, host));
    await Promise.resolve(); await Promise.resolve();
    expect(loadImage).toHaveBeenCalledExactlyOnceWith("/workspace/docs/diagram.png");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(host.textContent).toContain("Image source blocked");
  });

  it("rejects SVG, HTML, and mismatched data URLs returned by a loader", async () => {
    for (const image of [{ mime: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }, { mime: "text/html", dataUrl: "data:text/html;base64,eA==" }, { mime: "image/png", dataUrl: "https://tracking.test/pixel" }]) {
      const host = document.createElement("div"); document.body.append(host);
      cleanup.push(render(() => <MarkdownPreview text="![Unsafe](./image.png)" {...context} loadImage={async () => image} />, host));
      await Promise.resolve(); await Promise.resolve();
      expect(host.querySelector("img,[src]")).toBeNull();
      expect(host.textContent).toContain("Local image unavailable or unsupported");
    }
  });
});
