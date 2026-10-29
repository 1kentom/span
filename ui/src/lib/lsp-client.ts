import type { Text } from "@codemirror/state";
import type {
  CompletionListDto_Serialize, DiagnosticsPublished_Deserialize, HoverDto_Serialize, LanguageServerError_Deserialize,
  LanguageServerId, LanguageServerInstallProgress_Deserialize, LanguageServerStateChanged_Deserialize, LocationDto,
  LspErrorDto, LspResponse, PositionDto, RangeDto, ServerStatusDto_Serialize, TextEditDto,
} from "../bindings";

/** The Tauri command and event boundary. Tests replace it with a fixture. */
export interface LspPort {
  completion(path: string, position: PositionDto, triggerCharacter: string | null, requestId: string | null): Promise<LspResponse<CompletionListDto_Serialize>>;
  hover(path: string, position: PositionDto, requestId: string | null): Promise<LspResponse<HoverDto_Serialize | null>>;
  definition(path: string, position: PositionDto, requestId: string | null): Promise<LspResponse<LocationDto[]>>;
  format(path: string, range: RangeDto | null, requestId: string | null): Promise<LspResponse<TextEditDto[]>>;
  cancel(requestId: string): Promise<unknown>;
  install(server: LanguageServerId): Promise<unknown>;
  restart(server: LanguageServerId): Promise<unknown>;
  status(): Promise<ServerStatusDto_Serialize[]>;
  onDiagnostics(listener: (event: DiagnosticsPublished_Deserialize) => void): Promise<() => void>;
  onState(listener: (event: LanguageServerStateChanged_Deserialize) => void): Promise<() => void>;
  onInstallProgress(listener: (event: LanguageServerInstallProgress_Deserialize) => void): Promise<() => void>;
  onError(listener: (event: LanguageServerError_Deserialize) => void): Promise<() => void>;
}

/** Servers the editor wires up, keyed the way the Rust catalog resolves files. */
const extensionServers: Readonly<Record<string, LanguageServerId>> = {
  ts: "vtsls", tsx: "vtsls", mts: "vtsls", cts: "vtsls", js: "vtsls", jsx: "vtsls", mjs: "vtsls", cjs: "vtsls",
  html: "html", htm: "html",
  css: "css", scss: "css", less: "css",
  json: "json", jsonc: "json",
  rs: "rust-analyzer",
  py: "basedpyright", pyi: "basedpyright",
  java: "jdtls",
  svelte: "svelte",
};

/** The language server family of a buffer, or undefined when none handles it. Settings buffers are never served. */
export function serverForBuffer(path: string): LanguageServerId | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return extensionServers[name.slice(dot + 1).toLowerCase()];
}

export const serverLabels: Readonly<Record<LanguageServerId, string>> = {
  vtsls: "vtsls", html: "HTML language server", css: "CSS language server", json: "JSON language server",
  "rust-analyzer": "rust-analyzer", basedpyright: "basedpyright", jdtls: "Java (Eclipse JDT LS)", svelte: "Svelte language server",
};

/** CodeMirror offsets are UTF-16 code units, exactly like LSP characters, so this only clamps. */
export function positionToOffset(doc: Text, position: PositionDto): number {
  if (!Number.isFinite(position.line) || position.line < 0) return 0;
  if (position.line >= doc.lines) return doc.length;
  const line = doc.line(Math.floor(position.line) + 1);
  const character = Number.isFinite(position.character) ? Math.floor(position.character) : 0;
  return line.from + Math.max(0, Math.min(line.length, character));
}

export function offsetToPosition(doc: Text, offset: number): PositionDto {
  const clamped = Math.max(0, Math.min(doc.length, Math.floor(offset)));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, character: clamped - line.from };
}

export function rangeToOffsets(doc: Text, range: RangeDto): { from: number; to: number } {
  const from = positionToOffset(doc, range.start);
  const to = positionToOffset(doc, range.end);
  return from <= to ? { from, to } : { from: to, to: from };
}

export function normalizeLspError(error: unknown): LspErrorDto {
  if (error && typeof error === "object" && typeof (error as { kind?: unknown }).kind === "string") return error as LspErrorDto;
  if (error instanceof Error) return { kind: "other", message: error.message };
  return { kind: "other", message: typeof error === "string" ? error : "The language server request failed." };
}

