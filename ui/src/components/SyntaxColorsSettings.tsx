import { For, Show, createMemo, createSignal } from "solid-js";
import type { SettingsScope } from "../bindings";
import {
  SYNTAX_TOKENS, contrastMinimum, defaultPalette, expandColor, isTokenId, isValidColor, pickerColor, tokenContrast,
  type SyntaxPalette, type SyntaxTheme, type TokenId,
} from "../editor/syntax-palette";
import type { SampleLanguage } from "../editor/syntax-sample";
import Icon from "./Icon";
import { SyntaxPreview } from "./SyntaxPreview";
import "../styles/syntax-colors.css";

type ColorMap = Record<string, Record<string, string>>;
export interface SyntaxColorsSettingsProps {
  /** Overrides stored in the scope being edited. */
  value: ColorMap;
  /** Effective overrides, user and project merged. */
  effective: ColorMap;
  scope: SettingsScope;
  /** Theme tab selected first. */
  activeTheme: SyntaxTheme;
  disabled?: boolean;
  onScopeChange?: (scope: SettingsScope) => Promise<void>;
  /** Writes exactly one key in the current scope, for example `editor.syntaxColors.dark.importPath`. A null value removes it. */
  onChange: (key: string, value: string | null) => Promise<void>;
  clipboard?: { readText: () => Promise<string>; writeText: (text: string) => Promise<void> };
}

const THEMES: { id: SyntaxTheme; label: string }[] = [{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }, { id: "purple", label: "Purple" }];
const LANGUAGES: { id: SampleLanguage; label: string }[] = [
  { id: "java", label: "Java" }, { id: "typescript", label: "TypeScript" }, { id: "rust", label: "Rust" }, { id: "python", label: "Python" },
  { id: "json", label: "JSON" }, { id: "css", label: "CSS" }, { id: "html", label: "HTML" },
];
const FORMAT_HINT = "Use #rgb, #rrggbb or #rrggbbaa";

/** Token labels and one line descriptions in plain words, in the order shown in each group. */
export const TOKEN_GROUPS: { name: string; tokens: { id: TokenId; label: string; description: string }[] }[] = [
  { name: "Keywords and operators", tokens: [
    { id: "keyword", label: "Keyword", description: "Words the language reserves, such as class, public, const or fn" },
    { id: "controlKeyword", label: "Control keyword", description: "Words that steer the flow, such as if, for, return or try" },
    { id: "operator", label: "Operator", description: "Symbols that combine values, such as +, = or &&" },
    { id: "punctuation", label: "Punctuation", description: "Brackets, commas and semicolons" },
  ] },
  { name: "Literals", tokens: [
    { id: "string", label: "String", description: "Text in quotes" },
    { id: "number", label: "Number", description: "Numbers such as 42 or 3.14" },
    { id: "boolean", label: "Boolean", description: "true and false" },
    { id: "constant", label: "Constant", description: "Fixed values such as null, MAX_ITEMS or enum members" },
    { id: "regexp", label: "Regular expression", description: "Patterns written between slashes" },
    { id: "escape", label: "Escape sequence", description: "Special characters inside a string, such as \\n" },
  ] },
  { name: "Names and types", tokens: [
    { id: "function", label: "Function", description: "The name of a function where it is declared or called" },
    { id: "method", label: "Method", description: "The name of a method on a class or object" },
    { id: "type", label: "Type", description: "Built in and library types, such as string, i32 or List" },
    { id: "class", label: "Class", description: "The name of a class or struct" },
    { id: "interface", label: "Interface", description: "The name of an interface or trait" },
    { id: "enum", label: "Enum", description: "The name of an enumeration" },
    { id: "typeParameter", label: "Type parameter", description: "A generic placeholder such as T in List<T>" },
    { id: "variable", label: "Variable", description: "Local names and plain text in code" },
    { id: "parameter", label: "Parameter", description: "A name a function receives" },
    { id: "property", label: "Property", description: "A field or key on an object" },
  ] },
  { name: "Imports and modules", tokens: [
    { id: "namespace", label: "Namespace or package", description: "The package or module a file belongs to" },
    { id: "importPath", label: "Import path", description: "The package or module in an import statement" },
  ] },
  { name: "Comments", tokens: [
    { id: "comment", label: "Comment", description: "Notes the compiler ignores" },
    { id: "docComment", label: "Documentation comment", description: "Comments that document the code below them" },
  ] },
  { name: "Special", tokens: [
    { id: "annotation", label: "Annotation or decorator", description: "Markers such as @Override, #[derive] or @Injectable" },
    { id: "macro", label: "Macro", description: "Names that expand into code, such as println!" },
    { id: "label", label: "Label or lifetime", description: "Jump labels and Rust lifetimes such as 'a" },
    { id: "tag", label: "Tag", description: "HTML and JSX element names" },
    { id: "attribute", label: "Attribute", description: "Attribute names on a tag, such as class" },
    { id: "invalid", label: "Invalid code", description: "Text the parser cannot make sense of" },
  ] },
];
const LABELS = Object.fromEntries(TOKEN_GROUPS.flatMap(group => group.tokens.map(token => [token.id, token.label]))) as Record<TokenId, string>;
const scopeLabel = (scope: SettingsScope) => scope === "user" ? "User settings" : "This project";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const keyFor = (theme: string, token?: string) => `editor.syntaxColors.${theme}${token ? `.${token}` : ""}`;
const tidy = (value: string) => value.trim().toLowerCase();

