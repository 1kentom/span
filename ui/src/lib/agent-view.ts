import type { AgentFeatures, ConfigOption_Deserialize as ConfigOption, PromptAttachment, SlashCommand } from "../bindings";
import type { AgentHint } from "../bindings";
import type { Capability, ChangedFile, ChildStep, ConfigOptionView, DiffLine, PermissionDetails, PermissionDiff, PermissionLocation, QuestionOption, SlashGroup, SlashItem, StepImage, StepKind, StepStatus, StepView, TermLine } from "../components/agent/types";
import { agentFailureMessage } from "./acp-catalog";
import { isNestedTool, subagentChildren, toolTarget } from "./agent-feed";
import { hintText } from "./agent-hint-text";
import type { Failure, FeedItem, PermissionEvent, ToolEvent } from "./agent-session";
import { bytesToBase64, gateAttachments, type Attachment, type PromptCapabilities } from "./attachments";

/** View-model mapping from agent session state to the sidebar components. Pure functions only. */

export const leaf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const parent = (path: string) => {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};
export const relativeTo = (root: string | undefined, path: string) => {
  if (!root) return path;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
};

/**
 * Resolves a path that came from an agent (or any untrusted source) to a workspace-relative path.
 * Returns undefined when the path leaves the workspace root, is empty, is the root itself, or is not a plain path.
 * This is lexical: it cannot see symlinks, so the native open still has the final say.
 */
export function workspaceRelative(root: string | undefined, path: string): string | undefined {
  if (!root || !path || path.includes("\0") || path.includes("://")) return undefined;
  const normalize = (value: string) => {
    const out: string[] = [];
    for (const part of value.replaceAll("\\", "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!out.length) return undefined;
        out.pop();
      } else out.push(part);
    }
    return out;
  };
  const base = normalize(root);
  const unified = path.replaceAll("\\", "/");
  const absolute = unified.startsWith("/") || /^[A-Za-z]:\//.test(unified);
  const target = normalize(absolute ? unified : `${root.replaceAll("\\", "/")}/${unified}`);
  if (!base || !target || target.length <= base.length) return undefined;
  if (!base.every((part, index) => part === target[index])) return undefined;
  return target.slice(base.length).join("/");
}

export type ToolLocation = { path: string; line?: number };

/** File locations an ACP tool call reports, in order. Entries without a string path are skipped. */
export function toolLocations(contentJson: string): ToolLocation[] {
  let update: unknown;
  try {
    update = JSON.parse(contentJson);
  } catch {
    return [];
  }
  const list = update && typeof update === "object" ? (update as Record<string, unknown>).locations : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
    if (!value || typeof value.path !== "string" || !value.path.trim()) return [];
    const line = typeof value.line === "number" && Number.isInteger(value.line) && value.line > 0 ? value.line : undefined;
    return [{ path: value.path, line }];
  });
}

/** Capability chips for the ready card, straight from what the agent reported in initialize. */
export function capabilityChips(features: AgentFeatures): Capability[] {
  return [
    { id: "load", label: "Resume", supported: features.loadSession },
    { id: "list", label: "List", supported: features.canListSessions },
    { id: "image", label: "Images", supported: features.image },
    { id: "embedded", label: "Embedded context", supported: features.embeddedContext },
    { id: "audio", label: "Audio", supported: features.audio },
    { id: "mcp-http", label: "MCP over HTTP", supported: features.mcpHttp },
  ];
}

export const promptCapabilities = (features: AgentFeatures | undefined): PromptCapabilities | undefined =>
  features ? { image: features.image, audio: features.audio, embeddedContext: features.embeddedContext } : undefined;

/** Splits a command line into the executable and its arguments. Supports single and double quotes and backslash escapes. */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("The command has an unclosed quote.");
  if (started) parts.push(current);
  return parts;
}