/** Stale and cancelled replies are expected whenever the user keeps typing, so they are never shown. */
export const isSilentLspError = (error: LspErrorDto) => error.kind === "stale" || error.kind === "cancelled";

export function describeLspError(error: LspErrorDto): string {
  switch (error.kind) {
    case "notReady": return error.message || "The language server is not ready.";
    case "unsupported": return error.message || "No language server handles this file.";
    case "needsInstall": return `${serverLabels[error.server]} is not installed.`;
    case "installFailed": return `Installing ${serverLabels[error.server]} failed: ${error.reason}`;
    case "startFailed": return `${serverLabels[error.server]} did not start: ${error.reason}`;
    case "runtimeMissing": return runtimeMissingMessage(error.server, error.runtime, error.requiredVersion, error.found);
    case "serverCrashed": return error.message || "The language server stopped unexpectedly.";
    case "cancelled": return "The request was cancelled.";
    case "stale": return "The document changed before the language server replied.";
    case "other": return error.message;
  }
}

export function runtimeLabel(runtime: string): string {
  return /^(java|jdk)$/i.test(runtime) ? "JDK" : runtime;
}

export function runtimeMissingMessage(server: LanguageServerId, runtime: string, requiredVersion: number, found: readonly string[]): string {
  return `${serverLabels[server]} needs ${runtimeLabel(runtime)} ${requiredVersion} or newer, found: ${found.length ? found.join(", ") : "none"}`;
}

export type LspOutcome<T> =
  | { kind: "ok"; response: LspResponse<T> }
  | { kind: "silent" }
  | { kind: "error"; error: LspErrorDto; message: string };

export type LspRequestKind = "completion" | "hover" | "definition" | "format";

export interface LspSession {
  completion(path: string, position: PositionDto, triggerCharacter: string | null): Promise<LspOutcome<CompletionListDto_Serialize>>;
  hover(path: string, position: PositionDto): Promise<LspOutcome<HoverDto_Serialize | null>>;
  definition(path: string, position: PositionDto): Promise<LspOutcome<LocationDto[]>>;
  format(path: string, range?: RangeDto | null): Promise<LspOutcome<TextEditDto[]>>;
  /** Cancels everything in flight. Later requests resolve silently. */
  dispose(): void;
}

let sequence = 0;
const nextRequestId = () => `ui-${Date.now().toString(36)}-${(++sequence).toString(36)}`;

interface Flight { id: string; superseded: boolean }

/**
 * One session per editor view. A newer request of the same kind cancels the older one in
 * the backend and makes its reply silent. Nothing here ever rejects.
 */
export function createLspSession(port: Pick<LspPort, "completion" | "hover" | "definition" | "format" | "cancel">): LspSession {
  const inflight = new Map<LspRequestKind, Flight>();
  let disposed = false;
  const cancel = (id: string) => { void Promise.resolve().then(() => port.cancel(id)).catch(() => undefined); };
  async function run<T>(kind: LspRequestKind, call: (requestId: string) => Promise<LspResponse<T>>): Promise<LspOutcome<T>> {
    if (disposed) return { kind: "silent" };
    const previous = inflight.get(kind);
    if (previous) { previous.superseded = true; cancel(previous.id); }
    const flight: Flight = { id: nextRequestId(), superseded: false };
    inflight.set(kind, flight);
    try {
      const response = await call(flight.id);
      if (flight.superseded || disposed) return { kind: "silent" };
      return { kind: "ok", response };
    } catch (cause) {
      if (flight.superseded || disposed) return { kind: "silent" };
      const error = normalizeLspError(cause);
      return isSilentLspError(error) ? { kind: "silent" } : { kind: "error", error, message: describeLspError(error) };
    } finally {
      if (inflight.get(kind) === flight) inflight.delete(kind);
    }
  }
  return {
    completion: (path, position, trigger) => run("completion", id => port.completion(path, position, trigger, id)),
    hover: (path, position) => run("hover", id => port.hover(path, position, id)),
    definition: (path, position) => run("definition", id => port.definition(path, position, id)),
    format: (path, range = null) => run("format", id => port.format(path, range, id)),
    dispose() {
      disposed = true;
      for (const flight of inflight.values()) { flight.superseded = true; cancel(flight.id); }
      inflight.clear();
    },
  };
}
