// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enhanceMermaid, isMermaidFence, mermaidFence, renderMermaidSvg, type MermaidApi, type MermaidLoader } from "./markdown-mermaid";

const SVG = '<svg id="diagram" width="320" height="180" xmlns="http://www.w3.org/2000/svg"><g style="max-width: 0px; position: absolute"><rect width="10" height="10"/></g></svg>';

function fakeApi(overrides: Partial<MermaidApi> = {}) {
  const initialize = vi.fn();
  const render = vi.fn(async (_id: string, _text: string) => ({ svg: SVG, diagramType: "flowchart" }));
  const api: MermaidApi = { initialize, render, ...overrides };
  return { api, initialize, render };
}

const loaderOf = (api: MermaidApi): MermaidLoader => async () => ({ default: api });

function placeholder(source: string) {
  const host = document.createElement("div");
  document.body.append(host);
  host.innerHTML = mermaidFence(source);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("mermaid fences", () => {
  it("recognizes only a mermaid declaration", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
    expect(isMermaidFence("  Mermaid ")).toBe(true);
    expect(isMermaidFence("mermaid title=\"Flow\"")).toBe(true);
    expect(isMermaidFence("mermaidx")).toBe(false);
    expect(isMermaidFence("javascript")).toBe(false);
    expect(isMermaidFence("")).toBe(false);
  });

  it("emits a placeholder with escaped source, a disclosure, and no executable markup", () => {
    const source = "flowchart TD\nA[\"<script>alert(1)</script>\"] --> B\n";
    const host = placeholder(source);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("[data-markdown-mermaid]")).not.toBeNull();
    expect(host.querySelector("[data-mermaid-status]")?.textContent).toBe("Rendering diagram");
    expect(host.querySelector("details.markdown-mermaid-source")).not.toBeNull();
    expect(host.querySelector("[data-mermaid-code]")?.textContent).toBe(source);
  });

  it("renders a sanitized, theme-matched SVG and marks the block ready", async () => {
    const { api, initialize, render } = fakeApi();
    const host = placeholder("flowchart TD\nA --> B\n");
    await enhanceMermaid(host, loaderOf(api));
    const element = host.querySelector<HTMLElement>("[data-markdown-mermaid]")!;
    expect(element.dataset.mermaidState).toBe("ready");
    expect(element.classList.contains("is-rendered")).toBe(true);
    expect(host.querySelector("[data-mermaid-diagram] svg")).not.toBeNull();
    expect(host.querySelector("[data-mermaid-diagram]")?.getAttribute("aria-busy")).toBeNull();
    expect(host.querySelector("svg")?.getAttribute("role")).toBe("img");
    expect(host.querySelector("svg")?.getAttribute("aria-label")).toBe("Mermaid diagram");
    expect(host.querySelector("svg")?.hasAttribute("height")).toBe(false);
    expect(host.querySelector("svg g")?.hasAttribute("style")).toBe(false);
    expect(render).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
    }));
  });

  it("keeps the source and surfaces a quiet error when Mermaid rejects the definition", async () => {
    const { api } = fakeApi({ render: vi.fn(async () => { throw new Error("Parse error"); }) });
    const host = placeholder("flowchart TD\nA -->\n");
    await enhanceMermaid(host, loaderOf(api));
    const element = host.querySelector<HTMLElement>("[data-markdown-mermaid]")!;
    expect(element.dataset.mermaidState).toBe("error");
    expect(host.querySelector("[data-mermaid-diagram] svg")).toBeNull();
    expect(host.querySelector("[data-mermaid-status]")?.textContent).toContain("could not be rendered");
    expect(host.querySelector<HTMLDetailsElement>("details.markdown-mermaid-source")?.open).toBe(true);
    expect(host.querySelector("[data-mermaid-code]")?.textContent).toBe("flowchart TD\nA -->\n");
  });

  it("rejects an enormous definition before loading the library", async () => {
    const { api } = fakeApi();
    const loader = vi.fn(loaderOf(api));
    const host = placeholder("x".repeat(50_001));
    await enhanceMermaid(host, loader);
    expect(loader).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLElement>("[data-markdown-mermaid]")?.dataset.mermaidState).toBe("error");
    expect(host.querySelector("[data-mermaid-status]")?.textContent).toContain("too large");
  });

  it("runs concurrent diagrams one at a time", async () => {
    let active = 0;
    let peak = 0;
    const host = document.createElement("div");
    document.body.append(host);
    host.innerHTML = `${mermaidFence("flowchart TD\nA --> B")}${mermaidFence("flowchart TD\nC --> D")}`;
    const api = fakeApi({
      render: vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { svg: SVG, diagramType: "flowchart" };
      }),
    }).api;
    await enhanceMermaid(host, loaderOf(api));
    expect(peak).toBe(1);
    expect(host.querySelectorAll(".markdown-mermaid[data-mermaid-state='ready']").length).toBe(2);
  });

  it("does not reload an already rendered definition", async () => {
    const { api, render } = fakeApi();
    const host = placeholder("flowchart TD\nA --> B\n");
    await enhanceMermaid(host, loaderOf(api));
    await enhanceMermaid(host, loaderOf(api));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("re-renders mounted diagrams when the app theme changes", async () => {
    const { api, initialize, render } = fakeApi();
    const host = placeholder("flowchart TD\nA --> B\n");
    await enhanceMermaid(host, loaderOf(api));
    expect(render).toHaveBeenCalledTimes(1);
    document.documentElement.dataset.theme = "light";
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(initialize.mock.calls[1][0]).toMatchObject({ darkMode: false });
  });

  it("exports a renderer that reports empty definitions", async () => {
    const { api } = fakeApi();
    await expect(renderMermaidSvg("  ", document.body, loaderOf(api))).rejects.toThrow("Empty diagram");
  });
});
