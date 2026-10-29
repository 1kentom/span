// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { classifyLink, cleanHoverMarkdown, hoverContentsToMarkdown, isSyntheticNoiseLine, renderHoverMarkdown } from "./markdown-hover";

const render = (markdown: string, options = {}) => renderHoverMarkdown(markdown, options);
const html = (markdown: string, options = {}) => render(markdown, options).root.innerHTML;

describe("hover contents", () => {
  it("accepts MarkupContent, MarkedString and arrays", () => {
    expect(hoverContentsToMarkdown({ kind: "markdown", value: "**a**" })).toBe("**a**");
    expect(hoverContentsToMarkdown("plain **x**")).toBe("plain **x**");
    expect(hoverContentsToMarkdown({ language: "java", value: "int x;" })).toBe("```java\nint x;\n```");
    expect(hoverContentsToMarkdown(["a", { language: "ts", value: "b" }, "  "])).toBe("a\n\n---\n\n```ts\nb\n```");
    expect(hoverContentsToMarkdown(null)).toBe("");
  });
  it("keeps plaintext literal", () => {
    const rendered = render(hoverContentsToMarkdown({ kind: "plaintext", value: "use *this* and <b>that</b>\nnext" }));
    expect(rendered.root.textContent).toContain("use *this* and <b>that</b>");
    expect(rendered.root.querySelector("strong, em, b")).toBeNull();
    expect(rendered.root.querySelector("br")).not.toBeNull();
  });
});