/** Flattens the agent's grouped select options into the popover view. Model first, then effort, then mode. */
export function configViews(options: readonly ConfigOption[]): ConfigOptionView[] {
  const order = (option: ConfigOption) => ["model", "thought_level", "mode"].indexOf(option.category ?? "") + 1 || 4;
  return [...options]
    .sort((a, b) => order(a) - order(b))
    .map((option) => ({
      id: option.id,
      name: option.name,
      category: option.category ?? undefined,
      currentValue: option.currentValue,
      choices: option.groups.flatMap((group) => group.choices.map((choice) => ({ value: choice.value, name: choice.name, description: choice.description ?? undefined }))),
    }));
}

export const currentChoice = (option: ConfigOptionView | undefined) => option?.choices.find((choice) => choice.value === option.currentValue);

/** One-based level of the current thought_level choice, for the small bar glyph in the composer. */
export function levelOf(option: ConfigOptionView | undefined): { index: number; count: number } | undefined {
  if (!option?.choices.length) return undefined;
  return { index: Math.max(0, option.choices.findIndex((choice) => choice.value === option.currentValue)) + 1, count: option.choices.length };
}

export type SpanCommand = { name: string; description: string };

/** Agent commands (sent as prompt text) and Span commands, filtered by what follows the slash. */
export function slashGroups(input: string, agentLabel: string, agentCommands: readonly SlashCommand[], spanCommands: readonly SpanCommand[]): SlashGroup[] {
  const query = input.replace(/^\//, "").toLowerCase();
  const match = (name: string) => name.toLowerCase().startsWith(query);
  const agent: SlashItem[] = agentCommands
    .filter((command) => match(command.name.replace(/^\//, "")))
    .map((command) => ({ name: `/${command.name.replace(/^\//, "")}`, hint: command.inputHint ?? undefined, description: command.description, source: "agent" }));
  const span: SlashItem[] = spanCommands.filter((command) => match(command.name)).map((command) => ({ name: `/${command.name}`, description: command.description, source: "span" }));
  return [
    { label: agentLabel, items: agent },
    { label: "Span", items: span },
  ].filter((group) => group.items.length);
}

/** True while the prompt is a bare slash command name with nothing typed after it. */
export const isSlashQuery = (text: string) => /^\/[^\s]*$/.test(text);

const KINDS: Record<string, StepKind> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "run", fetch: "fetch", think: "think" };
const NOUNS: Record<StepKind, [string, string]> = {
  read: ["read", "reads"],
  edit: ["edit", "edits"],
  search: ["search", "searches"],
  run: ["command", "commands"],
  fetch: ["fetch", "fetches"],
  think: ["thought", "thoughts"],
  other: ["step", "steps"],
};
export const stepKind = (toolKind: string | null | undefined): StepKind => KINDS[toolKind ?? ""] ?? "other";
const stepStatus = (status: string | null | undefined): StepStatus => (["pending", "in_progress", "completed", "failed"].includes(status ?? "") ? (status as StepStatus) : "pending");

const lines = (text: string) => (text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));

/** Line diff of a changed region: common leading and trailing lines become context (up to `context` each side). */
export function diffLines(before: string, after: string, context = 2, limit = 400): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const result: DiffLine[] = [];
  for (let index = Math.max(0, start - context); index < start; index++) result.push({ kind: "ctx", n: index + 1, text: a[index] });
  result.push(...middleDiff(a, b, start, endA, endB));
  for (let index = endB; index < Math.min(b.length, endB + context); index++) result.push({ kind: "ctx", n: index + 1, text: b[index] });
  return result.slice(0, limit);
}

/** Longest-common-subsequence diff of the changed region. Large regions fall back to delete-then-add. */
function middleDiff(a: string[], b: string[], start: number, endA: number, endB: number): DiffLine[] {
  const rows = endA - start;
  const cols = endB - start;
  if (rows * cols > 40_000) {
    return [
      ...a.slice(start, endA).map((text, index): DiffLine => ({ kind: "del", n: start + index + 1, text })),
      ...b.slice(start, endB).map((text, index): DiffLine => ({ kind: "add", n: start + index + 1, text })),
    ];
  }
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--)
    for (let j = cols - 1; j >= 0; j--) table[i][j] = a[start + i] === b[start + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && a[start + i] === b[start + j]) {
      out.push({ kind: "ctx", n: start + j + 1, text: b[start + j] });
      i++;
      j++;
    } else if (i < rows && (j === cols || table[i + 1][j] >= table[i][j + 1])) {
      out.push({ kind: "del", n: start + i + 1, text: a[start + i] });
      i++;
    } else {
      out.push({ kind: "add", n: start + j + 1, text: b[start + j] });
      j++;
    }
  }
  return out;
}

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

