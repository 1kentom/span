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

export type AuthMethod = { id: string; name: string; description?: string };

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
};

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
  models?: string[];
  meta?: string;
  delta?: { add: number; del: number };
  /** True when the agent lacks session/load, so the row cannot be reopened. */
  locked?: boolean;
};
export type HistoryScope = "workspace" | "all";