describe("hover noise", () => {
  it("recognises the synthetic JDT project line in its variants", () => {
    for (const line of ["Source: *jdt.ls-java-project*", "Source: jdt.ls-java-project", "source - `jdt.ls-java-project`.", "*jdt.ls-java-project*", "  **Source:** _jdt.ls-java-project_  "]) expect(isSyntheticNoiseLine(line), line).toBe(true);
    for (const line of ["Source: my-project", "see jdt.ls-java-project docs for details", "plain"]) expect(isSyntheticNoiseLine(line), line).toBe(false);
  });
  it("renders the exact JDT sample as highlighted code with no asterisks or source line", async () => {
    const sample = "```java\nvoid com.kentom.todo.Controller.initialize()\n```\n\nSource: *jdt.ls-java-project*";
    const rendered = render(sample, { fallbackLanguage: "java" });
    await rendered.highlighted;
    expect(rendered.root.textContent).toBe("void com.kentom.todo.Controller.initialize()");
    expect(rendered.root.textContent).not.toContain("*");
    expect(rendered.root.textContent).not.toMatch(/Source|jdt/);
    expect(rendered.root.querySelector(".cm-lsp-signature")).not.toBeNull();
    expect(rendered.root.querySelector("code span[class^='syn-']")).not.toBeNull();
  });
  it("keeps code fences verbatim even when they mention the project", () => {
    expect(cleanHoverMarkdown("```\nSource: *jdt.ls-java-project*\n```")).toContain("jdt.ls-java-project");
  });
  it("collapses empty sections, doubled rules and edge rules", () => {
    expect(cleanHoverMarkdown("---\n\n## Docs\n\n---\n\n---\n\nbody\n\n---\n")).toBe("## Docs\n\nbody");
    expect(cleanHoverMarkdown("## Empty\n\n## Next\n\nbody\n\n## Trailing")).toBe("## Next\n\nbody");
    expect(cleanHoverMarkdown("Source: *jdt.ls-java-project*\n\n")).toBe("");
    expect(render("Source: *jdt.ls-java-project*").empty).toBe(true);
    expect(cleanHoverMarkdown("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("markdown rendering", () => {
  it("renders headings, emphasis, strikethrough, inline code and rules", () => {
    const output = html("# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code`.\n\n---\n\nend");
    expect(output).toContain("<h1>Title</h1>");
    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain("<em>italic</em>");
    expect(output).toContain("<s>gone</s>");
    expect(output).toContain("<code>code</code>");
    expect(output).toContain("<hr>");
  });
  it("renders nested lists and blockquotes", () => {
    const root = render("- one\n  - nested a\n  - nested b\n- two\n\n3. third\n4. fourth\n\n> quoted **text**").root;
    expect(root.querySelectorAll("ul").length).toBe(2);
    expect(root.querySelector("ul ul li")?.textContent).toBe("nested a");
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelector("blockquote strong")?.textContent).toBe("text");
  });
  it("renders basic tables", () => {
    const root = render("| a | b |\n|:--|--:|\n| 1 | 2 |").root;
    expect(root.querySelectorAll("th").length).toBe(2);
    expect(root.querySelector("td")?.textContent).toBe("1");
    expect(root.querySelector("th")?.className).toBe("align-left");
  });
  it("keeps long code lines whole", async () => {
    const line = `const value = ${"x".repeat(3000)};`;
    const rendered = render(`\`\`\`ts\n${line}\n\`\`\``);
    await rendered.highlighted;
    expect(rendered.root.querySelector("code")?.textContent).toBe(line);
  });
  it("uses the fence tag, then the active file language, and leaves unknown tags plain", async () => {
    const tagged = render("```rust\nfn main() {}\n```", { fallbackLanguage: "java" });
    await tagged.highlighted;
    expect(tagged.root.querySelector("code")?.getAttribute("data-lang")).toBe("rust");
    expect(tagged.root.querySelector("code .syn-keyword, code span")).not.toBeNull();
    const fallback = render("```\nclass A {}\n```", { fallbackLanguage: "java" });
    await fallback.highlighted;
    expect(fallback.root.querySelector("code span")).not.toBeNull();
    const unknown = render("```mystery\nclass A {}\n```", { fallbackLanguage: "java" });
    await unknown.highlighted;
    expect(unknown.root.querySelector("code span")).toBeNull();
  });
  it("colours with the syn token classes only", async () => {
    const rendered = render("```typescript\nconst a: string = 'x';\n```");
    await rendered.highlighted;
    const classes = [...rendered.root.querySelectorAll("code span")].map(span => span.className);
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) expect(name).toMatch(/\bsyn-[A-Za-z]+/);
    expect(rendered.root.querySelector("[style]")).toBeNull();
  });
});

describe("html subset", () => {
  it("converts the tags Java and TypeScript docs use", () => {
    const root = render("<p>Hello <b>big</b> <i>world</i> <tt>t</tt><br>line</p>\n\n<ul><li>a</li><li>b</li></ul>\n\n<blockquote>q</blockquote>\n\n<pre>raw   code\n  more</pre>").root;
    expect(root.querySelector("p strong")?.textContent).toBe("big");
    expect(root.querySelector("p em")?.textContent).toBe("world");
    expect(root.querySelector("p code")?.textContent).toBe("t");
    expect(root.querySelector("p br")).not.toBeNull();
    expect(root.querySelectorAll("ul li").length).toBe(2);
    expect(root.querySelector("blockquote")?.textContent).toBe("q");
    expect(root.querySelector("pre code")?.textContent).toBe("raw   code\n  more");
  });
  it("converts inline html inside a markdown paragraph", () => {
    const root = render("see <b>this</b> and <code>that</code> &amp; &lt;done&gt;").root;
    expect(root.querySelector("strong")?.textContent).toBe("this");
    expect(root.querySelector("code")?.textContent).toBe("that");
    expect(root.textContent).toBe("see this and that & <done>");
  });
  it("drops every other tag and attribute and decodes entities", () => {
    const root = render('<div class="x" style="color:red" onclick="evil()"><span id="a">kept &amp; text</span></div>\n\n<p onmouseover="x()" style="y">para</p>').root;
    expect(root.querySelector("div, span")).toBeNull();
    expect(root.textContent).toContain("kept & text");
    const paragraph = root.querySelector("p")!;
    expect(paragraph.attributes.length).toBe(0);
  });
});

describe("hostile input", () => {
  const payloads = [
    "<img src=x onerror=alert(1)>",
    'text <img src="x" onerror="alert(1)"> text',
    "<script>alert(1)</script>after",
    "<svg onload=alert(1)><circle/></svg>",
    "<iframe src=javascript:alert(1)></iframe>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](java\nscript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    "[x](vbscript:msgbox)",
    "[x](command:_java.apply)",
    "[x](file.md)",
    "[x](//evil.example/x)",
    "![img](http://evil.example/x.png)",
    "<style>body{display:none}</style>visible",
    "<p onclick=alert(1)>p</p>",
    "<details open ontoggle=alert(1)>d</details>",
  ];
  it("never produces scripts, event handlers, images, frames or unsafe hrefs", () => {
    for (const payload of payloads) {
      const root = render(payload).root;
      expect(root.querySelector("script, img, iframe, svg, style, object, embed, details"), payload).toBeNull();
      for (const element of root.querySelectorAll("*")) {
        for (const attribute of Array.from(element.attributes)) {
          expect(attribute.name.startsWith("on"), `${payload} ${attribute.name}`).toBe(false);
          expect(attribute.name, payload).not.toBe("style");
          expect(attribute.name, payload).not.toBe("src");
        }
        if (element.tagName === "A") expect(element.getAttribute("href") ?? "", payload).toMatch(/^(https?:\/\/|#)/);
      }
    }
  });
  it("keeps the label of a refused link as text", () => {
    const root = render("[click me](javascript:alert(1))").root;
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toBe("click me");
  });
  it("drops the content of script and style, keeps surrounding text", () => {
    expect(render("<script>alert(1)</script>after").root.textContent).toBe("after");
    expect(render("<style>body{x:y}</style>visible").root.textContent).toBe("visible");
  });
  it("does not execute anything while rendering", () => {
    const hit = vi.fn();
    (globalThis as { __xss?: () => void }).__xss = hit;
    render("<img src=x onerror=__xss()>\n\n<svg onload=__xss()>");
    expect(hit).not.toHaveBeenCalled();
  });
});

describe("links", () => {
  it("classifies only http, https and file", () => {
    expect(classifyLink("https://example.com/a?b=1")).toEqual({ kind: "external", url: "https://example.com/a?b=1" });
    expect(classifyLink("http://example.com")).toMatchObject({ kind: "external" });
    expect(classifyLink("javascript:alert(1)")).toBeUndefined();
    expect(classifyLink("command:x")).toBeUndefined();
    expect(classifyLink("relative/path.md")).toBeUndefined();
    expect(classifyLink("mailto:a@b.c")).toBeUndefined();
    expect(classifyLink("file:///a/b%20c.java#L12,3")).toEqual({ kind: "file", path: "/a/b c.java", line: 12, column: 3 });
  });
  it("opens http links with openExternal and file links with navigate", () => {
    const openExternal = vi.fn(); const navigate = vi.fn();
    const root = render("[web](https://example.com/x) [src](file:///w/A.java#L7)", { openExternal, navigate }).root;
    const [web, src] = Array.from(root.querySelectorAll("a"));
    const click = (element: Element) => { const event = new MouseEvent("click", { bubbles: true, cancelable: true }); element.dispatchEvent(event); return event.defaultPrevented; };
    expect(click(web)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/x");
    expect(click(src)).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "/w/A.java", line: 7, column: undefined });
  });
  it("renders inline html anchors through the same check", () => {
    const root = render('<a href="https://example.com">ok</a> <a href="javascript:alert(1)">bad</a>').root;
    expect(root.querySelectorAll("a").length).toBe(1);
    expect(root.textContent).toBe("ok bad");
  });
});

describe("jdt nested list", () => {
  it("renders a fully indented list section as a list, not code, and keeps a jdt link as its label", () => {
    const md = "must be specified.\n\n     * **Returns:**\n       * the API to convert the [ButtonType](jdt://contents/a.jar/B.java?=x) that the user clicked on";
    const { root } = render(md);
    expect(root.querySelector(".cm-lsp-code")).toBeNull();
    expect(root.querySelectorAll("li").length).toBe(2);
    expect(root.textContent).toContain("the API to convert the ButtonType that the user clicked on");
    expect(root.querySelector("a")).toBeNull();
  });
});
