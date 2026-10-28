import type { AgentFeatures, ConfigOption_Deserialize as ConfigOption, PromptAttachment, SlashCommand } from "../bindings";
import type { Capability, ChangedFile, ChildStep, ConfigOptionView, DiffLine, QuestionOption, SlashGroup, SlashItem, StepKind, StepStatus, StepView, TermLine } from "../components/agent/types";
import { isNestedTool, subagentChildren, toolSummary } from "./agent-feed";
import type { Failure, FeedItem, ToolEvent } from "./agent-session";
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

/** Maps one ACP tool call to a step row, with a diff or terminal detail only when the agent sent one. */
export function toStep(tool: ToolEvent, children: readonly ToolEvent[], root?: string, onOpen?: (path: string) => void): StepView {
  const kind = stepKind(tool.toolKind);
  let update: Record<string, unknown> | undefined;
  try {
    update = record(JSON.parse(tool.contentJson));
  } catch {
    update = undefined;
  }
  const content = Array.isArray(update?.content) ? update!.content.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const step: StepView = {
    id: tool.toolCallId,
    kind,
    verb: tool.title || "Tool call",
    target: relativeTo(root, toolSummary(tool.contentJson)) || undefined,
    status: stepStatus(tool.status),
  };
  const diff = content.find((entry) => entry.type === "diff" && typeof entry.path === "string");
  if (diff) {
    const path = relativeTo(root, diff.path as string);
    const diffed = diffLines(text(diff.oldText) ?? "", text(diff.newText) ?? "");
    step.delta = { add: diffed.filter((line) => line.kind === "add").length, del: diffed.filter((line) => line.kind === "del").length };
    step.detail = { type: "diff", path, lines: diffed, onOpen: onOpen ? () => onOpen(path) : undefined };
  } else if (kind === "run") {
    const input = record(update?.rawInput);
    const command = Array.isArray(input?.command) ? input!.command.join(" ") : text(input?.command);
    const output: TermLine[] = [];
    for (const entry of content) {
      const block = record(entry.content);
      if (entry.type === "content" && block?.type === "text" && text(block.text)) output.push(...lines(block.text as string).map((line) => ({ kind: "out" as const, text: line })));
    }
    const raw = update?.rawOutput;
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
  if (children.length) {
    step.children = children.map(
      (child): ChildStep => ({
        id: child.toolCallId,
        kind: stepKind(child.toolKind),
        verb: child.title || "Tool call",
        target: relativeTo(root, toolSummary(child.contentJson)) || undefined,
        meta: child.status && child.status !== "completed" ? child.status.replaceAll("_", " ") : undefined,
      }),
    );
  }
  return step;
}

/** "Working" or "Worked" plus counts by kind, for example "2 reads, 1 edit". */
export function workSummary(steps: readonly StepView[]): { headline: string; counts: string } {
  const running = steps.some((step) => step.status === "in_progress" || step.status === "pending");
  const counts = new Map<StepKind, number>();
  for (const step of steps) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
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
export const stopView = (reason: string): StopView | undefined => STOPS[reason];

export type FailureView = { level: "error" | "warn"; kind: "missing-binary" | "protocol" | "auth" | "timeout" | "exit" | "provider" | "workspace" | "other"; title: string; text: string };

/** Names a failure from the real message the backend or agent reported. The raw message is always kept. */
export function classifyFailure(failure: Failure): FailureView {
  const message = failure.message.trim() || "No details were reported.";
  const view = (kind: FailureView["kind"], title: string, level: FailureView["level"] = "error"): FailureView => ({ level, kind, title, text: message });
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

/** Workspace-relative name for a saved attachment. Pasted text without an extension is saved as .txt. */
export const saveName = (item: Attachment) => (/\.[A-Za-z0-9]+$/.test(item.name) ? item.name : `${item.name}.txt`).replace(/[\\/:]/g, "-");

