import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import schema from '../../../crates/core/settings.schema.json';
import type { BufferRevision, BufferSnapshot, Settings_Serialize as Settings, SettingsScope, TextEdit } from '../bindings';

// Browser-only memory fixture. Nothing in this module reads or writes native settings.
const aliases: Record<string, string> = {
  'files.autoSave': 'autoSave', 'files.autoSaveDelay': 'autoSaveDelay',
  'editor.wordWrap': 'wordWrap', 'editor.fontSize': 'fontSize', 'editor.fontFamily': 'editorFontFamily',
  'editor.tabSize': 'tabSize', 'editor.formatOnSave': 'formatOnSave', 'window.zoomLevel': 'zoomLevel',
  'workbench.editor.limit.enabled': 'tabLimitEnabled', 'workbench.editor.limit.value': 'tabLimit',
  'workbench.editor.limit.perEditorGroup': 'tabLimitPerGroup', 'editor.syntaxColors': 'syntaxColors',
};
type Rule = { type?: string | string[]; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; items?: Rule; propertyNames?: Rule; pattern?: string; additionalProperties?: Rule | boolean };
const rules = schema.properties as Record<string, Rule & { default?: unknown }>;
const defaults = Object.fromEntries(Object.entries(rules).filter(([key, rule]) => !key.includes('.') && key !== '$schema' && 'default' in rule).map(([key, rule]) => [key, structuredClone(rule.default)])) as Settings;
// The schema gives `languageServers` no default of its own, so the browser preview supplies the plain one.
defaults.languageServers = { autoInstall: false, enabled: {}, javaHome: null, nodePath: null, runProjectCode: false, trustedWorkspaces: [] };
const canonical = (key: string) => aliases[key] || key;

/** Splits a dotted key such as `editor.syntaxColors.dark.keyword` into the known setting and the path below it. */
function resolveKey(key: string): { name: string; rest: string[] } | null {
  const parts = key.split('.');
  for (let length = 1; length <= parts.length; length += 1) {
    const name = canonical(parts.slice(0, length).join('.'));
    if (rules[name]) return { name, rest: parts.slice(length) };
  }
  return null;
}

/** Merges one level of per theme colour maps, later scopes winning per token. */
function mergeColors(...layers: unknown[]): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const layer of layers) if (layer && typeof layer === 'object') for (const [theme, colors] of Object.entries(layer)) result[theme] = { ...result[theme], ...(colors as Record<string, string>) };
  return result;
}