type ToolDiffLike = { path: string; resolved?: boolean; change?: string; oldText?: string | null; newText: string };

/**
 * Lines of a tool diff, with file line numbers only when they can be trusted. Adapters often send just the replaced
 * snippet as `oldText`, so numbers counted from it are not file lines. They are kept for a new file (the new text is
 * the whole file) and when the agent's location line agrees with the first changed line; otherwise the gutter is left
 * empty and the diff opens at the location line, or at the top of the file when there is none.
 */
function diffView(entry: ToolDiffLike, locationLine: number | undefined, limit?: number): { lines: DiffLine[]; openAt?: number } {
  const lines = diffLines(entry.oldText ?? "", entry.newText, 2, limit);
  const firstChanged = lines.find((line) => line.kind !== "ctx" && line.n !== undefined)?.n;
  const known = !entry.oldText || (locationLine !== undefined && locationLine === firstChanged);
  if (known) return { lines, openAt: firstChanged ?? locationLine };
  return { lines: lines.map(({ n: _n, ...line }) => line), openAt: locationLine };
}
/** The line of the location that names `path`, or of the only location when the call has exactly one. */
function lineFor(locations: readonly ToolLocation[], path: string): number | undefined {
  return (locations.find((location) => location.path === path) ?? (locations.length === 1 ? locations[0] : undefined))?.line;
}

/** Diffs from a tool call's `content` blocks, for requests that carry no typed `diffs`. */
function contentDiffs(content: unknown): ToolDiffLike[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    const block = record(entry);
    if (!block || block.type !== "diff" || typeof block.path !== "string") return [];
    return [{ path: block.path, resolved: false, oldText: text(block.oldText) ?? null, newText: text(block.newText) ?? "" }];
  });
}

/** Locations as `{ path, line? }`, preferring the typed field and falling back to the raw update. */
function typedLocations(typed: readonly { path: string; line?: number | null }[] | undefined, contentJson: string): ToolLocation[] {
  const source = typed?.length ? typed : toolLocations(contentJson);
  return source.flatMap((entry) => (entry.path.trim() ? [{ path: entry.path, line: entry.line && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : undefined }] : []));
}

const commandText = (input: unknown) => {
  const value = record(input);
  if (!value) return undefined;
  return Array.isArray(value.command) ? value.command.join(" ") : text(value.command);
};

const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/;
/** Largest base64 payload drawn as a thumbnail. Bigger images are listed without a preview. */
export const IMAGE_DATA_LIMIT = 6_000_000;
export type ToolImageData = { id: string; name: string; mime: string; base64: string };

/** Raster images a tool call carried as bytes. A `uri` is never fetched, and svg is never drawn. */
export function toolImages(tool: Pick<ToolEvent, "toolCallId" | "images">): ToolImageData[] {
  return (tool.images ?? []).flatMap((image, index) => {
    const mime = (image.mimeType ?? "").toLowerCase();
    if (!image.data || !IMAGE_MIME.test(mime) || image.data.length > IMAGE_DATA_LIMIT || !/^[A-Za-z0-9+/=\s]+$/.test(image.data)) return [];
    return [{ id: `${tool.toolCallId}:image:${index}`, name: `image-${index + 1}.${mime.slice(6) === "jpeg" ? "jpg" : mime.slice(6)}`, mime, base64: image.data.replace(/\s+/g, "") }];
  });
}