/** Valid known overrides of one theme. */
function tokensOf(map: ColorMap | undefined, theme: string): Partial<Record<TokenId, string>> {
  const result: Partial<Record<TokenId, string>> = {};
  for (const [id, color] of Object.entries(map?.[theme] ?? {})) if (isTokenId(id) && isValidColor(color)) result[id] = tidy(color);
  return result;
}

interface PasteOp { theme: SyntaxTheme; token: TokenId; from?: string; to: string | null }
/** Validates pasted JSON against the current overrides and lists exactly what applying it would change. */
export function analysePaste(text: string, current: ColorMap): { errors: string[]; ops: PasteOp[] } {
  const errors: string[] = [];
  const ops: PasteOp[] = [];
  let data: unknown;
  try { data = JSON.parse(text); } catch (cause) { return { errors: [`Not valid JSON: ${errorText(cause)}`], ops }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { errors: ['Expected an object such as {"dark": {"keyword": "#ff0000"}}'], ops };
  for (const [theme, colors] of Object.entries(data)) {
    if (!THEMES.some(item => item.id === theme)) { errors.push(`Unknown theme "${theme}". Use dark, light or purple`); continue; }
    if (!colors || typeof colors !== "object" || Array.isArray(colors)) { errors.push(`${theme} must be an object of token colors`); continue; }
    const next: Partial<Record<TokenId, string>> = {};
    for (const [token, color] of Object.entries(colors)) {
      if (!isTokenId(token)) errors.push(`${theme}: unknown token "${token}"`);
      else if (!isValidColor(color)) errors.push(`${theme}.${token}: "${String(color)}" is not a color (${FORMAT_HINT})`);
      else next[token] = tidy(color);
    }
    const before = tokensOf(current, theme);
    for (const token of SYNTAX_TOKENS) {
      if (next[token] && next[token] !== before[token]) ops.push({ theme: theme as SyntaxTheme, token, from: before[token], to: next[token]! });
      else if (!next[token] && before[token]) ops.push({ theme: theme as SyntaxTheme, token, from: before[token], to: null });
    }
  }
  return { errors, ops };
}

export function SyntaxColorsSettings(props: SyntaxColorsSettingsProps) {
  const [theme, setTheme] = createSignal<SyntaxTheme>(props.activeTheme);
  const [language, setLanguage] = createSignal<SampleLanguage>("java");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  /** Text being typed or dragged per token, shown live in the preview until it is saved. */
  const [typed, setTyped] = createSignal<Record<string, string>>({});
  const [confirm, setConfirm] = createSignal<"theme" | "all" | undefined>();
  const [pasteOpen, setPasteOpen] = createSignal(false);
  const [pasteText, setPasteText] = createSignal("");
  const locked = () => props.disabled || busy();

  const own = createMemo(() => tokensOf(props.value, theme()));
  const inherited = createMemo(() => tokensOf(props.effective, theme()));
  const defaults = createMemo(() => defaultPalette(theme()));
  const saved = (id: TokenId) => inherited()[id] ?? own()[id] ?? defaults()[id];
  const shown = (id: TokenId) => { const text = typed()[id]; return text !== undefined && isValidColor(text) ? tidy(text) : saved(id); };
  const palette = createMemo<SyntaxPalette>(() => Object.fromEntries(SYNTAX_TOKENS.map(id => [id, shown(id)])) as SyntaxPalette);
  const customizedCount = (name: SyntaxTheme) => Object.keys(tokensOf(props.value, name)).length;
  const totalCustomized = () => THEMES.reduce((sum, item) => sum + customizedCount(item.id), 0);

  async function run(work: () => Promise<void>, done?: string) {
    if (locked()) return;
    setBusy(true); setError(""); setNotice("");
    try { await work(); if (done) setNotice(done); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const clearTyped = (id: string) => setTyped(({ [id]: _removed, ...rest }) => rest);
  function type(id: TokenId, text: string) { setTyped(current => ({ ...current, [id]: text })); }
  async function commit(id: TokenId, text: string) {
    const value = text.trim();
    if (!isValidColor(value)) return;
    const next = tidy(value);
    if (own()[id] === next) { clearTyped(id); return; }
    await run(() => props.onChange(keyFor(theme(), id), next), `${LABELS[id]} color saved in ${scopeLabel(props.scope)}`);
    clearTyped(id);
  }
  async function reset(id: TokenId) {
    clearTyped(id);
    await run(() => props.onChange(keyFor(theme(), id), null), `${LABELS[id]} color reset`);
  }
  async function resetThemes(names: SyntaxTheme[]) {
    setConfirm(undefined);
    setTyped({});
    await run(async () => { for (const name of names) if (customizedCount(name) > 0) await props.onChange(keyFor(name), null); }, names.length === 1 ? `${THEMES.find(item => item.id === names[0])!.label} colors reset` : "All syntax colors reset");
  }
  async function changeScope(next: SettingsScope) {
    if (locked() || next === props.scope || !props.onScopeChange) return;
    await run(async () => { setTyped({}); await props.onScopeChange!(next); });
  }
  async function copy() {
    const payload: ColorMap = {};
    for (const item of THEMES) { const tokens = tokensOf(props.value, item.id); if (Object.keys(tokens).length) payload[item.id] = tokens as Record<string, string>; }
    const count = Object.values(payload).reduce((sum, tokens) => sum + Object.keys(tokens).length, 0);
    await run(async () => { await (props.clipboard?.writeText ?? ((text: string) => navigator.clipboard.writeText(text)))(JSON.stringify(payload, null, 2)); }, `Copied ${count} custom ${count === 1 ? "color" : "colors"} from ${scopeLabel(props.scope)}`);
  }
  async function openPaste() {
    setPasteOpen(true); setError(""); setNotice("");
    try { const text = await (props.clipboard?.readText ?? (() => navigator.clipboard.readText()))(); if (text.trim().startsWith("{") && !pasteText().trim()) setPasteText(text); } catch { /* the user can paste into the box */ }
  }
  const analysis = createMemo(() => pasteText().trim() ? analysePaste(pasteText(), props.value) : undefined);
  const summary = createMemo(() => {
    const ops = analysis()?.ops ?? [];
    return { added: ops.filter(op => op.from === undefined && op.to !== null).length, changed: ops.filter(op => op.from !== undefined && op.to !== null).length, removed: ops.filter(op => op.to === null).length };
  });
  async function applyPaste() {
    const result = analysis();
    if (!result || result.errors.length || !result.ops.length) return;
    await run(async () => {
      for (const op of result.ops) await props.onChange(keyFor(op.theme, op.token), op.to);
      setPasteOpen(false); setPasteText("");
    }, `Applied ${result.ops.length} color ${result.ops.length === 1 ? "change" : "changes"} to ${scopeLabel(props.scope)}`);
  }

  function Row(rowProps: { id: TokenId; description: string }) {
    const id = rowProps.id;
    const fieldId = `syn-hex-${id}`;
    const text = () => typed()[id] ?? shown(id);
    const invalid = () => typed()[id] !== undefined && !isValidColor(typed()[id]);
    const ratio = () => tokenContrast(shown(id), theme());
    const minimum = contrastMinimum(id);
    const low = () => ratio() < minimum;
    const customized = () => own()[id] !== undefined;
    const fromOther = () => !customized() && inherited()[id] !== undefined;
    return <li class="syn-row" data-token={id} data-customized={customized() ? "true" : "false"}>
      <div class="syn-row-label">
        <span class="syn-swatch" aria-hidden="true" style={{ background: shown(id) }} />
        <div><label for={fieldId}>{LABELS[id]}</label><p id={`syn-help-${id}`}>{rowProps.description}</p></div>
      </div>
      <div class="syn-row-controls">
        <Show when={customized()}><span class="syn-marker">Customized</span></Show>
        <Show when={fromOther()}><span class="syn-marker syn-inherited">{props.scope === "workspace" ? "From User settings" : "From this project"}</span></Show>
        <input class="syn-picker" type="color" aria-label={`Pick color for ${LABELS[id]}`} value={pickerColor(shown(id))} disabled={locked()}
          onInput={event => { const alpha = expandColor(shown(id))?.slice(7) ?? ""; type(id, event.currentTarget.value + alpha); }}
          onChange={event => { const alpha = expandColor(shown(id))?.slice(7) ?? ""; void commit(id, event.currentTarget.value + alpha); }} />
        <input id={fieldId} class="syn-hex" type="text" spellcheck={false} autocomplete="off" maxLength={9} aria-label={`Hex color for ${LABELS[id]}`} aria-describedby={`syn-help-${id} syn-state-${id}`} aria-invalid={invalid()} value={text()} disabled={locked()}
          onInput={event => type(id, event.currentTarget.value)}
          onChange={event => { if (isValidColor(event.currentTarget.value)) void commit(id, event.currentTarget.value); }}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (isValidColor(event.currentTarget.value)) void commit(id, event.currentTarget.value); } if (event.key === "Escape" && typed()[id] !== undefined) { event.preventDefault(); event.stopPropagation(); clearTyped(id); } }} />
        <span class="syn-contrast" classList={{ low: low() }} data-low={low() ? "true" : "false"}><span>{ratio().toFixed(1)}:1</span></span>
        <button class="sp-reset" aria-label={`Reset ${LABELS[id].toLowerCase()} color`} disabled={locked() || !customized()} onClick={() => void reset(id)}>Reset</button>
      </div>
      <div class="syn-row-state" id={`syn-state-${id}`}>
        <Show when={invalid()}><p class="syn-invalid error-text" role="alert">{FORMAT_HINT}. Not saved.</p></Show>
        <Show when={!invalid() && low()}><p class="syn-warning"><Icon name="Warning2" size={12} /><span>Low contrast: {ratio().toFixed(2)}:1 against the {theme()} editor background, {minimum}:1 or more is easier to read. You can still keep it.</span></p></Show>
      </div>
    </li>;
  }

  return <section class="syn-settings" aria-label="Syntax colors">
    <div class="syn-toolbar">
      <div class="syn-tabs" role="tablist" aria-label="Theme" onKeyDown={event => {
        const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!direction) return;
        event.preventDefault();
        const index = (THEMES.findIndex(item => item.id === theme()) + direction + THEMES.length) % THEMES.length;
        setTheme(THEMES[index].id); setTyped({}); setConfirm(undefined);
        queueMicrotask(() => event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[index]?.focus());
      }}>
        <For each={THEMES}>{item => <button role="tab" id={`syn-tab-${item.id}`} aria-selected={theme() === item.id} aria-controls="syn-panel" tabIndex={theme() === item.id ? 0 : -1} onClick={() => { setTheme(item.id); setTyped({}); setConfirm(undefined); }}>{item.label}<Show when={customizedCount(item.id) > 0}><span class="syn-count" aria-label={`${customizedCount(item.id)} customized`}>{customizedCount(item.id)}</span></Show></button>}</For>
      </div>
      <div class="sp-scope-tabs" role="group" aria-label="Syntax colors scope">
        <button aria-pressed={props.scope === "user"} disabled={locked() || !props.onScopeChange} onClick={() => void changeScope("user")}>User settings</button>
        <button aria-pressed={props.scope === "workspace"} disabled={locked() || !props.onScopeChange} onClick={() => void changeScope("workspace")}>This project</button>
      </div>
    </div>
    <p class="syn-note">Editing the {THEMES.find(item => item.id === theme())!.label} theme in {scopeLabel(props.scope)}. {props.scope === "workspace" ? "Project colors win over your user colors for the same token." : "A project can override these colors for itself."} Changes apply to every editor right away.</p>

    <div class="syn-preview-block">
      <div class="syn-preview-head"><h2 id="syn-preview-heading">Live preview</h2>
        <label class="syn-language">Sample language
          <select aria-label="Sample language" value={language()} onChange={event => setLanguage(event.currentTarget.value as SampleLanguage)}>
            <For each={LANGUAGES}>{item => <option value={item.id} selected={language() === item.id}>{item.label}</option>}</For>
          </select>
        </label>
      </div>
      <SyntaxPreview language={language()} theme={theme()} palette={palette()} />
    </div>

    <div class="syn-actions" role="group" aria-label="Syntax color actions">
      <button class="button" disabled={locked()} onClick={() => void copy()}>Copy colors</button>
      <button class="button" disabled={locked()} aria-expanded={pasteOpen()} onClick={() => pasteOpen() ? setPasteOpen(false) : void openPaste()}>Paste colors</button>
      <span class="syn-spacer" />
      <button class="button" disabled={locked() || customizedCount(theme()) === 0} onClick={() => setConfirm("theme")}>Reset theme</button>
      <button class="button" disabled={locked() || totalCustomized() === 0} onClick={() => setConfirm("all")}>Reset all</button>
    </div>

    <Show when={confirm()}>{kind => <div class="sp-discard-review" role="group" aria-label="Confirm reset">
      <span>{kind() === "theme" ? `Remove all ${customizedCount(theme())} custom ${THEMES.find(item => item.id === theme())!.label} colors from ${scopeLabel(props.scope)}?` : `Remove all ${totalCustomized()} custom syntax colors, in every theme, from ${scopeLabel(props.scope)}?`}</span>
      <button class="button" onClick={() => setConfirm(undefined)}>Cancel</button>
      <button class="button primary" disabled={locked()} onClick={() => void resetThemes(kind() === "theme" ? [theme()] : THEMES.map(item => item.id))}>{kind() === "theme" ? "Reset theme" : "Reset all"}</button>
    </div>}</Show>

    <Show when={pasteOpen()}><div class="syn-paste" role="group" aria-label="Paste colors">
      <label for="syn-paste-text">Colors JSON</label>
      <p class="syn-note">Paste the JSON from Copy colors. Every theme in the JSON replaces that theme's colors in {scopeLabel(props.scope)}; themes not in the JSON stay as they are.</p>
      <textarea id="syn-paste-text" spellcheck={false} rows={7} value={pasteText()} onInput={event => setPasteText(event.currentTarget.value)} placeholder={'{\n  "dark": { "importPath": "#9fb0cc" }\n}'} />
      <Show when={analysis()}>{result => <div class="syn-diff" aria-live="polite">
        <Show when={result().errors.length > 0} fallback={<>
          <p class="syn-diff-summary"><strong>{summary().added} added, {summary().changed} changed, {summary().removed} removed</strong></p>
          <Show when={result().ops.length === 0}><p class="syn-note">Nothing would change.</p></Show>
          <ul><For each={result().ops}>{op => <li><code>{op.theme}.{op.token}</code> {op.to === null ? `removed (was ${op.from})` : op.from === undefined ? `added ${op.to}` : `${op.from} to ${op.to}`}</li>}</For></ul>
        </>}>
          <ul class="syn-diff-errors" role="alert"><For each={result().errors}>{message => <li>{message}</li>}</For></ul>
          <p class="syn-note">Nothing was applied.</p>
        </Show>
      </div>}</Show>
      <div class="syn-paste-actions">
        <button class="button" onClick={() => { setPasteOpen(false); setPasteText(""); }}>Cancel</button>
        <button class="button primary" disabled={locked() || !analysis() || analysis()!.errors.length > 0 || analysis()!.ops.length === 0} onClick={() => void applyPaste()}>Apply changes</button>
      </div>
    </div></Show>

    <div id="syn-panel" role="tabpanel" aria-labelledby={`syn-tab-${theme()}`}>
      <For each={TOKEN_GROUPS}>{group => <div class="syn-group">
        <h2>{group.name}</h2>
        <ul class="syn-list"><For each={group.tokens}>{token => <Row id={token.id} description={token.description} />}</For></ul>
      </div>}</For>
    </div>
    <div class="syn-feedback" aria-live="polite">
      <Show when={error()}><p class="error-text" role="alert">{error()}</p></Show>
      <Show when={!error() && notice()}><p role="status">{notice()}</p></Show>
    </div>
  </section>;
}

export default SyntaxColorsSettings;
