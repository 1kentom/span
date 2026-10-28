/**
 * PREVIEW ONLY. A labelled fixture that answers the code navigation commands in the browser
 * preview, so the navigation UI can be exercised without the desktop backend and a language
 * server. It scans plain text with regular expressions. It is not a language implementation,
 * is never used by the native app, and proves nothing about real servers.
 */
import type {
  CallHierarchyItemDto_Serialize, DocumentHighlightDto, LocationDto, LspResponse, PositionDto, RangeDto, SourceSnippetDto,
  SymbolDto_Serialize, SymbolKindDto, TypeHierarchyItemDto_Serialize, WorkspaceEditDto, WorkspaceSymbolDto_Serialize,
} from "../bindings";
import type { NavigationPort } from "./lsp-navigation";
import { comparePositions, rangeContains } from "./lsp-navigation";

export interface PreviewFile { text: string; revision: number }

/** Sample sources for the navigation fixture, merged into the preview workspace. */
export const previewNavigationFiles: Readonly<Record<string, string>> = {
  'src/navigation-sample/shapes.ts': `export interface Shape {
  readonly name: string;
  area(): number;
}

export class Circle implements Shape {
  readonly name = 'circle';

  constructor(private readonly radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}

export class Square implements Shape {
  readonly name = 'square';

  constructor(private readonly side: number) {}

  area(): number {
    return this.side * this.side;
  }
}
`,
  'src/navigation-sample/main.ts': `import { Circle, Square, type Shape } from './shapes';

export function totalArea(shapes: Shape[]): number {
  return shapes.reduce((sum, shape) => sum + shape.area(), 0);
}

export function describe(shape: Shape): string {
  return \`\${shape.name}: \${shape.area().toFixed(2)}\`;
}

export function report(): string[] {
  const shapes: Shape[] = [new Circle(2), new Square(3)];
  return [...shapes.map(describe), String(totalArea(shapes))];
}

export async function load(): Promise<string[]> {
  return report();
}
`,
};

const externalPath = 'jdt:///preview/lib.es5.d.ts';
const externalText = `// Preview library source, shown read only.
interface PromiseLike<T> {
  then<R>(onfulfilled?: (value: T) => R): PromiseLike<R>;
}

interface Promise<T> {
  then<R>(onfulfilled?: (value: T) => R): Promise<R>;
  catch(onrejected?: (reason: unknown) => void): Promise<T>;
}
`;
const externalLocation = (word: string): LocationDto | undefined => {
  const line = externalText.split('\n').findIndex(row => new RegExp(`^interface ${word}\\b`).test(row));
  return line < 0 ? undefined : { path: externalPath, range: { start: { line, character: 10 }, end: { line, character: 10 + word.length } }, external: true, displayPath: 'lib.es5.d.ts (preview library)' };
};

const identifier = /^[A-Za-z_$][\w$]*$/;
const range = (line: number, from: number, to: number): RangeDto => ({ start: { line, character: from }, end: { line, character: to } });
const lines = (text: string) => text.split('\n');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordAtPosition(text: string, position: PositionDto): { word: string; from: number; to: number } | undefined {
  const row = lines(text)[position.line] ?? '';
  let from = Math.min(position.character, row.length); let to = from;
  while (from > 0 && /[\w$]/.test(row[from - 1])) from -= 1;
  while (to < row.length && /[\w$]/.test(row[to])) to += 1;
  return from === to ? undefined : { word: row.slice(from, to), from, to };
}

function occurrences(text: string, word: string): RangeDto[] {
  const found: RangeDto[] = []; const pattern = new RegExp(`(?<![\\w$])${escapeRegex(word)}(?![\\w$])`, 'g');
  lines(text).forEach((row, index) => { for (const match of row.matchAll(pattern)) found.push(range(index, match.index, match.index + word.length)); });
  return found;
}

interface Declaration { name: string; kind: SymbolKindDto; line: number; from: number; to: number; header: string }