/** Maps one ACP tool call to a step row, with a diff or terminal detail only when the agent sent one. */
export function toStep(tool: ToolEvent, children: readonly ToolEvent[], root?: string, onOpen?: (path: string, line?: number) => void, onOpenImage?: (id: string) => void): StepView {
  const kind = stepKind(tool.toolKind);
  let update: Record<string, unknown> | undefined;
  try {
    update = record(JSON.parse(tool.contentJson));
  } catch {
    update = undefined;
  }
  const content = Array.isArray(update?.content) ? update!.content.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  // Typed fields win. contentJson is re-read only where the typed field is absent.
  const rawInput = tool.rawInput ?? update?.rawInput;
  const rawOutput = tool.rawOutput ?? update?.rawOutput;
  const hint = hintText(tool.hint);
  const pendingHint = tool.hint === "toolPending";
  const step: StepView = {
    id: tool.toolCallId,
    kind,
    verb: tool.title || (pendingHint ? hint! : "Tool call"),
    target: relativeTo(root, toolTarget(tool)) || undefined,
    status: stepStatus(tool.status),
  };
  if (tool.internal) step.internal = true;
  if (hint && !pendingHint) step.note = hint;
  const allLocations = typedLocations(tool.locations ?? undefined, tool.contentJson);
  const located = allLocations[0];
  // A path outside the workspace is shown as plain text: no click target that would only be refused.
  if (located && onOpen && workspaceRelative(root, located.path)) step.onOpen = () => onOpen(located.path, located.line);
  const diffs: ToolDiffLike[] = tool.diffs?.length ? [...tool.diffs] : contentDiffs(content);
  const diff = diffs[0];
  if (diff) {
    const path = relativeTo(root, diff.path);
    const all = diffs.map((entry) => diffLines(entry.oldText ?? "", entry.newText));
    const view = diffView(diff, lineFor(allLocations, diff.path));
    step.delta = { add: all.flat().filter((line) => line.kind === "add").length, del: all.flat().filter((line) => line.kind === "del").length };
    if (diffs.length > 1) step.meta = `+${diffs.length - 1} more ${diffs.length === 2 ? "file" : "files"}`;
    // An unresolved path is a bare name the agent sent, so it is shown but never opened. Nor is one outside the workspace.
    const openable = (diff.resolved !== false || tool.diffs === undefined || tool.diffs.length === 0) && Boolean(workspaceRelative(root, diff.path));
    step.detail = { type: "diff", path, lines: view.lines, onOpen: onOpen && openable ? () => onOpen(path, view.openAt) : undefined };
  } else if (kind === "run") {
    const command = commandText(rawInput);
    const output: TermLine[] = [];
    for (const entry of content) {
      const block = record(entry.content);
      if (entry.type === "content" && block?.type === "text" && text(block.text)) output.push(...lines(block.text as string).map((line) => ({ kind: "out" as const, text: line })));
    }
    const raw = rawOutput;
    let exitCode: number | undefined;
    if (!output.length && typeof raw === "string") output.push(...lines(raw).map((line) => ({ kind: "out" as const, text: line })));
    const rawRecord = record(raw);
    if (rawRecord) {
      if (!output.length) {
        for (const [key, kindName] of [["stdout", "out"], ["output", "out"], ["stderr", "err"]] as const)
          if (text(rawRecord[key])) output.push(...lines(rawRecord[key] as string).map((line) => ({ kind: kindName, text: line })));
      }
      const code = rawRecord.exit_code ?? rawRecord.exitCode;
      if (typeof code === "number") exitCode = code;
    }
    if (command || output.length) {
      step.detail = {
        type: "terminal",
        lines: [...(command ? [{ kind: "cmd" as const, text: command }] : []), ...output.slice(-200)],
        exitCode,
        running: step.status === "in_progress",
      };
    }
  }
  const images: StepImage[] = toolImages(tool).map((image) => ({
    id: image.id,
    name: image.name,
    mime: image.mime,
    src: `data:${image.mime};base64,${image.base64}`,
    onOpen: onOpenImage ? () => onOpenImage(image.id) : undefined,
  }));
  if (images.length) step.images = images;
  if (tool.savedPath) step.savedPath = tool.savedPath;
  if (children.length) {
    step.children = children.map(
      (child): ChildStep => ({
        id: child.toolCallId,
        kind: stepKind(child.toolKind),
        verb: child.title || (child.hint === "toolPending" ? hintText(child.hint)! : "Tool call"),
        target: relativeTo(root, toolTarget(child)) || undefined,
        meta: child.status && child.status !== "completed" ? child.status.replaceAll("_", " ") : undefined,
      }),
    );
  }
  return step;
}