function validate(value: unknown, rule: Rule, path: string): void {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (rule.type && !types.some(item => item === type || item === 'integer' && type === 'number' && Number.isInteger(value))) throw new Error(`${path} has an invalid type.`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path} must be one of ${rule.enum.join(', ')}.`);
  if (typeof value === 'number' && (!Number.isFinite(value) || rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum)) throw new Error(`${path} is outside its supported range.`);
  if (typeof value === 'string' && (rule.minLength !== undefined && value.length < rule.minLength || rule.maxLength !== undefined && value.length > rule.maxLength || rule.pattern && !new RegExp(rule.pattern).test(value))) throw new Error(`${path} has an invalid value.`);
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) throw new Error(`${path} has an invalid number of items.`);
    if (rule.items) value.forEach((item, index) => validate(item, rule.items!, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (rule.propertyNames) validate(key, rule.propertyNames, path);
      if (rule.additionalProperties && typeof rule.additionalProperties === 'object') validate(item, rule.additionalProperties, `${path}.${key}`);
    }
  }
}

function decode(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`Invalid settings JSONC: ${printParseErrorCode(errors[0].error)} at ${errors[0].offset}.`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must contain an object.');
  for (const [key, item] of Object.entries(value)) if (rules[key]) validate(item, rules[key], key);
  return value as Record<string, unknown>;
}

function normalized(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };
  for (const [alias, key] of Object.entries(aliases)) if (alias in raw) {
    result[key] = alias === 'editor.wordWrap' ? raw[alias] === 'on' : raw[alias];
    delete result[alias];
  }
  return Object.fromEntries(Object.entries(result).filter(([key]) => key in defaults));
}

function withoutUserOnly(value: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...value };
  delete rest.agents;
  return rest;
}

export function createPreviewSettings() {
  const texts: Record<SettingsScope, string> = { user: '{\n}\n', workspace: '{\n}\n' };
  const buffers = new Map<SettingsScope, BufferSnapshot>();
  function get(scope: SettingsScope = 'workspace'): Settings {
    const user = normalized(decode(texts.user));
    // `agents` holds `agents.delegation.enabled`, `agents.warmStart` and `agents.healthCheck`, all honoured from the user scope only, as in core settings.
    const workspace = scope === 'workspace' ? withoutUserOnly(normalized(decode(texts.workspace))) : {};
    return structuredClone({ ...defaults, ...user, ...workspace,
      keybindings: { ...defaults.keybindings, ...(user.keybindings as Settings['keybindings']), ...(workspace.keybindings as Settings['keybindings']) },
      syntaxColors: mergeColors(user.syntaxColors, workspace.syntaxColors),
      languageServers: Object.assign({}, defaults.languageServers, user.languageServers, workspace.languageServers) as Settings['languageServers'],
      formatters: { ...defaults.formatters, ...(user.formatters as Settings['formatters']), ...(workspace.formatters as Settings['formatters']) },
    } as Settings);
  }
  function open(scope: SettingsScope): BufferSnapshot {
    let buffer = buffers.get(scope);
    if (!buffer) { buffer = { path: `settings://${scope}`, text: texts[scope], revision: 0, savedRevision: 0, language: 'jsonc' }; buffers.set(scope, buffer); }
    return { ...buffer };
  }
  function commit(scope: SettingsScope, text: string): Settings {
    decode(text);
    texts[scope] = text;
    return get(scope);
  }
  return {
    get,
    raw: (scope: SettingsScope) => texts[scope],
    keys: (scope: SettingsScope) => [...new Set(Object.keys(decode(texts[scope])).filter(key => key !== '$schema' && !!rules[key]).map(canonical))],
    updateJsonc: commit,
    update(scope: SettingsScope, key: string, valueJson: string | null): Settings {
      const resolved = resolveKey(key);
      if (!resolved) throw new Error(`Unknown setting: ${key}`);
      const { name, rest } = resolved;
      let next = texts[scope];
      const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
      if (rest.length === 0) {
        for (const existing of Object.keys(decode(next))) if (canonical(existing) === name) next = applyEdits(next, modify(next, [existing], undefined, {}));
        if (valueJson !== null) next = applyEdits(next, modify(next, [name], JSON.parse(valueJson), options));
        return commit(scope, next);
      }
      const top = Object.keys(decode(next)).find(existing => canonical(existing) === name) ?? name;
      next = applyEdits(next, modify(next, [top, ...rest], valueJson === null ? undefined : JSON.parse(valueJson), options));
      // Drop parents that became empty so removing the last override leaves no stale object behind.
      for (let depth = rest.length - 1; depth >= 0 && valueJson === null; depth -= 1) {
        const path = [top, ...rest.slice(0, depth)];
        const parent = parse(next) as Record<string, unknown>;
        const value = path.reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), parent);
        if (value && typeof value === 'object' && Object.keys(value).length === 0) next = applyEdits(next, modify(next, path, undefined, {}));
      }
      return commit(scope, next);
    },
    open,
    edit(scope: SettingsScope, revision: number, changes: TextEdit[]): BufferRevision {
      const buffer = open(scope);
      if (buffer.revision !== revision) throw new Error(`Expected revision ${revision}, current revision is ${buffer.revision}`);
      let end = 0;
      for (const change of changes) {
        if (change.from < end || change.from > change.to || change.to > buffer.text.length) throw new Error('Invalid preview settings edit.');
        end = change.to;
      }
      for (const change of [...changes].reverse()) buffer.text = buffer.text.slice(0, change.from) + change.insert + buffer.text.slice(change.to);
      if (changes.length) buffer.revision += 1;
      if (buffer.text === texts[scope]) buffer.savedRevision = buffer.revision;
      buffers.set(scope, buffer);
      return { path: buffer.path, revision: buffer.revision, savedRevision: buffer.savedRevision };
    },
    save(scope: SettingsScope, revision: number): BufferSnapshot {
      const buffer = open(scope);
      if (buffer.revision !== revision) throw new Error(`Expected revision ${revision}, current revision is ${buffer.revision}`);
      commit(scope, buffer.text);
      buffer.savedRevision = buffer.revision;
      buffers.set(scope, buffer);
      return { ...buffer };
    },
    discard(scope: SettingsScope): BufferSnapshot {
      const buffer = open(scope);
      buffer.text = texts[scope];
      buffer.revision += 1;
      buffer.savedRevision = buffer.revision;
      buffers.set(scope, buffer);
      return { ...buffer };
    },
  };
}
