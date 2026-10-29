/** View-model types for the Agent sidebar leaf components. They are plain data, not tied to IPC bindings. */

export type Brand = { id?: string; name?: string };

/** ACP permission option kinds. */
export type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export type PermissionChoice = { optionId: string; name: string; kind: PermissionKind | (string & {}) };

export type FoundAgent = Brand & { id: string; name: string; subtitle?: string };
export type RegistryStatus = "available" | "installing" | "unsupported";
export type RegistryAgent = Brand & {
  id: string;
  name: string;
  subtitle?: string;
  status: RegistryStatus;
  /** 0 to 1 while installing. Leave undefined for an indeterminate bar. */
  progress?: number;
};

export type PhaseState = "pending" | "active" | "done" | "failed";
export type Phase = { id: string; label: string; meta?: string; state: PhaseState };

export type Capability = { id: string; label: string; supported: boolean };

export type KeyHint = { keys: string[]; label: string; where?: string };
export type RecentSession = { id: string; title: string; time: string; brand?: Brand };

/** What a sign-in method asks the user to type. Absent for methods that need nothing. */
export type AuthInputKind = "apiKey" | "gateway";
export type AuthMethod = {
  id: string;
  name: string;
  description?: string;
  input?: AuthInputKind;
  /** For a gateway method, the protocol the agent expects from the gateway, for example `anthropic` or `openai`. */
  protocol?: string;
};
/** A secret the user typed. It exists only inside the form and the call that sends it. */
export type AuthSecret = { kind: "apiKey"; key: string } | { kind: "gateway"; baseUrl: string; headers: Record<string, string> };

export type Level = "error" | "warn";
export type ActionView = { label: string; primary?: boolean; onAct: () => void };

export type ConfigChoice = { value: string; name: string; description?: string };
/** A session config option reported by the agent (ACP select option). */
export type ConfigOptionView = {
  id: string;
  name: string;
  /** ACP category such as model, mode or thought_level. Unknown categories render as a plain list. */
  category?: string;
  currentValue: string;
  choices: ConfigChoice[];
};
export type AgentChoice = Brand & { id: string; name: string; subtitle?: string; current?: boolean };

export type SlashItem = { name: string; hint?: string; description?: string; source: "agent" | "span" };
export type SlashGroup = { label: string; items: SlashItem[] };

export type QuestionOption = { id: string; label: string; description?: string };
export type QuestionAnswer = { optionId?: string; text?: string };

export type StepKind = "read" | "search" | "edit" | "run" | "fetch" | "think" | "other";
export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export type DiffLine = { kind: "add" | "del" | "ctx"; n?: number; text: string };
export type TermLine = { kind: "cmd" | "out" | "err"; text: string };
export type SearchMatch = { loc: string; text: string };
export type StepDetail =
  | { type: "terminal"; lines: TermLine[]; cwd?: string; exitCode?: number | null; running?: boolean }
  | { type: "diff"; path: string; lines: DiffLine[]; onOpen?: () => void }
  | { type: "matches"; matches: SearchMatch[] };
export type StepImage = { id: string; name: string; mime: string; src: string; onOpen?: () => void };
export type ChildStep = { id: string; kind: StepKind; verb: string; target?: string; meta?: string };
export type StepView = {
  id: string;
  kind: StepKind;
  verb: string;
  target?: string;
  status: StepStatus;
  meta?: string;
  delta?: { add: number; del: number };
  detail?: StepDetail;
  children?: ChildStep[];
  /** Opens the file this step touched, at its reported line. Set only when the agent reported a location. */
  onOpen?: () => void;
  /** Agent bookkeeping, shown collapsed under a muted row. */
  internal?: boolean;
  /** Short UI copy for a backend hint, for example "Output not available from agent". */
  note?: string;
  images?: StepImage[];
  /** An untrusted agent path. Previews require a successful native workspace-scoped read. */
  savedPath?: string;
  savedImageNote?: string;
};

export type PermissionLocation = { label: string; line?: number; onOpen?: () => void };
export type PermissionDiff = { path: string; change: string; lines: DiffLine[]; onOpen?: () => void };
/** What the user is approving, from the typed fields of a permission request. */
export type PermissionDetails = {
  kind?: string;
  /** The command text for an execute request, or the first target of another kind. */
  command?: string;
  /** A bounded JSON view of the raw input, only when it says more than the command. */
  input?: string;
  locations: PermissionLocation[];
  diffs: PermissionDiff[];
  /** Diffs past the first few, counted but not drawn. */
  moreDiffs: number;
  internal: boolean;
  /** The agent asks here and again when it proposes the write. */
  doubleApproval?: boolean;
};

export type PresetRow = { id: string; name: string; description: string; command: string };

export type ChangedFile = {
  path: string;
  name: string;
  dir?: string;
  add: number;
  del: number;
  state: "pending" | "accepted" | "rejected";
};

export type PlanStatus = "pending" | "in_progress" | "completed";
export type PlanItem = { text: string; status: PlanStatus };

export type QueueItem = { id: string; text: string };

export type SessionRow = {
  id: string;
  brand?: Brand;
  title: string;
  /** Epoch milliseconds of the last update. */
  updatedAt: number;
  inWorkspace: boolean;
  current?: boolean;
  /** Agents of the session, drawn as stacked avatars. Absent or empty falls back to `brand`. */
  agents?: { id: string; name: string }[];
  models?: string[];
  /** Files the session changed, from stored metadata. Absent means unknown and shows nothing. */
  files?: number;
  /** Lines added and removed, from stored metadata. Absent means unknown and shows nothing. */
  delta?: { add: number; del: number };
  /** Span tracked every change of the chat and there were none: shows "No changes". */
  noChanges?: boolean;
  /** Archived in Span's metadata: listed only under the Archived filter. */
  archived?: boolean;
  /** The session's folder when it is not this workspace ("All folders" scope). Such a row cannot be opened here. */
  folder?: string;
  /** True when the agent lacks session/load, so the row cannot be reopened. */
  locked?: boolean;
  /** The session's state from the backend. Absent for a session Span does not hold, which then shows no state. */
  status?: import("../../lib/agent-chats").RowStatus;
};
export type HistoryScope = "workspace" | "all";