const PERMISSION_DIFFS = 3;
const INPUT_LIMIT = 1200;
const COMMAND_LIMIT = 2000;
const clip = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit - 1)}…` : value);

/** A bounded, readable view of a request's raw input. Empty for null, an empty object, or nothing. */
export function boundedInput(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "object" && Object.keys(raw as object).length === 0) return undefined;
  try {
    return clip(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2), INPUT_LIMIT);
  } catch {
    return undefined;
  }
}

/**
 * What a permission request asks the user to approve, from its typed fields (the raw `content` blocks are the
 * fallback for diffs only). Paths are shown workspace-relative and open only through `onOpen`, which the
 * caller validates against the workspace.
 */
export function permissionDetails(event: PermissionEvent, root?: string, onOpen?: (path: string, line?: number) => void, tool?: ToolEvent): PermissionDetails {
  const rawInput = event.rawInput ?? tool?.rawInput;
  const command = commandText(rawInput);
  const located = typedLocations(event.locations ?? tool?.locations ?? undefined, tool?.contentJson ?? "{}");
  const locations: PermissionLocation[] = located.map((location) => ({
    label: relativeTo(root, location.path),
    line: location.line,
    onOpen: onOpen && workspaceRelative(root, location.path) ? () => onOpen(location.path, location.line) : undefined,
  }));
  const found: ToolDiffLike[] = event.diffs?.length ? [...event.diffs] : contentDiffs(event.content);
  const diffs: PermissionDiff[] = found.slice(0, PERMISSION_DIFFS).map((entry) => {
    const view = diffView(entry, lineFor(located, entry.path), 120);
    return {
      path: relativeTo(root, entry.path),
      change: entry.change ?? (entry.oldText ? "modify" : "add"),
      lines: view.lines,
      // A path that was not resolved is a bare name from the agent: shown, never opened.
      onOpen: onOpen && entry.resolved !== false && workspaceRelative(root, entry.path) ? () => onOpen(entry.path, view.openAt) : undefined,
    };
  });
  const target = command ?? (tool ? toolTarget({ ...tool, rawInput }) : toolTarget({ rawInput, locations: event.locations, contentJson: "{}" }));
  const onlyCommand = command !== undefined && record(rawInput) && Object.keys(record(rawInput)!).every((key) => key === "command" || key === "description");
  return {
    kind: event.toolKind ?? undefined,
    command: target ? clip(relativeTo(root, target), COMMAND_LIMIT) : undefined,
    input: onlyCommand ? undefined : boundedInput(rawInput),
    locations,
    diffs,
    moreDiffs: Math.max(0, found.length - PERMISSION_DIFFS),
    internal: Boolean(event.internal),
  };
}

/** Title and body of a notice. The hint copy fills in whichever the agent left empty, and is not repeated. */
export function noticeView(notice: { title: string; description?: string; hint?: AgentHint | null }): { title: string; description?: string } {
  const hint = hintText(notice.hint);
  const title = notice.title.trim() || hint || "";
  const description = notice.description?.trim() || (hint && hint !== title ? hint : undefined);
  return { title, description };
}

/** One-line summary and the rest of a long warning. Home folders read as ~ and the split is at the first sentence. */
export function warningParts(title: string, description?: string): { summary: string; detail?: string } {
  const text = [title, description].filter(Boolean).join(" ").replace(/\/(Users|home)\/[^/\s]+/g, "~").replace(/\s+/g, " ").trim();
  const cut = /[.!?](?=\s|$)/.exec(text);
  if (!cut || cut.index + 1 >= text.length) return { summary: text };
  return { summary: text.slice(0, cut.index + 1), detail: text.slice(cut.index + 1).trim() };
}

/** "Working" or "Worked" plus counts by kind, for example "2 reads, 1 edit". */
export function workSummary(steps: readonly StepView[]): { headline: string; counts: string } {
  const running = steps.some((step) => step.status === "in_progress" || step.status === "pending");
  const counts = new Map<StepKind, number>();
  for (const step of steps.filter((entry) => !entry.internal)) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, count]) => `${count} ${NOUNS[kind][count === 1 ? 0 : 1]}`);
  return { headline: running ? "Working" : "Worked", counts: parts.join(", ") };
}

const countLines = (value: string) => (value === "" ? 0 : value.split("\n").length);

/** One changed-file row per proposal. The row id is the proposal id, so actions map back to the review flow. */
export function changedFiles(proposals: readonly Extract<FeedItem, { kind: "proposal" }>[]): ChangedFile[] {
  return proposals.map((item) => ({
    path: item.proposal.id,
    name: leaf(item.proposal.path),
    dir: parent(item.proposal.path) || undefined,
    add: item.proposal.hunks.reduce((sum, hunk) => sum + countLines(hunk.after), 0),
    del: item.proposal.hunks.reduce((sum, hunk) => sum + countLines(hunk.before), 0),
    state: item.resolution ?? "pending",
  }));
}

export type Block =
  | { key: string; type: "item"; item: FeedItem }
  | { key: string; type: "work"; tools: ToolEvent[] }
  | { key: string; type: "changes"; proposals: Extract<FeedItem, { kind: "proposal" }>[] };

/**
 * Groups the feed for rendering. Consecutive tool calls form one work group, nested subagent calls stay
 * under their parent, permissions render as a dock, and each turn's proposals collect into one changes
 * card at the end of that turn.
 */
export function buildBlocks(feed: readonly FeedItem[]): Block[] {
  const blocks: Block[] = [];
  let work: Extract<Block, { type: "work" }> | undefined;
  let changes: Extract<Block, { type: "changes" }> | undefined;
  const closeTurn = () => {
    if (changes) blocks.push(changes);
    changes = undefined;
  };
  for (const item of feed) {
    if (item.kind === "permission") continue;
    if (item.kind === "tool") {
      if (isNestedTool(feed, item.event)) continue;
      if (!work) {
        work = { key: `work-${item.id}`, type: "work", tools: [] };
        blocks.push(work);
      }
      work.tools.push(item.event);
      continue;
    }
    if (item.kind === "proposal") {
      if (!changes) changes = { key: `changes-${item.id}`, type: "changes", proposals: [] };
      changes.proposals.push(item);
      continue;
    }
    work = undefined;
    if (item.kind === "user") closeTurn();
    blocks.push({ key: `item-${item.id}`, type: "item", item });
  }
  closeTurn();
  return blocks;
}

export const workChildren = (feed: readonly FeedItem[], tool: ToolEvent) => subagentChildren(feed, tool.toolCallId);

export type StopView = { title: string; text: string };
const STOPS: Record<string, StopView> = {
  max_tokens: { title: "Response hit the token limit", text: "The agent stopped because its reply reached the maximum length. Continue asks it to pick up where it left off." },
  max_turn_requests: { title: "Turn request limit reached", text: "The agent used its allowed number of model requests for this turn. Continue starts another turn." },
  refusal: { title: "The agent declined to continue", text: "The agent refused this request. Rephrase it, or continue if you think it was a mistake." },
};
/** `hint` is the backend's finer reading of a stop reason: Gemini sends max_turn_requests for a loop too. */
export function stopView(reason: string, hint?: AgentHint | null): StopView | undefined {
  const view = STOPS[reason];
  if (view && hint === "turnLimitOrLoop")
    return { title: hintText(hint)!, text: "This agent reports a turn limit and a loop with the same stop reason, so Span cannot tell which. Continue starts another turn." };
  return view;
}

export type FailureView = { level: "error" | "warn"; kind: "missing-binary" | "protocol" | "auth" | "timeout" | "exit" | "provider" | "workspace" | "other"; title: string; text: string };

/** Names a failure from the real message the backend or agent reported. The raw message is always kept. */
export function classifyFailure(failure: Failure): FailureView {
  const message = failure.message.trim() || "No details were reported.";
  // A command that answers without ACP session support gets a plain explanation instead of the JSON-RPC error.
  const view = (kind: FailureView["kind"], title: string, level: FailureView["level"] = "error"): FailureView => ({ level, kind, title, text: agentFailureMessage(message) });
  if (/executable was not found|no such file or directory|command not found|ENOENT/i.test(message)) return view("missing-binary", "Agent executable not found");
  if (/unsupported protocol version/i.test(message)) return view("protocol", "Incompatible ACP protocol version");
  if (/open a folder|open a workspace|cwd must match/i.test(message)) return view("workspace", "Open a folder first", "warn");
  if (failure.phase === "auth" || /authentication required|unauthori[sz]ed|invalid api key|not logged in|\b401\b/i.test(message)) return view("auth", failure.phase === "auth" ? "Sign-in failed" : "Sign-in needed");
  if (/rate limit|too many requests|\b429\b/i.test(message)) return view("provider", "Provider rate limit reached", "warn");
  if (/overloaded|\b529\b|\b503\b|service unavailable/i.test(message)) return view("provider", "Provider is unavailable", "warn");
  if (/timed out|did not respond|within \d+ seconds/i.test(message)) return view("timeout", "The agent did not respond");
  if (failure.phase === "exit" || /exited before initialization|process disconnected|connection was terminated/i.test(message)) return view("exit", "Agent process exited");
  if (failure.phase === "connect") return view("other", "Could not connect the agent");
  return view("other", failure.phase === "session" ? "Session error" : "Agent error");
}

export type FormField = {
  key: string;
  label: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "unsupported";
  options: (QuestionOption & { value: string | number | boolean })[];
  required: boolean;
};

/** Reads the flat JSON schema of a form elicitation into one question per property. */
export function formFields(schemaJson: string | null | undefined): FormField[] {
  let schema: Record<string, unknown> | undefined;
  try {
    schema = record(JSON.parse(schemaJson || "{}"));
  } catch {
    return [];
  }
  const properties = record(schema?.properties) ?? {};
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((value): value is string => typeof value === "string") : [];
  return Object.entries(properties).map(([key, raw]) => {
    const property = record(raw) ?? {};
    const declared = text(property.type);
    const type: FormField["type"] = declared === "string" || declared === "number" || declared === "integer" || declared === "boolean" ? declared : "unsupported";
    const names = Array.isArray(property.enumNames) ? property.enumNames : [];
    let options: FormField["options"] = [];
    if (Array.isArray(property.enum))
      options = property.enum
        .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
        .map((value, index) => ({ id: String(value), label: text(names[index]) ?? String(value), value }));
    else if (Array.isArray(property.oneOf) || Array.isArray(property.anyOf))
      options = ((property.oneOf ?? property.anyOf) as unknown[])
        .map(record)
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && (typeof entry!.const === "string" || typeof entry!.const === "number"))
        .map((entry) => ({ id: String(entry.const), label: text(entry.title) ?? String(entry.const), description: text(entry.description), value: entry.const as string | number }));
    else if (type === "boolean")
      options = [
        { id: "true", label: "Yes", value: true },
        { id: "false", label: "No", value: false },
      ];
    return { key, label: text(property.title) ?? key, description: text(property.description), type, options, required: required.includes(key) };
  });
}

/** Converts a typed answer to the field's JSON type, or explains why it does not fit. */
export function coerceAnswer(field: FormField, answer: { optionId?: string; text?: string }): { value: string | number | boolean } | { error: string } {
  if (answer.optionId !== undefined) {
    const option = field.options.find((candidate) => candidate.id === answer.optionId);
    return option ? { value: option.value } : { error: "That choice is not offered." };
  }
  const raw = (answer.text ?? "").trim();
  if (field.type === "number" || field.type === "integer") {
    const value = Number(raw);
    if (!raw || Number.isNaN(value)) return { error: `${field.label} must be a number.` };
    if (field.type === "integer" && !Number.isInteger(value)) return { error: `${field.label} must be a whole number.` };
    return { value };
  }
  if (field.type === "boolean") return { error: `Choose Yes or No for ${field.label}.` };
  return { value: raw };
}

const fence = (body: string) => {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
};
const fileUri = (root: string | undefined, path: string) => {
  const absolute = path.startsWith("/") || !root ? path : `${root.replace(/\/$/, "")}/${path}`;
  return `file://${absolute.split("/").map(encodeURIComponent).join("/")}`;
};
const attachmentUri = (root: string | undefined, item: Attachment) => (item.path ? fileUri(root, item.path) : `attachment:${encodeURIComponent(item.name)}`);