function declarationOf(row: string, line: number, insideClass: boolean): Declaration | undefined {
  const type = row.match(/^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/);
  if (type) return { name: type[3], kind: type[2] === 'class' ? 'class' : type[2] === 'interface' ? 'interface' : type[2] === 'enum' ? 'enum' : 'class', line, from: row.indexOf(type[3], type[0].length - type[3].length), to: 0, header: row };
  const fn = row.match(/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
  if (fn) return { name: fn[2], kind: 'function', line, from: row.indexOf(fn[2], fn[0].length - fn[2].length), to: 0, header: row };
  if (insideClass) {
    const ctor = row.match(/^(\s*)constructor\s*\(/);
    if (ctor) return { name: 'constructor', kind: 'constructor', line, from: ctor[1].length, to: 0, header: row };
    const method = row.match(/^(\s*)(?:(?:private|public|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;]+)?\s*[{;]\s*$/);
    if (method && !/^(if|for|while|switch|return|catch)$/.test(method[2])) return { name: method[2], kind: 'method', line, from: row.indexOf(method[2], method[1].length), to: 0, header: row };
    const property = row.match(/^(\s*)(?:(?:private|public|protected|static|readonly)\s+)*([A-Za-z_$][\w$]*)\s*[:=?]/);
    if (property && /^\s{2}\S/.test(row) && !/^\s{2,}(return|const|let|var|this)\b/.test(row)) return { name: property[2], kind: 'property', line, from: row.indexOf(property[2], property[1].length), to: 0, header: row };
  }
  return undefined;
}

function closingLine(rows: string[], start: number): number {
  let depth = 0; let opened = false;
  for (let index = start; index < rows.length; index += 1) {
    for (const character of rows[index]) {
      if (character === '{') { depth += 1; opened = true; }
      else if (character === '}') depth -= 1;
    }
    if (opened && depth <= 0) return index;
    if (!opened && /;\s*$/.test(rows[index])) return index;
  }
  return Math.min(start, rows.length - 1);
}

function documentSymbols(text: string): SymbolDto_Serialize[] {
  const rows = lines(text); const roots: SymbolDto_Serialize[] = [];
  const containers: { symbol: SymbolDto_Serialize; endLine: number }[] = [];
  rows.forEach((row, index) => {
    while (containers.length && containers[containers.length - 1].endLine < index) containers.pop();
    const parent = containers[containers.length - 1];
    const declaration = declarationOf(row, index, parent?.symbol.kind === 'class' || parent?.symbol.kind === 'interface');
    if (!declaration) return;
    const end = closingLine(rows, index);
    const symbol: SymbolDto_Serialize = {
      name: declaration.name, kind: declaration.kind, detail: null,
      range: range(index, 0, 0), selectionRange: range(index, declaration.from, declaration.from + declaration.name.length), children: [],
    };
    symbol.range = { start: { line: index, character: 0 }, end: { line: end, character: (rows[end] ?? '').length } };
    (parent ? parent.symbol.children : roots).push(symbol);
    if (end > index) containers.push({ symbol, endLine: end });
  });
  return roots;
}

function flatten(symbols: SymbolDto_Serialize[], container: string | null = null): { symbol: SymbolDto_Serialize; container: string | null }[] {
  return symbols.flatMap(symbol => [{ symbol, container }, ...flatten(symbol.children, symbol.name)]);
}

function innermost(symbols: SymbolDto_Serialize[], position: PositionDto, kinds: readonly SymbolKindDto[]): SymbolDto_Serialize | undefined {
  let found: SymbolDto_Serialize | undefined;
  const visit = (level: SymbolDto_Serialize[]) => { for (const symbol of level) if (rangeContains(symbol.range, position)) { if (kinds.includes(symbol.kind)) found = symbol; visit(symbol.children); } };
  visit(symbols); return found;
}

const encodeToken = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const decodeToken = <T>(token: string): T => JSON.parse(decodeURIComponent(token)) as T;

/** Creates the preview port. `files` is read at call time so edits made in the preview are seen. */
export function createPreviewNavigationPort(files: () => Record<string, PreviewFile>): NavigationPort {
  const reply = <T>(path: string | undefined, data: T): LspResponse<T> => ({ revision: (path && files()[path]?.revision) || 0, epoch: 1, data });
  const textOf = (path: string) => files()[path]?.text ?? '';
  const sources = () => Object.keys(files()).filter(path => /\.(?:ts|tsx|js|jsx)$/.test(path)).sort();
  const location = (path: string, at: RangeDto): LocationDto => ({ path, range: at, external: false, displayPath: path });

  const declarations = (word: string): LocationDto[] => sources().flatMap(path => flatten(documentSymbols(textOf(path)))
    .filter(entry => entry.symbol.name === word).map(entry => location(path, entry.symbol.selectionRange)));
  const classHeader = (symbolRow: string) => ({
    supers: [...symbolRow.matchAll(/\b(?:extends|implements)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/g)].flatMap(match => match[1].split(',').map(name => name.trim())),
  });
  const typeItem = (path: string, symbol: SymbolDto_Serialize): TypeHierarchyItemDto_Serialize => ({
    name: symbol.name, kind: symbol.kind, detail: path, location: location(path, symbol.selectionRange), selectionRange: symbol.selectionRange,
    token: encodeToken({ path, name: symbol.name }),
  });
  const callItem = (path: string, symbol: SymbolDto_Serialize): CallHierarchyItemDto_Serialize => ({
    name: symbol.name, kind: symbol.kind, detail: path, location: location(path, symbol.selectionRange), selectionRange: symbol.selectionRange,
    token: encodeToken({ path, name: symbol.name, line: symbol.selectionRange.start.line }),
  });
  const allTypes = () => sources().flatMap(path => flatten(documentSymbols(textOf(path))).filter(entry => entry.symbol.kind === 'class' || entry.symbol.kind === 'interface').map(entry => ({ path, symbol: entry.symbol })));

  async function locate(path: string, position: PositionDto, mode: 'definition' | 'implementation' | 'type'): Promise<LspResponse<LocationDto[]>> {
    const word = wordAtPosition(textOf(path), position);
    if (!word) return reply(path, []);
    if (mode === 'implementation') {
      const implementers = allTypes().filter(entry => entry.symbol.name !== word.word && classHeader(lines(textOf(entry.path))[entry.symbol.selectionRange.start.line] ?? '').supers.includes(word.word));
      // A method name resolves to the same-named members of the implementing classes.
      const members = sources().flatMap(source => flatten(documentSymbols(textOf(source))).filter(entry => entry.symbol.kind === 'method' && entry.symbol.name === word.word && entry.container && implementers.some(item => item.symbol.name === entry.container)).map(entry => location(source, entry.symbol.selectionRange)));
      return reply(path, members.length ? members : implementers.map(entry => location(entry.path, entry.symbol.selectionRange)));
    }
    const own = declarations(word.word);
    if (mode === 'type') {
      // The type of a value is approximated by the first PascalCase type named on its declaration line.
      const row = lines(textOf(path))[position.line] ?? '';
      const named = [...row.matchAll(/:\s*([A-Z][\w$]*)/g)].map(match => match[1]).find(name => declarations(name).length);
      return reply(path, named ? declarations(named).slice(0, 1) : own.filter(target => target.range.start.line >= 0).slice(0, 1));
    }
    const external = own.length ? undefined : externalLocation(word.word);
    return reply(path, external ? [external] : own);
  }

  return {
    definition: (path, position) => locate(path, position, 'definition'),
    declaration: (path, position) => locate(path, position, 'definition'),
    typeDefinition: (path, position) => locate(path, position, 'type'),
    implementation: (path, position) => locate(path, position, 'implementation'),
    async references(path, position, includeDeclaration) {
      const word = wordAtPosition(textOf(path), position);
      if (!word) return reply(path, []);
      const own = new Set(declarations(word.word).map(item => `${item.path}:${item.range.start.line}:${item.range.start.character}`));
      const all = sources().flatMap(source => occurrences(textOf(source), word.word).map(at => location(source, at)))
        .filter(item => includeDeclaration || !own.has(`${item.path}:${item.range.start.line}:${item.range.start.character}`));
      return reply(path, all);
    },
    async documentSymbols(path) { return reply(path, documentSymbols(textOf(path))); },
    async workspaceSymbols(query) {
      const needle = query.trim().toLowerCase();
      const data: WorkspaceSymbolDto_Serialize[] = sources().flatMap(path => flatten(documentSymbols(textOf(path)))
        .filter(entry => !needle || entry.symbol.name.toLowerCase().includes(needle))
        .map(entry => ({ name: entry.symbol.name, kind: entry.symbol.kind, containerName: entry.container, location: location(path, entry.symbol.selectionRange) })));
      return reply(undefined, data.slice(0, 100));
    },
    async callPrepare(path, position) {
      const symbol = innermost(documentSymbols(textOf(path)), position, ['function', 'method', 'constructor']);
      return reply(path, symbol ? [callItem(path, symbol)] : []);
    },
    async callIncoming(item) {
      const target = decodeToken<{ path: string; name: string; line: number }>(item.token);
      const calls = new Map<string, { item: CallHierarchyItemDto_Serialize; ranges: RangeDto[] }>();
      for (const path of sources()) {
        const symbols = documentSymbols(textOf(path));
        for (const at of occurrences(textOf(path), target.name)) {
          if (path === target.path && at.start.line === target.line) continue;
          const caller = innermost(symbols, at.start, ['function', 'method', 'constructor']);
          if (!caller) continue;
          const key = `${path}:${caller.selectionRange.start.line}`;
          const entry = calls.get(key) ?? { item: callItem(path, caller), ranges: [] };
          entry.ranges.push(at); calls.set(key, entry);
        }
      }
      return reply(target.path, [...calls.values()].map(entry => ({ from: entry.item, fromRanges: entry.ranges })));
    },
    async callOutgoing(item) {
      const source = decodeToken<{ path: string; name: string; line: number }>(item.token);
      const symbols = documentSymbols(textOf(source.path));
      const own = flatten(symbols).find(entry => entry.symbol.selectionRange.start.line === source.line && entry.symbol.name === source.name)?.symbol;
      if (!own) return reply(source.path, []);
      const callable = sources().flatMap(path => flatten(documentSymbols(textOf(path))).filter(entry => ['function', 'method'].includes(entry.symbol.kind)).map(entry => ({ path, symbol: entry.symbol })));
      const calls = new Map<string, { item: CallHierarchyItemDto_Serialize; ranges: RangeDto[] }>();
      for (const target of callable) {
        if (target.symbol === own) continue;
        for (const at of occurrences(textOf(source.path), target.symbol.name)) {
          if (comparePositions(at.start, own.selectionRange.end) <= 0 || comparePositions(at.end, own.range.end) > 0 || at.start.line < own.range.start.line) continue;
          const key = `${target.path}:${target.symbol.selectionRange.start.line}`;
          const entry = calls.get(key) ?? { item: callItem(target.path, target.symbol), ranges: [] };
          entry.ranges.push(at); calls.set(key, entry);
        }
      }
      return reply(source.path, [...calls.values()].map(entry => ({ to: entry.item, fromRanges: entry.ranges })));
    },
    async typePrepare(path, position) {
      const symbol = innermost(documentSymbols(textOf(path)), position, ['class', 'interface']);
      return reply(path, symbol ? [typeItem(path, symbol)] : []);
    },
    async typeSupertypes(item) {
      const source = decodeToken<{ path: string; name: string }>(item.token);
      const own = allTypes().find(entry => entry.path === source.path && entry.symbol.name === source.name);
      if (!own) return reply(source.path, []);
      const names = classHeader(lines(textOf(own.path))[own.symbol.selectionRange.start.line] ?? '').supers;
      return reply(source.path, allTypes().filter(entry => names.includes(entry.symbol.name)).map(entry => typeItem(entry.path, entry.symbol)));
    },
    async typeSubtypes(item) {
      const source = decodeToken<{ path: string; name: string }>(item.token);
      return reply(source.path, allTypes().filter(entry => classHeader(lines(textOf(entry.path))[entry.symbol.selectionRange.start.line] ?? '').supers.includes(source.name)).map(entry => typeItem(entry.path, entry.symbol)));
    },
    async highlights(path, position) {
      const word = wordAtPosition(textOf(path), position);
      if (!word) return reply(path, []);
      const own = new Set(declarations(word.word).filter(item => item.path === path).map(item => item.range.start.line));
      const data: DocumentHighlightDto[] = occurrences(textOf(path), word.word).map(at => ({ range: at, kind: own.has(at.start.line) || /^\s*[\w$.]*\s*=[^=]/.test((lines(textOf(path))[at.start.line] ?? '').slice(at.start.character)) ? 'write' : 'read' }));
      return reply(path, data);
    },
    async prepareRename(path, position) {
      const word = wordAtPosition(textOf(path), position);
      if (!word || externalLocation(word.word)) return reply(path, null);
      return reply(path, { range: range(position.line, word.from, word.to), placeholder: word.word, defaultBehavior: false });
    },
    async rename(path, position, newName) {
      if (!identifier.test(newName)) throw { kind: 'other', message: `"${newName}" is not a valid identifier.` };
      const word = wordAtPosition(textOf(path), position);
      if (!word) throw { kind: 'other', message: 'There is nothing to rename here.' };
      const data: WorkspaceEditDto = {
        skippedOperations: 0,
        files: sources().map(source => ({ path: source, external: false, edits: occurrences(textOf(source), word.word).map(at => ({ range: at, newText: newName })) })).filter(file => file.edits.length),
      };
      return reply(path, data);
    },
    async readSource(target, contextLines): Promise<SourceSnippetDto> {
      const text = target.external ? externalText : textOf(target.path);
      if (!text) throw new Error(`Sample source is not available: ${target.displayPath || target.path}`);
      const rows = lines(text);
      const start = Math.max(0, target.range.start.line - contextLines);
      const end = Math.min(rows.length - 1, target.range.end.line + contextLines);
      return { path: target.path, displayPath: target.displayPath || target.path, language: 'typescript', startLine: start, text: rows.slice(start, end + 1).join('\n'), highlightRange: target.range, external: target.external, readOnly: target.external };
    },
    cancel: async () => null,
  };
}
