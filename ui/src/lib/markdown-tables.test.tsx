// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { classifyCell, installTableRules, restoreTableScroll, tableScrollState } from "./markdown-tables";
import { parseMarkdown, renderMarkdownBlock } from "../components/MarkdownPreview";
import { AgentMarkdown } from "../components/AgentMarkdown";

const OWNER_TABLE = [
  "| Provider | Countries | Contact route found in research | Priority | Push for |",
  "| --- | --- | --- | :---: | ---: |",
  "| Northwind Messaging | KE, UG, TZ, RW | Partnerships form at https://partners.northwind-messaging.example/apply?source=research-index&region=east plus sales@northwind-messaging.example | High | 1,200 |",
  "| Example Telecom Group | NG, GH | Developer relations team via the public docs portal, then an account manager introduction | Medium | 40% |",
].join("\n");

function renderTable(markdownText = OWNER_TABLE) {
  const markdown = new MarkdownIt({ linkify: true });
  installTableRules(markdown);
  const host = document.createElement("div");
  host.innerHTML = markdown.render(markdownText);
  return host;
}

describe("classifyCell", () => {
  it("keeps short labels and codes on one line", () => {
    expect(classifyCell("High")).toBe("nowrap");
    expect(classifyCell("KE, UG, TZ")).toBe("nowrap");
    expect(classifyCell("")).toBe("nowrap");
  });

  it("marks numbers, money and percentages as numeric", () => {
    for (const value of ["42", "1,200", "-3.5", "$19.99", "40%", "(12)", "12:30"]) expect(classifyCell(value)).toBe("numeric");
  });

  it("lets only URLs, addresses and long unbroken tokens break anywhere", () => {
    expect(classifyCell("see https://example.com/a")).toBe("break");
    expect(classifyCell("mail sales@example.com today")).toBe("break");
    expect(classifyCell("www.example.com")).toBe("break");
    expect(classifyCell("a_very_long_identifier_without_any_spaces_at_all")).toBe("break");
    expect(classifyCell("plain", true)).toBe("break");
  });

  it("treats longer sentences as prose", () => {
    expect(classifyCell("Developer relations team via the public docs portal")).toBe("prose");
  });
});

describe("table markup", () => {
  it("wraps every table in a figure and a scroller around the table", () => {
    const host = renderTable();
    const outer = host.querySelector(".markdown-table")!;
    expect(outer).not.toBeNull();
    const scroller = outer.firstElementChild as HTMLElement;
    expect(scroller.className).toBe("markdown-table-scroll");
    expect(scroller.children).toHaveLength(1);
    expect(scroller.firstElementChild!.tagName).toBe("TABLE");
  });

  it("tags each cell with its wrap kind and alignment, and gives prose and break cells an inner block", () => {
    const host = renderTable();
    const headers = [...host.querySelectorAll("th")];
    expect(headers.map((cell) => cell.textContent)).toEqual(["Provider", "Countries", "Contact route found in research", "Priority", "Push for"]);
    // Header labels up to 32 characters stay on one line even when they read as prose.
    for (const header of headers) expect(header.classList.contains("markdown-cell-nowrap")).toBe(true);
    expect(headers[3].classList.contains("markdown-align-center")).toBe(true);
    expect(headers[4].classList.contains("markdown-align-right")).toBe(true);

    const [first, second] = [...host.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")]);
    expect(first[0].className).toBe("markdown-cell-prose");
    expect(first[1].className).toBe("markdown-cell-nowrap");
    expect(first[2].className).toBe("markdown-cell-break");
    expect(first[2].firstElementChild!.className).toBe("markdown-cell");
    expect(first[3].className).toBe("markdown-cell-nowrap markdown-align-center");
    expect(first[4].className).toBe("markdown-cell-numeric markdown-align-right");
    expect(first[1].querySelector(".markdown-cell")).toBeNull();
    expect(second[2].className).toBe("markdown-cell-prose");
    expect(second[2].firstElementChild!.className).toBe("markdown-cell");
    expect(second[4].className).toBe("markdown-cell-numeric markdown-align-right");
  });

  it("uses the same wrapper in the editor preview renderer", () => {
    const html = parseMarkdown(OWNER_TABLE).map((block) => renderMarkdownBlock(block, { documentPath: "/work/README.md", workspaceRoot: "/work" } as never)).join("");
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector(".markdown-table > .markdown-table-scroll > table")).not.toBeNull();
    expect(host.querySelector("td.markdown-cell-break > .markdown-cell")).not.toBeNull();
  });
});

describe("streaming tables", () => {
  const offsets = new WeakMap<Element, number>();
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
  const cleanup: (() => void)[] = [];

  beforeEach(() => {
    // jsdom has no layout, so give scrollers a real scroll offset to read and write.
    Object.defineProperty(Element.prototype, "scrollLeft", { configurable: true, get() { return offsets.get(this) ?? 0; }, set(value: number) { offsets.set(this, value); } });
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout", "queueMicrotask"] });
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup.splice(0).forEach((dispose) => dispose());
    document.body.replaceChildren();
    vi.useRealTimers();
    if (original) Object.defineProperty(Element.prototype, "scrollLeft", original);
  });

  it("restores scroll offsets by table position", () => {
    const host = renderTable(`${OWNER_TABLE}\n\ntext\n\n${OWNER_TABLE}`);
    const scrollers = host.querySelectorAll<HTMLElement>(".markdown-table-scroll");
    scrollers[1].scrollLeft = 120;
    const saved = tableScrollState(host);
    expect(saved).toEqual([0, 120]);
    host.innerHTML = renderTable(`${OWNER_TABLE}\n\ntext\n\n${OWNER_TABLE}`).innerHTML;
    restoreTableScroll(host, saved);
    const fresh = host.querySelectorAll<HTMLElement>(".markdown-table-scroll");
    expect(fresh[0].scrollLeft).toBe(0);
    expect(fresh[1].scrollLeft).toBe(120);
  });

  it("keeps one wrapper and its scroll position while rows stream in", () => {
    const lines = OWNER_TABLE.split("\n");
    const [text, setText] = createSignal(lines.slice(0, 3).join("\n") + "\n");
    const host = document.createElement("div");
    document.body.append(host);
    cleanup.push(render(() => <AgentMarkdown text={text()} workspaceRoot="/work" streaming={true} />, host));
    vi.advanceTimersByTime(2000);
    expect(host.querySelectorAll(".markdown-table-scroll")).toHaveLength(1);
    host.querySelector<HTMLElement>(".markdown-table-scroll")!.scrollLeft = 200;

    setText(lines.join("\n") + "\n");
    vi.advanceTimersByTime(2000);
    const scrollers = host.querySelectorAll<HTMLElement>(".markdown-table-scroll");
    expect(scrollers).toHaveLength(1);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(scrollers[0].scrollLeft).toBe(200);
  });
});

describe("table and preview CSS", () => {
  const css = readFileSync(resolve("src/styles/markdown.css"), "utf8");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    expect(match, `rule for ${selector}`).not.toBeNull();
    return match![1];
  };

  it("does not cap the preview container width", () => {
    expect(rule(".markdown-body")).not.toMatch(/max-width/);
    expect(css).not.toMatch(/max-width:\s*850px/);
  });

  it("only limits the table wrapper and scroller to the pane width", () => {
    for (const selector of [".markdown-body .markdown-table", ".markdown-body .markdown-table-scroll"]) {
      const caps = [...rule(selector).matchAll(/max-width:\s*([^;]+);/g)].map((match) => match[1].trim());
      expect(caps.every((value) => value === "100%")).toBe(true);
    }
  });
});
