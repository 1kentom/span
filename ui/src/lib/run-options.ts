import type { CurrentFileRun_Serialize as CurrentFileRun, RunCatalog_Serialize as RunCatalog, RunConfiguration_Serialize as RunConfiguration } from "../bindings";

/** Selection id of the synthesized "Run current file" entry. Never saved to .span/run.json. */
export const CURRENT_FILE_OPTION = "span:current-file";

export type RunOptionKind = "current-file" | "saved" | "detected";
/** Presentation rows, derived from generated IPC values. */
export type RunConfigurationOption = {
  id: string; label: string; kind: RunOptionKind;
  /** Command line or reason shown as the secondary line. */
  detail?: string;
  /** Manifest the task was detected from, used for the group heading and logo. */
  source?: string;
  /** Short name for the toolbar trigger when it differs from the row label. */
  triggerLabel?: string;
  disabled?: boolean;
};
export type RunOptionGroup = { key: string; heading?: string; auto: boolean; options: RunConfigurationOption[] };

const quote = (value: string) => (value === "" || /[\s"'\\$`]/.test(value) ? JSON.stringify(value) : value);
/** Display form of the argv a configuration runs. No shell is involved; quoting is only for reading. */
export function commandLine(configuration: Pick<RunConfiguration, "executable" | "args" | "cwd">): string {
  const command = [configuration.executable, ...configuration.args].map(quote).join(" ");
  return configuration.cwd && configuration.cwd !== "." ? `${command}  (in ${configuration.cwd})` : command;
}

const sourceSuffix: Record<string, string> = { "package.json": " scripts", "Makefile": " targets" };
/** Group heading for tasks detected from one manifest, for example "Detected from pom.xml". */
export function detectedHeading(source: string): string {
  return `Detected from ${source}${sourceSuffix[source] ?? ""}`;
}

export function runOptions(catalog: RunCatalog, currentFile: CurrentFileRun | undefined, hasActiveFile: boolean, available = true): RunConfigurationOption[] {
  const plan = currentFile?.configuration;
  const current: RunConfigurationOption = {
    id: CURRENT_FILE_OPTION, kind: "current-file", label: "Run current file",
    triggerLabel: plan ? plan.name : "Current file",
    detail: plan ? commandLine(plan) : !available ? "Running files requires the desktop app." : !hasActiveFile ? "Open a file to run it." : currentFile?.reason || "Checking for a runner...",
    disabled: !plan,
  };
  return [
    current,
    ...catalog.configurations.map(value => ({ id: value.id, kind: "saved" as const, label: value.name, detail: commandLine(value) })),
    ...catalog.detected.map(task => ({ id: task.configuration.id, kind: "detected" as const, label: task.configuration.name, detail: commandLine(task.configuration), source: task.source })),
  ];
}

/** Current file first, saved configurations next, then one group per detected manifest in catalog order. */
export function groupRunOptions(options: readonly RunConfigurationOption[]): RunOptionGroup[] {
  const groups: RunOptionGroup[] = [];
  const current = options.filter(option => option.kind === "current-file");
  if (current.length) groups.push({ key: "current-file", auto: false, options: current });
  const saved = options.filter(option => option.kind === "saved");
  if (saved.length) groups.push({ key: "saved", heading: "Saved configurations", auto: false, options: saved });
  for (const option of options.filter(option => option.kind === "detected")) {
    const source = option.source || "project files"; const key = `detected:${source}`;
    const group = groups.find(value => value.key === key);
    if (group) group.options.push(option); else groups.push({ key, heading: detectedHeading(source), auto: true, options: [option] });
  }
  return groups;
}