export type BuiltPrompt = { text: string; attachments: PromptAttachment[]; blocked: { item: Attachment; reason: string }[] };

/**
 * Turns composer attachments into ACP prompt content using the agent's real prompt capabilities.
 * Text the agent cannot take as embedded context is inlined into the prompt text.
 */
export function buildPrompt(message: string, items: readonly Attachment[], caps: PromptCapabilities, root?: string): BuiltPrompt {
  const gate = gateAttachments(items, caps);
  const blocked = [...gate.blocked];
  const attachments: PromptAttachment[] = [];
  const inline: string[] = [];
  for (const { item, plan } of gate.send) {
    if (plan.mode === "image" && item.bytes) attachments.push({ kind: "image", data: bytesToBase64(item.bytes), mimeType: item.mime, uri: item.path ? fileUri(root, item.path) : null });
    else if (plan.mode === "resource" && item.text !== undefined) attachments.push({ kind: "resource", uri: attachmentUri(root, item), mimeType: item.mime, text: item.text, blob: null });
    else if (plan.mode === "resource" && item.bytes) attachments.push({ kind: "resource", uri: attachmentUri(root, item), mimeType: item.mime, text: null, blob: bytesToBase64(item.bytes) });
    else if (plan.mode === "link" && item.path) attachments.push({ kind: "resourceLink", uri: fileUri(root, item.path), name: item.name, mimeType: item.mime, description: null });
    else if (plan.mode === "text" && item.text !== undefined) {
      const mark = fence(item.text);
      inline.push(`${item.path ?? item.name}:\n${mark}\n${item.text}\n${mark}`);
    } else blocked.push({ item, reason: plan.mode === "audio" ? "Span cannot send audio to agents yet." : "The content is no longer available." });
  }
  return { text: inline.length ? `${message}${message ? "\n\n" : ""}Attached:\n\n${inline.join("\n\n")}` : message, attachments, blocked };
}

const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PROTECTED_NAME = /^(?:\.git|\.span|node_modules)$/i;
const NAME_BYTES = 255;

/**
 * File name for saving an attachment into the workspace, made acceptable to core `save_attachment` (which rejects,
 * and never fixes, a bad name): path separators, `< > : " | ? *` and control characters become `-`, trailing dots and
 * spaces go, a reserved Windows device name or protected folder name gets a `_` prefix, and the name is kept under
 * 255 bytes. Pasted text without an extension is saved as .txt. The saved name is what the attachment shows afterwards.
 */
export function saveName(item: Attachment): string {
  let name = item.name.replace(/[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/g, "-").replace(/[. ]+$/, "");
  if (!name) name = "attachment";
  if (!/\.[A-Za-z0-9]+$/.test(name)) name = `${name}.txt`;
  const dot = name.lastIndexOf(".");
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  if (RESERVED_NAME.test(stem.split(".")[0].trimEnd()) || PROTECTED_NAME.test(name)) stem = `_${stem}`;
  const encoder = new TextEncoder();
  while (stem.length > 1 && encoder.encode(stem + extension).length > NAME_BYTES) stem = stem.slice(0, -1);
  return stem + extension;
}

