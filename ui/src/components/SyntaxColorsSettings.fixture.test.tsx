// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { SyntaxColorsSettings, TOKEN_GROUPS, analysePaste, type SyntaxColorsSettingsProps } from "./SyntaxColorsSettings";
import { SettingsPage } from "./SettingsPage";
import { SYNTAX_TOKENS, defaultPalette } from "../editor/syntax-palette";

// Fixture tests: the settings write callback is a spy. They prove which key each control writes and what the screen shows.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function mount(overrides: Partial<SyntaxColorsSettingsProps> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const onChange = vi.fn(async (_key: string, _value: string | null) => undefined);
  const onScopeChange = vi.fn(async () => undefined);
  const writeText = vi.fn(async (_text: string) => undefined);
  const props: SyntaxColorsSettingsProps = { value: {}, effective: {}, scope: "user", activeTheme: "dark", onChange, onScopeChange, clipboard: { readText: async () => "", writeText }, ...overrides };
  disposers.push(render(() => <SyntaxColorsSettings {...props} />, root));
  return { root, onChange, onScopeChange, writeText };
}
const hex = (root: HTMLElement, label: string) => root.querySelector<HTMLInputElement>(`input[aria-label="Hex color for ${label}"]`)!;
const named = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;
function type(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
function commit(input: HTMLInputElement) { input.dispatchEvent(new Event("change", { bubbles: true })); }

describe("fixture: syntax colors section", () => {
  it("renders the 30 tokens in six groups with plain labels, swatches and the live preview", async () => {
    const m = mount();
    expect(TOKEN_GROUPS.map(group => group.name)).toEqual(["Keywords and operators", "Literals", "Names and types", "Imports and modules", "Comments", "Special"]);
    expect(TOKEN_GROUPS.flatMap(group => group.tokens.map(token => token.id)).sort()).toEqual([...SYNTAX_TOKENS].sort());
    expect(m.root.querySelectorAll(".syn-row")).toHaveLength(30);
    expect(m.root.textContent).toContain("Import path");
    expect(m.root.textContent).toContain("The package or module in an import statement");
    expect(hex(m.root, "Import path").value).toBe(defaultPalette("dark").importPath);
    expect(m.root.querySelector<HTMLElement>('[data-token="importPath"] .syn-swatch')!.style.background).not.toBe("");
    expect(m.root.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("Dark");
    expect(m.root.querySelector(".syn-preview")).not.toBeNull();
    await settle(); await settle();
    expect(m.root.querySelector(".syn-preview .cm-content")!.textContent).toContain("import javafx.fxml.FXML;");
  });

  it("starts on the active theme and switches theme tabs with the arrow keys", () => {
    const m = mount({ activeTheme: "purple" });
    expect(m.root.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("Purple");
    expect(hex(m.root, "Keyword").value).toBe(defaultPalette("purple").keyword);
    m.root.querySelector('[role="tablist"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(m.root.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain("Light");
    expect(hex(m.root, "Keyword").value).toBe(defaultPalette("light").keyword);
  });

  it("writes one key per edit and previews the colour before saving", async () => {
    const m = mount();
    const field = hex(m.root, "Import path");
    type(field, "#112233");
    expect(m.onChange).not.toHaveBeenCalled();
    const preview = m.root.querySelector<HTMLElement>(".syn-preview")!;
    await settle();
    expect(preview.style.getPropertyValue("--syn-importPath")).toBe("#112233");
    commit(field);
    await settle();
    expect(m.onChange).toHaveBeenCalledTimes(1);
    expect(m.onChange).toHaveBeenCalledWith("editor.syntaxColors.dark.importPath", "#112233");
  });

  it("saves from the native colour input and keeps an existing alpha", async () => {
    const m = mount({ value: { dark: { string: "#aabbcc80" } }, effective: { dark: { string: "#aabbcc80" } } });
    const picker = m.root.querySelector<HTMLInputElement>('input[type="color"][aria-label="Pick color for String"]')!;
    expect(picker.value).toBe("#aabbcc");
    picker.value = "#102030"; picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(m.onChange).toHaveBeenCalledWith("editor.syntaxColors.dark.string", "#10203080");
  });

  it("accepts #rgb and #rrggbbaa and rejects everything else without saving", async () => {
    const m = mount();
    const field = hex(m.root, "Keyword");
    for (const good of ["#abc", "#AABBCC", "#aabbccdd"]) { type(field, good); commit(field); await settle(); }
    expect(m.onChange.mock.calls.map(call => call[1])).toEqual(["#abc", "#aabbcc", "#aabbccdd"]);
    m.onChange.mockClear();
    for (const bad of ["red", "#abcd", "#12", "rgb(1,2,3)", "123456"]) {
      type(field, bad); commit(field);
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle();
      expect(field.getAttribute("aria-invalid"), bad).toBe("true");
      expect(m.root.querySelector('[data-token="keyword"] [role="alert"]')!.textContent).toContain("#rgb, #rrggbb or #rrggbbaa");
    }
    expect(m.onChange).not.toHaveBeenCalled();
    type(field, defaultPalette("dark").keyword);
    expect(m.root.querySelector('[data-token="keyword"] [role="alert"]')).toBeNull();
  });

  it("marks customized tokens and resets just that token", async () => {
    const m = mount({ value: { dark: { importPath: "#112233" } }, effective: { dark: { importPath: "#112233" } } });
    expect(m.root.querySelector('[data-token="importPath"] .syn-marker')!.textContent).toBe("Customized");
    expect(m.root.querySelector('[data-token="keyword"] .syn-marker')).toBeNull();
    expect(named(m.root, "Reset keyword color").disabled).toBe(true);
    named(m.root, "Reset import path color").click();
    await settle();
    expect(m.onChange).toHaveBeenCalledWith("editor.syntaxColors.dark.importPath", null);
  });

  it("asks before resetting a theme or everything", async () => {
    const m = mount({ value: { dark: { importPath: "#112233", keyword: "#445566" }, light: { string: "#778899" } }, effective: { dark: { importPath: "#112233" } } });
    named(m.root, "Reset theme").click();
    expect(m.onChange).not.toHaveBeenCalled();
    const group = m.root.querySelector('[role="group"][aria-label="Confirm reset"]')!;
    expect(group.textContent).toContain("Remove all 2 custom Dark colors from User settings");
    [...group.querySelectorAll("button")].find(b => b.textContent === "Cancel")!.click();
    await settle();
    expect(m.onChange).not.toHaveBeenCalled();
    named(m.root, "Reset theme").click();
    [...m.root.querySelectorAll<HTMLButtonElement>('[aria-label="Confirm reset"] button')].find(b => b.textContent === "Reset theme")!.click();
    await settle();
    expect(m.onChange.mock.calls).toEqual([["editor.syntaxColors.dark", null]]);
    m.onChange.mockClear();
    named(m.root, "Reset all").click();
    expect(m.root.querySelector('[aria-label="Confirm reset"]')!.textContent).toContain("every theme");
    [...m.root.querySelectorAll<HTMLButtonElement>('[aria-label="Confirm reset"] button')].find(b => b.textContent === "Reset all")!.click();
    await settle();
    expect(m.onChange.mock.calls).toEqual([["editor.syntaxColors.dark", null], ["editor.syntaxColors.light", null]]);
  });

  it("shows the scope and asks the page to switch it", async () => {
    const m = mount({ scope: "workspace", value: {}, effective: { dark: { class: "#010203" } } });
    expect(m.root.textContent).toContain("in This project");
    expect(m.root.querySelector('[aria-label="Syntax colors scope"] [aria-pressed="true"]')!.textContent).toBe("This project");
    expect(m.root.querySelector('[data-token="class"] .syn-marker')!.textContent).toBe("From User settings");
    expect(hex(m.root, "Class").value).toBe("#010203");
    named(m.root, "User settings").click();
    await settle();
    expect(m.onScopeChange).toHaveBeenCalledWith("user");
  });

  it("warns without blocking when contrast is low, with a lower bar for comments", async () => {
    const m = mount();
    expect(m.root.querySelector(".syn-warning")).toBeNull();
    const keyword = hex(m.root, "Keyword");
    type(keyword, "#202020");
    expect(m.root.querySelector('[data-token="keyword"] .syn-warning')!.textContent).toContain("4.5:1");
    expect(m.root.querySelector('[data-token="keyword"] .syn-contrast')!.getAttribute("data-low")).toBe("true");
    commit(keyword); await settle();
    expect(m.onChange).toHaveBeenCalledWith("editor.syntaxColors.dark.keyword", "#202020");
    const comment = hex(m.root, "Comment");
    type(comment, "#808080");
    expect(m.root.querySelector('[data-token="comment"] .syn-warning')).toBeNull();
    type(keyword, "#808080");
    expect(m.root.querySelector('[data-token="keyword"] .syn-warning')).not.toBeNull();
    type(comment, "#303030");
    expect(m.root.querySelector('[data-token="comment"] .syn-warning')!.textContent).toContain("3:1");
  });

  it("copies the overrides of the current scope as JSON", async () => {
    const m = mount({ value: { dark: { importPath: "#112233" }, purple: { tag: "#abc" } } });
    named(m.root, "Copy colors").click();
    await settle();
    expect(JSON.parse(m.writeText.mock.calls[0][0])).toEqual({ dark: { importPath: "#112233" }, purple: { tag: "#abc" } });
    expect(m.root.querySelector('[role="status"]')!.textContent).toContain("Copied 2 custom colors");
  });

  it("validates pasted JSON, summarises the diff and applies it only after confirmation", async () => {
    const m = mount({ value: { dark: { importPath: "#112233", keyword: "#445566" } } });
    named(m.root, "Paste colors").click();
    await settle();
    const box = m.root.querySelector<HTMLTextAreaElement>("#syn-paste-text")!;
    const apply = () => named(m.root, "Apply changes");
    expect(apply().disabled).toBe(true);
    box.value = '{"dark": {"importPath": "red"}, "neon": {}, "light": {"nonsense": "#fff"}}'; box.dispatchEvent(new Event("input", { bubbles: true }));
    const errors = m.root.querySelector(".syn-diff-errors")!.textContent!;
    expect(errors).toContain('dark.importPath: "red" is not a color');
    expect(errors).toContain('Unknown theme "neon"');
    expect(errors).toContain('light: unknown token "nonsense"');
    expect(apply().disabled).toBe(true);
    box.value = "{ not json"; box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(m.root.querySelector(".syn-diff-errors")!.textContent).toContain("Not valid JSON");
    box.value = '{"dark": {"importPath": "#112233", "string": "#FFEECC"}, "light": {"tag": "#abcdef"}}'; box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(m.root.querySelector(".syn-diff-summary")!.textContent).toBe("2 added, 0 changed, 1 removed");
    expect(m.root.querySelector(".syn-diff")!.textContent).toContain("dark.keyword removed (was #445566)");
    expect(m.onChange).not.toHaveBeenCalled();
    apply().click();
    await settle(); await settle();
    expect(m.onChange.mock.calls.map(call => call.join("="))).toEqual([
      "editor.syntaxColors.dark.keyword=",
      "editor.syntaxColors.dark.string=#ffeecc",
      "editor.syntaxColors.light.tag=#abcdef",
    ]);
    expect(m.root.querySelector("#syn-paste-text")).toBeNull();
  });

  it("analysePaste lists changed tokens and leaves unlisted themes alone", () => {
    const result = analysePaste('{"dark": {"keyword": "#000000"}}', { dark: { keyword: "#111111" }, light: { string: "#222222" } });
    expect(result.errors).toEqual([]);
    expect(result.ops).toEqual([{ theme: "dark", token: "keyword", from: "#111111", to: "#000000" }]);
  });

  it("shows a rejected write instead of failing silently and keeps the typed text", async () => {
    const m = mount({ onChange: async () => { throw new Error("Workspace settings are locked"); } });
    const field = hex(m.root, "Keyword");
    type(field, "#123456"); commit(field);
    await settle(); await settle();
    expect(m.root.querySelector('.syn-feedback [role="alert"]')!.textContent).toBe("Workspace settings are locked");
  });

  it("every control has an accessible name", () => {
    const m = mount();
    const unnamed = [...m.root.querySelectorAll("input, select, textarea, button")].filter(el => !(el.getAttribute("aria-label") || el.textContent?.trim() || (el.id && m.root.querySelector(`label[for="${el.id}"]`)) || el.closest("label")));
    expect(unnamed).toEqual([]);
  });

  it("is reachable from the settings page as its own section", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const [settings] = createSignal({ theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false, uiFontSize: 13, uiFontFamily: "Inter", editorFontFamily: "JetBrains Mono", collapsePanelsOnDrag: true, markdownPreviewDefault: true, formatOnSave: false, autoSave: "off", autoSaveDelay: 1000, tabLimitEnabled: true, tabLimit: 10, tabLimitPerGroup: false, zoomLevel: null, keybindings: {}, formatters: {}, languageServers: { autoInstall: false, enabled: {}, javaHome: null, nodePath: null, runProjectCode: false } } as never);
    disposers.push(render(() => <SettingsPage settings={settings()} onChange={async () => undefined} onSaveJsonc={async () => settings()} syntaxColors={<div id="marker">syntax section</div>} />, root));
    expect(root.querySelector("#marker")).toBeNull();
    [...root.querySelectorAll<HTMLButtonElement>(".sp-nav button")].find(b => b.textContent === "Syntax colors")!.click();
    await settle();
    expect(root.querySelector("#marker")).not.toBeNull();
  });
});
