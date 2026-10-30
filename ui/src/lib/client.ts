import type { ExplorerLegacyPreferences_Deserialize, ExplorerPreferenceMigration_Serialize, GitContext, GitStatus, GitDiff, GitDiffSide, GitHistoryPage, GitHistoryQuery, GitCommitResult } from '../bindings';
import type { RunConfiguration_Serialize as RunConfiguration, RunCatalog_Serialize as RunCatalog, RunInfo_Serialize as RunInfo, RunContext_Serialize as RunContext, RunOutput, RunEvent_Deserialize as RunEvent, RunApprovalRequest, CurrentFileRun_Serialize as CurrentFileRun } from '../bindings';
import { open } from '@tauri-apps/plugin-dialog';
import { Channel } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { commands, events } from '../bindings';
import type { TerminalEvent_Deserialize as TerminalEvent, TerminalInfo, TerminalCommandLanguage, TerminalProfile } from '../bindings';
import type { LspPort } from './lsp-client';
import type { BootTheme, StartupTimings } from './startup';
import { previewAssetFiles, previewAssetImage } from './preview-assets';
import type { NavigationPort } from './lsp-navigation';
import { createPreviewNavigationPort, previewNavigationFiles } from './navigation-preview';
import { previewHover, previewHoverFiles } from './hover-preview';
import { createHubPreview } from './hub-preview';
import type { HubPort } from './hub-port';
import { fileResults } from './navigation';
import { createPreviewSettings } from './preview-settings';
import type { AgentHealth_Serialize as AgentHealth, AuthError, PromptError_Serialize as PromptError, SessionStates_Serialize as SessionStates, ThreadPermissionMode } from '../bindings';
import type { AgentCommand, AgentEvent, BufferRevision, BufferSnapshot, FileEntry, FileProbe, FileIndexStatus, FileIndexQueryResponse, FormatWarning, ImageSource, InstalledAgent, NativeAction, NativeWindowState, RecentProject_Serialize as RecentProject, PromptAttachment, SavedAttachment, RegistryAgent, SearchMatch, SessionState_Serialize as SessionState, SessionSummary, Settings_Serialize as Settings, SettingsScope, StartupRequest_Serialize as StartupRequest, SyntaxSnapshot, TextEdit, ToolInfo_Serialize as ToolInfo, Workspace } from '../bindings';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const previewNotice = 'Browser preview, sample files are held in memory. Open the desktop app for native folders, saving and agents.';

function nativeRequired(action: string): never {
  throw new Error(`${action} requires the span desktop app. This browser shows a sample workspace.`);
}

// This fixture exists only in browser preview. Native commands always use Rust workspace state.
const fixture: Record<string, string> = {
  ...previewAssetFiles,
  ...previewNavigationFiles,
  ...previewHoverFiles,
  '.env.local': 'SPAN_ENV=preview\nPORT=1420\nSPAN_SAMPLE_ONLY=true\n',
  'community/platform/node-rpc-client/src/rpc-node.ts': `import { JsonRpc } from './rpc';
import { SocketTransport } from './socket-transport';
import type { ConnectionOptions } from './types';

export class NodeRpcClient {
  private readonly rpc: JsonRpc;
  private readonly transport: SocketTransport;

  constructor(options: ConnectionOptions) {
    this.transport = new SocketTransport(options);
    this.rpc = new JsonRpc(this.transport);
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    this.rpc.start();
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return this.rpc.request<T>(method, params);
  }

  dispose(): void {
    this.rpc.dispose();
    this.transport.close();
  }
}
`,
  'community/platform/node-rpc-client/src/rpc.ts': 'export class JsonRpc {\n  constructor(private transport: unknown) {}\n  start() {}\n  dispose() {}\n}\n',
  'community/platform/node-rpc-client/src/socket-transport.ts': 'export class SocketTransport {\n  async connect() {}\n  close() {}\n}\n',
  'community/platform/node-rpc-client/package.json': '{\n  "name": "@platform/node-rpc-client",\n  "private": true\n}\n',
  'README.md': '# span\n\nA focused space for code and agents.\n\nThis is the browser preview workspace. Open the desktop app to edit your own files.\n',
  'src/App.tsx': `import { createSignal } from 'solid-js';
import { Editor } from './components/Editor';
import './styles.css';

export default function App() {
  const [activeFile, setActiveFile] = createSignal('welcome.ts');

  return (
    <main class="workspace">
      <header class="workspace-header">
        <span class="wordmark">span</span>
        <span class="workspace-name">A space for your next idea</span>
      </header>
      <Editor path={activeFile()} onSelect={setActiveFile} />
    </main>
  );
}
`,
  'src/components/Editor.tsx': `import { createSignal } from 'solid-js';

type EditorProps = {
  path: string;
  onSelect: (path: string) => void;
};

export function Editor(props: EditorProps) {
  const [ready] = createSignal(true);

  return (
    <section class="editor" data-ready={ready()}>
      <h1>{props.path}</h1>
      <p>Good ideas need room to grow.</p>
    </section>
  );
}
`,
  'src/styles.css': ':root {\n  color-scheme: dark;\n  font-family: Inter, sans-serif;\n  background: #101113;\n  color: #d9dadd;\n}\n\n.workspace {\n  display: grid;\n  min-height: 100vh;\n}\n',
  'package.json': '{\n  "name": "span-workspace",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "strict": true,\n    "jsx": "preserve"\n  }\n}\n',
};

const buffers = new Map<string, BufferSnapshot>();
const previewSettings = createPreviewSettings();
let previewSession: SessionState | null = null;
const previewWorkspace: Workspace = { name: 'intellij', root: '/preview/intellij' };
const agentListeners = new Set<(event: AgentEvent) => void>();
let agentGeneration = 0;
/**
 * The connect generation whose channel reaches the agent listeners. A failed connect hands it back to the channel
 * before it, because the backend keeps the old connection when a switch fails (issue #87).
 */
let liveChannel = 0;
/** A disconnect or a new folder: no channel delivers until the next connect. */
const supersedeAgent = () => {
  liveChannel = ++agentGeneration;
};
let searchSequence = 0;

function language(path: string): string {
  const extension = path.split('.').pop();
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'jsx') return 'javascript';
  if (extension === 'json' || extension === 'jsonc') return 'json';
  if (extension === 'md') return 'markdown';
  if (extension === 'rs') return 'rust';
  if (extension === 'py') return 'python';
  return 'text';
}

function previewBuffer(path: string): BufferSnapshot {
  let buffer = buffers.get(path);
  if (!buffer) {
    if (!(path in fixture)) throw new Error(`Sample file does not exist: ${path}`);
    buffer = { path, text: fixture[path], revision: 0, savedRevision: 0, language: language(path) };
    buffers.set(path, buffer);
  }
  return { ...buffer };
}

/** The browser fixture has no repository ignore rules; hidden-file settings still
 * exercise the same listing, finder and search preference in the preview. */
function previewFilePaths(): string[] {
  const showHidden = previewSettings.get().explorer?.showHiddenFiles ?? true;
  return Object.keys(fixture).filter(path => showHidden || !path.split('/').some(part => part.startsWith('.'))).sort();
}

function previewEntries(path: string): FileEntry[] {
  const prefix = path.replace(/^\/preview\/intellij\/?/, '').replace(/\/$/, '');
  const directory = prefix ? `${prefix}/` : '';
  const entries = new Map<string, FileEntry>();
  for (const file of previewFilePaths()) {
    if (!file.startsWith(directory)) continue;
    const relative = file.slice(directory.length);
    const name = relative.split('/')[0];
    const entryPath = `${directory}${name}`;
    entries.set(entryPath, { path: entryPath, name, isDir: relative.includes('/') });
  }
  return [...entries.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

export const api = {
  async gitAmend(...args: Parameters<typeof commands.gitAmend>) {
    if (!isDesktop) nativeRequired('Amending a Git commit');
    return commands.gitAmend(...args);
  },
  async gitOpenWorktreeWindow(...args: Parameters<typeof commands.gitOpenWorktreeWindow>) {
    if (!isDesktop) nativeRequired('Opening a worktree window');
    return commands.gitOpenWorktreeWindow(...args);
  },
  async gitRemoteSelected(...args: Parameters<typeof commands.gitRemoteSelected>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitRemoteSelected(...args);
  },
  async gitWorktreeWindowPath(...args: Parameters<typeof commands.gitWorktreeWindowPath>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitWorktreeWindowPath(...args);
  },
  async gitHistoryTools(...args: Parameters<typeof commands.gitHistoryTools>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitHistoryTools(...args);
  },
  async gitRevisionContent(...args: Parameters<typeof commands.gitRevisionContent>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitRevisionContent(...args);
  },
  async gitRevisionDiff(...args: Parameters<typeof commands.gitRevisionDiff>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitRevisionDiff(...args);
  },
  async gitReflogPage(...args: Parameters<typeof commands.gitReflogPage>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitReflogPage(...args);
  },
  async gitLineHistory(...args: Parameters<typeof commands.gitLineHistory>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitLineHistory(...args);
  },
  async gitSigningConfiguration(...args: Parameters<typeof commands.gitSigningConfiguration>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitSigningConfiguration(...args);
  },
  async gitReviewLines(...args: Parameters<typeof commands.gitReviewLines>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitReviewLines(...args);
  },
  async gitApplyLines(...args: Parameters<typeof commands.gitApplyLines>) {
    if (!isDesktop) nativeRequired('Using native Git workflows');
    return commands.gitApplyLines(...args);
  },
  async gitCheckoutPullRequest(...args: Parameters<typeof commands.gitCheckoutPullRequest>) {
    if (!isDesktop) nativeRequired('Checking out a pull request');
    return commands.gitCheckoutPullRequest(...args);
  },
  async gitInitializeRepository(...args: Parameters<typeof commands.gitInitializeRepository>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitInitializeRepository(...args);
  },
  async gitCloneRepository(...args: Parameters<typeof commands.gitCloneRepository>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitCloneRepository(...args);
  },
  async gitConfigureRemote(...args: Parameters<typeof commands.gitConfigureRemote>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitConfigureRemote(...args);
  },
  async gitManageBranch(...args: Parameters<typeof commands.gitManageBranch>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitManageBranch(...args);
  },
  async gitFetchBackground(...args: Parameters<typeof commands.gitFetchBackground>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitFetchBackground(...args);
  },
  async gitWorktreePruneReview(...args: Parameters<typeof commands.gitWorktreePruneReview>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitWorktreePruneReview(...args);
  },
  async gitWorktreePrune(...args: Parameters<typeof commands.gitWorktreePrune>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitWorktreePrune(...args);
  },
  async gitWorktreeSetLocked(...args: Parameters<typeof commands.gitWorktreeSetLocked>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitWorktreeSetLocked(...args);
  },
  async gitWorktreeCreate(...args: Parameters<typeof commands.gitWorktreeCreate>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitWorktreeCreate(...args);
  },
  async gitIntegrationStart(...args: Parameters<typeof commands.gitIntegrationStart>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitIntegrationStart(...args);
  },
  async gitIntegrationControl(...args: Parameters<typeof commands.gitIntegrationControl>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitIntegrationControl(...args);
  },
  async gitConflictResource(...args: Parameters<typeof commands.gitConflictResource>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitConflictResource(...args);
  },
  async gitSaveConflictResolution(...args: Parameters<typeof commands.gitSaveConflictResolution>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.gitSaveConflictResolution(...args);
  },
  async githubRepositories(...args: Parameters<typeof commands.githubRepositories>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.githubRepositories(...args);
  },
  async githubStatus(...args: Parameters<typeof commands.githubStatus>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.githubStatus(...args);
  },
  async githubRead(...args: Parameters<typeof commands.githubRead>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.githubRead(...args);
  },
  async githubCreatePullRequest(...args: Parameters<typeof commands.githubCreatePullRequest>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.githubCreatePullRequest(...args);
  },
  async githubReviewPullRequest(...args: Parameters<typeof commands.githubReviewPullRequest>) {
    if (!isDesktop) nativeRequired('Using native Git integration');
    return commands.githubReviewPullRequest(...args);
  },
  async gitContext(): Promise<GitContext> {
    if (!isDesktop) nativeRequired('Reading Git repositories');
    return commands.gitContext();
  },
  async gitEnable(context: GitContext): Promise<GitStatus> {
    if (!isDesktop) nativeRequired('Enabling Git');
    return commands.gitEnable(context);
  },
  async gitStatus(context: GitContext): Promise<GitStatus> {
    if (!isDesktop) nativeRequired('Reading Git status');
    return commands.gitStatus(context);
  },
  async gitDiff(context: GitContext, path: string, side: GitDiffSide, expectedIndexRevision: string): Promise<GitDiff> {
    if (!isDesktop) nativeRequired('Reading Git differences');
    return commands.gitDiff(context, path, side, expectedIndexRevision);
  },
  async gitHistory(context: GitContext, query: GitHistoryQuery): Promise<GitHistoryPage> {
    if (!isDesktop) nativeRequired('Reading Git history');
    return commands.gitHistory(context, query);
  },
  async gitCommitDiff(context: GitContext, commitId: string, path: string | null): Promise<GitDiff> {
    if (!isDesktop) nativeRequired('Reading Git commit differences');
    return commands.gitCommitDiff(context, commitId, path);
  },
  async gitStage(context: GitContext, paths: string[], expectedIndexRevision: string): Promise<GitStatus> {
    if (!isDesktop) nativeRequired('Staging Git changes');
    return commands.gitStage(context, paths, expectedIndexRevision);
  },
  async gitUnstage(context: GitContext, paths: string[], expectedIndexRevision: string): Promise<GitStatus> {
    if (!isDesktop) nativeRequired('Unstaging Git changes');
    return commands.gitUnstage(context, paths, expectedIndexRevision);
  },
  async gitCommit(context: GitContext, message: string, expectedIndexRevision: string, expectedStagedSnapshot: string): Promise<GitCommitResult> {
    if (!isDesktop) nativeRequired('Creating Git commits');
    return commands.gitCommit(context, message, expectedIndexRevision, expectedStagedSnapshot);
  },

  async gitFileBaseline(...args: Parameters<typeof commands.gitFileBaseline>) {
    if (!isDesktop) nativeRequired('Reading Git file baselines');
    return commands.gitFileBaseline(...args);
  },
  async gitBlame(...args: Parameters<typeof commands.gitBlame>) {
    if (!isDesktop) nativeRequired('Reading Git blame');
    return commands.gitBlame(...args);
  },
  async gitBranches(...args: Parameters<typeof commands.gitBranches>) {
    if (!isDesktop) nativeRequired('Reading Git branches');
    return commands.gitBranches(...args);
  },
  async gitCheckout(...args: Parameters<typeof commands.gitCheckout>) {
    if (!isDesktop) nativeRequired('Switching Git branches');
    return commands.gitCheckout(...args);
  },
  async gitRemote(...args: Parameters<typeof commands.gitRemote>) {
    if (!isDesktop) nativeRequired('Running Git remote operations');
    return commands.gitRemote(...args);
  },
  async gitStashes(...args: Parameters<typeof commands.gitStashes>) {
    if (!isDesktop) nativeRequired('Reading Git stashes');
    return commands.gitStashes(...args);
  },
  async gitStash(...args: Parameters<typeof commands.gitStash>) {
    if (!isDesktop) nativeRequired('Updating Git stashes');
    return commands.gitStash(...args);
  },
  async gitWorktrees(...args: Parameters<typeof commands.gitWorktrees>) {
    if (!isDesktop) nativeRequired('Reading Git worktrees');
    return commands.gitWorktrees(...args);
  },
  async gitWorktreeAdd(...args: Parameters<typeof commands.gitWorktreeAdd>) {
    if (!isDesktop) nativeRequired('Creating Git worktrees');
    return commands.gitWorktreeAdd(...args);
  },
  async gitWorktreeRemove(...args: Parameters<typeof commands.gitWorktreeRemove>) {
    if (!isDesktop) nativeRequired('Removing Git worktrees');
    return commands.gitWorktreeRemove(...args);
  },
  async gitCommitDetails(...args: Parameters<typeof commands.gitCommitDetails>) {
    if (!isDesktop) nativeRequired('Reading Git commit details');
    return commands.gitCommitDetails(...args);
  },

  async gitHunkDiff(...args: Parameters<typeof commands.gitHunkDiff>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitHunkDiff(...args);
  },
  async gitApplyHunk(...args: Parameters<typeof commands.gitApplyHunk>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitApplyHunk(...args);
  },
  async gitTags(...args: Parameters<typeof commands.gitTags>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitTags(...args);
  },
  async gitCreateTag(...args: Parameters<typeof commands.gitCreateTag>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitCreateTag(...args);
  },
  async gitDeleteTag(...args: Parameters<typeof commands.gitDeleteTag>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitDeleteTag(...args);
  },
  async gitMergeFastForward(...args: Parameters<typeof commands.gitMergeFastForward>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitMergeFastForward(...args);
  },

  async gitIntegrationState(...args: Parameters<typeof commands.gitIntegrationState>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitIntegrationState(...args);
  },
  async gitRebase(...args: Parameters<typeof commands.gitRebase>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitRebase(...args);
  },
  async gitRebaseControl(...args: Parameters<typeof commands.gitRebaseControl>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitRebaseControl(...args);
  },
  async gitMarkResolved(...args: Parameters<typeof commands.gitMarkResolved>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitMarkResolved(...args);
  },
  async gitRemotes(...args: Parameters<typeof commands.gitRemotes>) {
    if (!isDesktop) nativeRequired('Git repository operations');
    return commands.gitRemotes(...args);
  },

  async gitDiscardFile(...args: Parameters<typeof commands.gitDiscardFile>) {
    if (!isDesktop) nativeRequired('Discarding Git working changes');
    return commands.gitDiscardFile(...args);
  },

  // Interactive terminal commands always use the native PTY backend.
  async terminalCreate(cwd: string | null, cols: number, rows: number, onEvent: Channel<TerminalEvent>, profileId?: string): Promise<TerminalInfo> {
    if (!isDesktop) nativeRequired('Creating terminal sessions');
    return commands.terminalCreate(cwd, cols, rows, onEvent, profileId ?? null);
  },
  async terminalCreateCommand(language: TerminalCommandLanguage, code: string, expectedWorkspaceRoot: string, cols: number, rows: number, onEvent: Channel<TerminalEvent>): Promise<TerminalInfo> {
    if (!isDesktop) nativeRequired('Running terminal commands');
    return commands.terminalCreateCommand(language, code, expectedWorkspaceRoot, cols, rows, onEvent);
  },
  async terminalProfiles(): Promise<TerminalProfile[]> {
    if (!isDesktop) nativeRequired('Discovering terminal shells');
    return commands.terminalProfiles();
  },
  async terminalWrite(id: string, data: Uint8Array): Promise<void> {
    if (!isDesktop) nativeRequired('Writing terminal input');
    await commands.terminalWrite(id, Array.from(data));
  },
  async terminalResize(id: string, cols: number, rows: number): Promise<void> {
    if (!isDesktop) nativeRequired('Resizing terminal sessions');
    await commands.terminalResize(id, cols, rows);
  },
  async terminalInterrupt(id: string): Promise<void> {
    if (!isDesktop) nativeRequired('Interrupting terminal commands');
    await commands.terminalInterrupt(id);
  },
  async terminalClose(id: string): Promise<void> {
    if (!isDesktop) nativeRequired('Closing terminal sessions');
    await commands.terminalClose(id);
  },
  async terminalAcknowledge(id: string, sequence: number): Promise<void> {
    if (!isDesktop) nativeRequired('Acknowledging terminal output');
    await commands.terminalAcknowledge(id, sequence);
  },
  async runConfigurations(): Promise<RunCatalog> { if (!isDesktop) nativeRequired('Loading run configurations'); return commands.runConfigurations(); },
  async saveRunConfiguration(configuration: RunConfiguration, expectedWorkspaceRoot: string): Promise<RunConfiguration> { if (!isDesktop) nativeRequired('Saving run configurations'); return commands.saveRunConfiguration(configuration, expectedWorkspaceRoot); },
  async deleteRunConfiguration(id: string, expectedWorkspaceRoot: string): Promise<void> { if (!isDesktop) nativeRequired('Deleting run configurations'); await commands.deleteRunConfiguration(id, expectedWorkspaceRoot); },
  async duplicateRunConfiguration(id: string, expectedWorkspaceRoot: string): Promise<RunConfiguration> { if (!isDesktop) nativeRequired('Duplicating run configurations'); return commands.duplicateRunConfiguration(id, expectedWorkspaceRoot); },
  async startRun(configuration: RunConfiguration, expectedWorkspaceRoot: string, listener: (event: RunEvent) => void): Promise<RunInfo> { if (!isDesktop) nativeRequired('Running configurations'); const channel = new Channel<RunEvent>(); channel.onmessage = listener; return commands.startRun(configuration, expectedWorkspaceRoot, channel); },
  async stopRun(id: string): Promise<RunInfo> { if (!isDesktop) nativeRequired('Stopping processes'); return commands.stopRun(id); },
  async currentFileRun(path: string, expectedWorkspaceRoot: string): Promise<CurrentFileRun> { if (!isDesktop) nativeRequired('Choosing a runner for the current file'); return commands.currentFileRun(path, expectedWorkspaceRoot); },
  async startCurrentFileRun(path: string, expectedWorkspaceRoot: string, listener: (event: RunEvent) => void): Promise<RunInfo> { if (!isDesktop) nativeRequired('Running the current file'); const channel = new Channel<RunEvent>(); channel.onmessage = listener; return commands.startCurrentFileRun(path, expectedWorkspaceRoot, channel); },
  async restartRun(id: string, listener: (event: RunEvent) => void): Promise<RunInfo> { if (!isDesktop) nativeRequired('Restarting processes'); const channel = new Channel<RunEvent>(); channel.onmessage = listener; return commands.restartRun(id, channel); },
  async runContext(): Promise<RunContext> { if (!isDesktop) nativeRequired('Reading run workspace context'); return commands.runContext(); },
  async listRuns(): Promise<RunInfo[]> { if (!isDesktop) nativeRequired('Listing process runs'); return commands.listRuns(); },
  async runOutput(id: string): Promise<RunOutput> { if (!isDesktop) nativeRequired('Reading run output'); return commands.runOutput(id); },
  async acknowledgeRun(id: string, sequence: number): Promise<void> { if (!isDesktop) nativeRequired('Acknowledging run output'); await commands.acknowledgeRun(id, sequence); },
  async onRunEvent(listener: (event: RunEvent) => void): Promise<() => void> { if (!isDesktop) return () => {}; return events.runEvent.listen(event => listener(event.payload)); },
  async pendingRunApprovals(): Promise<RunApprovalRequest[]> { if (!isDesktop) nativeRequired('Reading agent run requests'); return commands.pendingRunApprovals(); },
  async resolveRunApproval(id: string, allow: boolean): Promise<void> { if (!isDesktop) nativeRequired('Answering agent run requests'); await commands.resolveRunApproval(id, allow); },
  async onRunApprovalsChanged(listener: (requests: RunApprovalRequest[]) => void): Promise<() => void> { if (!isDesktop) return () => {}; return events.runApprovalsChanged.listen(event => listener(event.payload.pending)); },
  async runToolsEnabled(): Promise<boolean> { if (!isDesktop) nativeRequired('Reading agent run tools preference'); return commands.runToolsEnabled(); },
  async runToolsSetEnabled(enabled: boolean): Promise<void> { if (!isDesktop) nativeRequired('Changing agent run tools preference'); await commands.runToolsSetEnabled(enabled); },
  async pickFile(): Promise<string | null> {
    if (!isDesktop) nativeRequired('Opening files');
    const selected = await open({ directory: false, multiple: false, title: 'Open a file in span' });
    return typeof selected === 'string' ? selected : null;
  },
  /** Folder picker for attaching a folder outline, starting in `defaultPath` (normally the workspace root). */
  async pickFolder(defaultPath?: string): Promise<string | null> {
    if (!isDesktop) nativeRequired('Picking folders');
    const selected = await open({ directory: true, multiple: false, defaultPath, title: 'Attach a folder from this workspace' });
    return typeof selected === 'string' ? selected : null;
  },
  async openWorkspace(path?: string): Promise<Workspace | null> {
    if (!isDesktop) {
      if (path && path !== previewWorkspace.root) nativeRequired('Opening folders');
      return { ...previewWorkspace };
    }
    const selected = path ?? await open({ directory: true, multiple: false, title: 'Open a folder in span' });
    if (!selected || Array.isArray(selected)) return null;
    const workspace = await commands.openWorkspace(selected);
    supersedeAgent();
    return workspace;
  },
  async listDirectory(path: string): Promise<FileEntry[]> {
    return isDesktop ? commands.listDirectory(path) : previewEntries(path);
  },
  async listFiles(): Promise<FileEntry[]> {
    return isDesktop ? commands.listFiles() : previewFilePaths().map(path => ({ path, name: path.split('/').pop() ?? path, isDir: false }));
  },
  async fileIndexStatus(): Promise<FileIndexStatus | null> {
    if (isDesktop) return commands.fileIndexStatus();
    return { workspaceRoot: previewWorkspace.root, generation: 1, status: 'ready', scannedEntries: previewFilePaths().length, indexedFiles: previewFilePaths().length, errorCount: 0, lastError: null, watcherReady: false, watcherError: null };
  },
  async checkExternalFiles(checks: import('../bindings').ExternalFileCheck[], expectedWorkspaceRoot: string, sinceRevision: number | null): Promise<import('../bindings').ExternalFilesUpdate> {
    if (!isDesktop) nativeRequired('Checking external file changes');
    return commands.checkExternalFiles(checks, expectedWorkspaceRoot, sinceRevision);
  },
  async resolveExternalFile(path: string, expectedRevision: number, reviewedDiskToken: string, resolution: import('../bindings').ExternalFileResolution, expectedWorkspaceRoot: string): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Resolving external file changes');
    return commands.resolveExternalFile(path, expectedRevision, reviewedDiskToken, resolution, expectedWorkspaceRoot);
  },
  async abandonExternalFile(path: string, expectedRevision: number, expectedWorkspaceRoot: string): Promise<void> {
    if (!isDesktop) nativeRequired('Discarding an unavailable editor buffer');
    await commands.abandonExternalFile(path, expectedRevision, expectedWorkspaceRoot);
  },
  async queryFile(query: string, limit = 100): Promise<FileIndexQueryResponse> {
    if (isDesktop) return commands.queryFile(query, Math.max(1, Math.min(100, limit)));
    const files = previewFilePaths().map(path => ({ path, name: path.split('/').pop() ?? path, isDir: false }));
    return { workspaceRoot: previewWorkspace.root, generation: 1, requestId: 0, results: fileResults(files, query).slice(0, limit).map(file => ({ path: file.path, score: 0 })) };
  },
  async openBuffer(path: string): Promise<BufferSnapshot> {
    return isDesktop ? commands.openBuffer(path) : previewBuffer(path);
  },
  /** Reads a file for a preview. Opens no buffer and never starts a language server. */
  async peekBuffer(path: string): Promise<BufferSnapshot> {
    return isDesktop ? commands.peekBuffer(path) : previewBuffer(path);
  },
  /** Name, size and text or binary kind of a workspace file. Browser preview files are all text. */
  async probeFile(path: string): Promise<FileProbe> {
    if (isDesktop) return commands.probeFile(path);
    return { path, name: path.split('/').pop() || path, size: 0, kind: 'text' };
  },
  /** Raw bytes of a workspace file for the file viewer. Refused above `maxBytes`, never truncated. */
  async readFileBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    if (!isDesktop) nativeRequired('Reading binary files');
    const encoded = await commands.readFileBytes(path, Math.max(0, Math.min(maxBytes, 0xffffffff)));
    return Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  },
  /** Opens a workspace file with the system default app. Rust refuses programs and scripts. */
  async openFileWithSystem(path: string): Promise<void> {
    if (!isDesktop) nativeRequired('Opening files with the default app');
    await commands.openFileWithSystem(path);
  },
  /** Shows a workspace file in Finder, Explorer or the file manager. */
  async revealFile(path: string): Promise<void> {
    if (!isDesktop) nativeRequired('Revealing files');
    await commands.revealFile(path);
  },
  /** The last editor showing `path` closed: language servers may drop the document. */
  async releaseBuffer(path: string): Promise<void> {
    if (isDesktop) await commands.bufferReleased(path);
  },
  async editBuffer(path: string, expectedRevision: number, changes: TextEdit[]): Promise<BufferRevision> {
    if (isDesktop) return commands.editBufferDelta(path, expectedRevision, changes);
    const buffer = previewBuffer(path);
    if (buffer.revision !== expectedRevision) throw new Error(`Expected revision ${expectedRevision}, current revision is ${buffer.revision}`);
    let end = 0;
    for (const change of changes) {
      if (change.from < end || change.from > change.to || change.to > buffer.text.length) throw new Error('Invalid sample buffer edit');
      end = change.to;
    }
    for (const change of [...changes].reverse()) buffer.text = buffer.text.slice(0, change.from) + change.insert + buffer.text.slice(change.to);
    if (changes.length) buffer.revision += 1;
    if (buffer.text === fixture[path]) buffer.savedRevision = buffer.revision;
    buffers.set(path, buffer);
    return { path, revision: buffer.revision, savedRevision: buffer.savedRevision };
  },
  async saveBuffer(path: string, expectedRevision: number): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Saving files');
    return commands.saveBuffer(path, expectedRevision);
  },
  async discardBuffer(path: string): Promise<BufferSnapshot> {
    if (isDesktop) return commands.discardBuffer(path);
    const buffer = previewBuffer(path);
    buffer.text = fixture[path];
    buffer.revision += 1;
    buffer.savedRevision = buffer.revision;
    buffers.set(path, buffer);
    return { ...buffer };
  },
  async search(query: string): Promise<SearchMatch[]> {
    if (isDesktop) return commands.search({ text: query, isRegex: false, caseSensitive: false, maxResults: 1000 });
    if (!query) return [];
    const results: SearchMatch[] = [];
    for (const path of previewFilePaths()) {
      previewBuffer(path).text.split('\n').forEach((text, index) => {
        const column = text.toLowerCase().indexOf(query.toLowerCase());
        if (column >= 0) results.push({ path, line: index + 1, column: column + 1, text });
      });
    }
    return results;
  },
  searchStream(query: string, onMatch: (match: SearchMatch) => void): { done: Promise<number>; cancel: () => Promise<void> } {
    const id = `search-${++searchSequence}`;
    if (isDesktop) {
      const channel = new Channel<SearchMatch>();
      channel.onmessage = onMatch;
      return {
        done: commands.searchStream(id, { text: query, isRegex: false, caseSensitive: false, maxResults: 1000 }, channel),
        cancel: async () => { await commands.cancelSearch(id); },
      };
    }
    let cancelled = false;
    return {
      done: api.search(query).then(matches => {
        if (cancelled) return 0;
        for (const match of matches) onMatch(match);
        return matches.length;
      }),
      cancel: async () => { cancelled = true; },
    };
  },
  async migrateExplorerPreferences(expectedWorkspaceRoot: string, legacy: ExplorerLegacyPreferences_Deserialize): Promise<ExplorerPreferenceMigration_Serialize> {
    if (!isDesktop) nativeRequired('Migrating Explorer preferences');
    return commands.migrateExplorerPreferences(expectedWorkspaceRoot, legacy);
  },
  async getSettingsForScope(scope: SettingsScope): Promise<Settings> {
    return isDesktop ? commands.getSettingsForScope(scope) : previewSettings.get(scope);
  },
  async getSettingsJsoncForScope(scope: SettingsScope): Promise<string> {
    return isDesktop ? commands.getSettingsJsoncForScope(scope) : previewSettings.raw(scope);
  },
  async getSettingsKeysForScope(scope: SettingsScope): Promise<string[]> {
    return isDesktop ? commands.getSettingsKeysForScope(scope) : previewSettings.keys(scope);
  },
  async updateSettingsJsoncForScope(scope: SettingsScope, text: string): Promise<Settings> {
    if (!isDesktop) return previewSettings.updateJsonc(scope, text);
    return commands.updateSettingsJsoncForScope(scope, text);
  },
  async updateSetting(scope: SettingsScope, key: string, valueJson: string | null): Promise<Settings> {
    if (!isDesktop) return previewSettings.update(scope, key, valueJson);
    return commands.updateSetting(scope, key, valueJson);
  },
  async openSettingsBuffer(scope: SettingsScope): Promise<BufferSnapshot> {
    if (!isDesktop) return previewSettings.open(scope);
    return commands.openSettingsBuffer(scope);
  },
  async editSettingsBuffer(scope: SettingsScope, expectedRevision: number, changes: TextEdit[]): Promise<BufferRevision> {
    if (!isDesktop) return previewSettings.edit(scope, expectedRevision, changes);
    return commands.editSettingsBuffer(scope, expectedRevision, changes);
  },
  async saveSettingsBuffer(scope: SettingsScope, expectedRevision: number): Promise<BufferSnapshot> {
    if (!isDesktop) return previewSettings.save(scope, expectedRevision);
    return commands.saveSettingsBuffer(scope, expectedRevision);
  },
  async discardSettingsBuffer(scope: SettingsScope): Promise<BufferSnapshot> {
    if (!isDesktop) return previewSettings.discard(scope);
    return commands.discardSettingsBuffer(scope);
  },
  async newFile(path: string): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Creating files');
    return commands.newFile(path);
  },
  async newDirectory(path: string): Promise<FileEntry> {
    if (!isDesktop) nativeRequired('Creating folders');
    return commands.newDirectory(path);
  },
  async renamePath(from: string, to: string): Promise<FileEntry> {
    if (!isDesktop) nativeRequired('Renaming files');
    return commands.renamePath(from, to);
  },
  async duplicatePath(from: string, to: string): Promise<FileEntry> {
    if (!isDesktop) nativeRequired('Duplicating files');
    return commands.duplicatePath(from, to);
  },
  async trashPath(path: string): Promise<string[]> {
    if (!isDesktop) nativeRequired('Moving files to Trash');
    return commands.trashPath(path);
  },
  async enqueueDroppedPaths(paths: string[], cwd: string | null = null): Promise<void> {
    if (!isDesktop) nativeRequired('Opening dropped filesystem paths');
    await commands.enqueueDroppedPaths(paths, cwd);
  },
  async onOpenRequestError(listener: (message: string) => void): Promise<() => void> {
    return isDesktop ? events.startupRequestError.listen(event => listener(event.payload.message)) : () => undefined;
  },
  async onWindowFocus(listener: (focused: boolean) => void): Promise<() => void> {
    if (isDesktop) return getCurrentWindow().onFocusChanged(event => listener(event.payload));
    const focus = () => listener(true);
    const blur = () => listener(false);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  },
  async agentRemove(id: string, uninstall: boolean): Promise<void> {
    if (!isDesktop) nativeRequired('Removing installed agents');
    await commands.agentRemove(id, uninstall);
  },
  async getSettings(): Promise<Settings> {
    return isDesktop ? commands.getSettings() : previewSettings.get();
  },
  async getSettingsJsonc(): Promise<string> {
    return isDesktop ? commands.getSettingsJsonc() : previewSettings.raw('workspace');
  },
  async getSession(): Promise<SessionState | null> {
    return isDesktop ? commands.getSession() : previewSession;
  },
  async saveSession(session: SessionState): Promise<void> {
    if (isDesktop) await commands.saveSession(session);
    else previewSession = structuredClone(session);
  },
  async formatBuffer(path: string, expectedRevision: number, requestId: number): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Running document formatters');
    return commands.formatBuffer(path, expectedRevision, requestId);
  },
  async cancelFormatBuffer(path: string, requestId: number): Promise<void> {
    if (isDesktop) await commands.cancelFormatBuffer(path, requestId);
  },
  async openExternal(url: string): Promise<void> {
    if (isDesktop) { await commands.openExternal(url); return; }
    const parsed = new URL(url);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Only http, https and mailto links can open externally.');
    window.open(parsed.href, '_blank', 'noopener,noreferrer');
  },
  async readImage(path: string, expectedWorkspaceRoot?: string): Promise<ImageSource> {
    if (!isDesktop) { const image = previewAssetImage(path); if (image) return image; nativeRequired('Loading workspace images'); }
    return commands.readImage(path, expectedWorkspaceRoot ?? null);
  },
  /** Writes an attachment into the workspace without overwriting. Returns the workspace-relative path. */
  async saveAttachment(dir: string, fileName: string, dataBase64: string): Promise<SavedAttachment> {
    if (!isDesktop) nativeRequired('Saving attachments to the workspace');
    return commands.saveAttachment(dir, fileName, dataBase64);
  },
  async listTools(): Promise<ToolInfo[]> {
    if (!isDesktop) nativeRequired('Detecting installed tools');
    return commands.listTools();
  },
  async recentProjects(): Promise<RecentProject[]> {
    return isDesktop ? commands.recentProjects() : [];
  },
  async removeRecentProject(root: string): Promise<RecentProject[]> {
    return isDesktop ? commands.removeRecentProject(root) : [];
  },
  async clearRecentProjects(): Promise<void> {
    if (isDesktop) await commands.clearRecentProjects();
  },
  async readClipboard(): Promise<string> {
    if (isDesktop) return commands.readClipboard();
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.');
    return navigator.clipboard.readText();
  },
  async writeClipboard(text: string): Promise<void> {
    if (isDesktop) { await commands.writeClipboard(text); return; }
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.');
    await navigator.clipboard.writeText(text);
  },
  /** Shows the main window, which starts hidden, on the theme's canvas colour. */
  async showMainWindow(theme: BootTheme): Promise<void> {
    if (isDesktop) await commands.showMainWindow(theme === "light" ? "Light" : theme === "purple" ? "Purple" : "Dark");
  },
  async reportStartupTimings(timings: StartupTimings): Promise<void> {
    if (isDesktop) await commands.reportStartupTimings(timings);
  },
  async nativeWindowState(): Promise<NativeWindowState> {
    return isDesktop ? commands.nativeWindowState() : { fullscreen: false, maximized: false, hasNativeTrafficLights: false };
  },
  async isFullscreen(): Promise<boolean> {
    return (await api.nativeWindowState()).fullscreen;
  },
  async onWindowState(listener: (state: NativeWindowState) => void): Promise<() => void> {
    if (!isDesktop) return () => undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => { void commands.nativeWindowState().then(state => { if (active) listener(state); }).catch(() => undefined); };
    const unlisten = await getCurrentWindow().onResized(() => { if (timer) clearTimeout(timer); timer = setTimeout(update, 50); });
    update();
    return () => { active = false; if (timer) clearTimeout(timer); unlisten(); };
  },
  async takeStartupRequests(): Promise<StartupRequest[]> {
    return isDesktop ? commands.takeStartupRequests() : [];
  },
  async onOpenWorkspaceRequested(listener: (request: StartupRequest) => void | Promise<void>): Promise<() => void> {
    if (!isDesktop) return () => undefined;
    let active = true;
    let draining = false;
    let pending = false;
    const drain = async () => {
      pending = true;
      if (draining) return;
      draining = true;
      try {
        while (active && pending) {
          pending = false;
          const requests = await commands.takeStartupRequests();
          for (const request of requests) { if (active) await listener(request); }
        }
      } finally { draining = false; }
    };
    const unlisten = await events.startupRequestsChanged.listen(() => { void drain().catch(error => console.error('Could not handle an open request:', error)); });
    await drain();
    return () => { active = false; unlisten(); };
  },
  async syncNativeMenu(bindings: Record<string, string[]>): Promise<string[]> {
    return isDesktop ? commands.syncNativeMenu(bindings) : [];
  },
  async onNativeAction(listener: (action: NativeAction) => void): Promise<() => void> {
    return isDesktop ? events.nativeActionEvent.listen(event => listener(event.payload.action)) : () => undefined;
  },
  async onFormatWarning(listener: (warning: FormatWarning) => void): Promise<() => void> {
    return isDesktop ? events.formatWarning.listen(event => listener(event.payload)) : () => undefined;
  },
  async updateSettings(settings: Settings): Promise<Settings> {
    if (isDesktop) return commands.updateSettings(settings);
    return previewSettings.updateJsonc('workspace', JSON.stringify(settings, null, 2));
  },
  async updateSettingsJsonc(text: string): Promise<Settings> {
    if (!isDesktop) return previewSettings.updateJsonc('workspace', text);
    return commands.updateSettingsJsonc(text);
  },
  async syntax(path: string): Promise<SyntaxSnapshot> {
    if (!isDesktop) nativeRequired('Tree-sitter syntax analysis');
    return commands.syntax(path);
  },
  async agentRegistry(): Promise<RegistryAgent[]> {
    if (!isDesktop) nativeRequired('Agent registry discovery');
    return commands.agentRegistry();
  },
  async agentInstalled(): Promise<InstalledAgent[]> {
    if (!isDesktop) nativeRequired('Listing installed agents');
    return commands.agentInstalled();
  },
  /** Warm start (ADR 0009): the backend starts installed agents in the background, `recent` ids first. Resolves at once with how many it queued; 0 when `agents.warmStart` is off. */
  async agentWarmStart(recent: string[]): Promise<number> {
    if (!isDesktop) return 0;
    return commands.agentWarmStart(recent);
  },
  /** Agent health check (ADR 0010): the latest result per running agent, empty while `agents.healthCheck` is off. The first call starts the periodic checks, so call it after the window is shown. */
  async agentHealth(): Promise<AgentHealth[]> {
    if (!isDesktop) return [];
    return commands.agentHealth();
  },
  /** Every health result, sent whole whenever one changes. */
  async onAgentHealth(listener: (agents: AgentHealth[]) => void): Promise<() => void> {
    return isDesktop ? events.agentHealthChanged.listen(event => listener(event.payload.agents)) : () => undefined;
  },
  async agentInstall(id: string): Promise<InstalledAgent> {
    if (!isDesktop) nativeRequired('Installing agents');
    return commands.agentInstall(id);
  },
  async agentConnect(command: AgentCommand, cwd: string): Promise<string> {
    if (!isDesktop) nativeRequired('Connecting agents');
    const previous = liveChannel;
    const generation = ++agentGeneration;
    liveChannel = generation;
    const channel = new Channel<AgentEvent>();
    channel.onmessage = event => {
      if (generation !== liveChannel) return;
      for (const listener of agentListeners) listener(event);
    };
    let session: string;
    try {
      session = await commands.agentConnect(command, cwd, channel);
    } catch (cause) {
      // The backend connects the new agent before it closes the old one, so a failed connect leaves the old one active.
      if (generation === agentGeneration) liveChannel = previous;
      throw cause;
    }
    if (generation !== agentGeneration) throw new Error('Agent connection was superseded by another connection or disconnect.');
    return session;
  },
  /**
   * Runs a prompt in the active session. A refusal is thrown as an Error whose `prompt` field is the typed
   * `PromptError` (`kind` busy or failed), so callers match the kind and never the message text.
   */
  async agentPrompt(text: string, attachments: PromptAttachment[] = []): Promise<void> {
    if (!isDesktop) nativeRequired('Sending agent prompts');
    try {
      await commands.agentPrompt(text, attachments.length ? attachments : null);
    } catch (cause) {
      if (cause && typeof cause === 'object' && 'kind' in cause && 'message' in cause) throw Object.assign(new Error(String((cause as PromptError).message)), { prompt: cause as PromptError });
      throw cause;
    }
  },
  /** Runtime state of every session on the active connection. */
  async agentSessionStates(): Promise<SessionStates> {
    if (!isDesktop) return { connectionId: null, sessions: [] };
    return commands.agentSessionStates();
  },
  /** Session states as the backend publishes them, whenever they change. */
  async onAgentSessionStates(listener: (states: SessionStates) => void): Promise<() => void> {
    return isDesktop ? events.agentSessionStatesChanged.listen(event => listener(event.payload.states)) : () => undefined;
  },
  /**
   * Sign in with an advertised method, then the blocked session is created. Returns the session id. A refusal is thrown
   * as an Error whose `auth` field is the typed `AuthError` (`kind` authentication_in_progress, cancelled or failed).
   */
  async agentAuthenticate(methodId: string): Promise<string> {
    if (!isDesktop) nativeRequired('Signing in to agents');
    try {
      return await commands.agentAuthenticate(methodId);
    } catch (cause) {
      return authFailure(cause);
    }
  },
  /** Cancel the sign-in in flight on the active connection. Its pending call rejects with `auth.kind` cancelled. */
  async agentCancelAuthentication(): Promise<boolean> {
    if (!isDesktop) return false;
    return commands.agentCancelAuthentication();
  },
  /** action is accept, decline or cancel. contentJson is a JSON object string and applies to accept. */
  async agentElicitation(requestId: string, action: 'accept' | 'decline' | 'cancel', contentJson: string | null = null): Promise<void> {
    if (!isDesktop) nativeRequired('Answering agent requests');
    await commands.agentElicitation(requestId, action, contentJson);
  },
  async agentSetConfig(configId: string, value: string): Promise<void> {
    if (!isDesktop) nativeRequired('Changing agent options');
    await commands.agentSetConfig(configId, value);
  },
  /** The open chat's Span permission mode (ADR 0015). The backend validates it and enforces it at the adapter. */
  async agentSetPermissionMode(mode: ThreadPermissionMode): Promise<void> {
    if (!isDesktop) nativeRequired('Changing the permission mode');
    await commands.agentSetPermissionMode(mode);
  },
  async agentNewSession(): Promise<string> {
    if (!isDesktop) nativeRequired('Starting a new chat');
    return commands.agentNewSession();
  },
  async agentListSessions(): Promise<SessionSummary[]> {
    if (!isDesktop) nativeRequired('Listing earlier chats');
    return commands.agentListSessions();
  },
  /** Sessions from every folder the agent knows, for the History "All folders" scope. */
  async agentListAllSessions(): Promise<SessionSummary[]> {
    if (!isDesktop) nativeRequired('Listing earlier chats');
    return commands.agentListAllSessions();
  },
  async agentResumeSession(sessionId: string): Promise<string> {
    if (!isDesktop) nativeRequired('Resuming a chat');
    return commands.agentResumeSession(sessionId);
  },
  async agentCloseSession(sessionId: string): Promise<void> {
    if (!isDesktop) nativeRequired('Closing a chat');
    await commands.agentCloseSession(sessionId);
  },
  async agentDeleteSession(sessionId: string): Promise<void> {
    if (!isDesktop) nativeRequired('Deleting a chat');
    await commands.agentDeleteSession(sessionId);
  },
  async agentCancel(): Promise<void> {
    if (!isDesktop) nativeRequired('Cancelling agents');
    await commands.agentCancel();
  },
  async agentDisconnect(): Promise<void> {
    if (!isDesktop) nativeRequired('Disconnecting agents');
    supersedeAgent();
    await commands.agentDisconnect();
  },
  async agentPermission(requestId: string, optionId: string | null): Promise<void> {
    if (!isDesktop) nativeRequired('Responding to agent permissions');
    await commands.agentPermission(requestId, optionId);
  },
  async agentReview(proposalId: string, accept: boolean, expectedRevision: number): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Reviewing agent edits');
    return commands.agentReview(proposalId, accept, expectedRevision);
  },
  async agentReviewHunks(proposalId: string, acceptedHunkIds: string[], expectedRevision: number): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Reviewing agent edit hunks');
    return commands.agentReviewHunks(proposalId, acceptedHunkIds, expectedRevision);
  },
  async onAgentEvent(listener: (event: AgentEvent) => void): Promise<() => void> {
    agentListeners.add(listener);
    return () => { agentListeners.delete(listener); };
  },
};

const lspUnavailable = (): never => { throw { kind: 'unsupported', message: 'Language servers need the span desktop app.' }; };
const noListener = async (): Promise<() => void> => () => undefined;
const hubPreview = isDesktop ? undefined : createHubPreview(previewWorkspace.root);

/** Hub commands and events. The generated ones in the native app, the labelled fixture (see hub-preview.ts) in browser preview. */
export const hubPort: HubPort = {
  cancelInstall: server => isDesktop ? commands.lspCancelInstall(server) : hubPreview!.hub.cancelInstall(server),
  trustWorkspace: trusted => isDesktop ? commands.lspTrustWorkspace(trusted) : hubPreview!.hub.trustWorkspace(trusted),
  onWorkProgress: listener => isDesktop
    ? events.languageServerWorkProgress.listen(event => listener(event.payload))
    : hubPreview!.hub.onWorkProgress(listener),
  pickPath: async (kind, title) => {
    if (!isDesktop) return hubPreview!.hub.pickPath(kind, title);
    const selected = await open({ directory: kind === 'folder', multiple: false, title });
    return typeof selected === 'string' ? selected : null;
  },
};

/** Language server commands and events. Browser preview has none, so requests are unsupported and listeners are inert. */
export const lspPort: LspPort = {
  completion: (path, position, trigger, requestId) => isDesktop ? commands.lspCompletion(path, position, trigger, requestId) : lspUnavailable(),
  hover: (path, position, requestId) => isDesktop ? commands.lspHover(path, position, requestId) : Promise.resolve(previewHover(path, position)),
  definition: (path, position, requestId) => isDesktop ? commands.lspDefinition(path, position, requestId) : previewNavigation.definition(path, position, requestId).then(reply => ({ ...reply, revision: 0, epoch: 0 })),
  format: (path, range, requestId) => isDesktop ? commands.lspFormat(path, range, requestId) : lspUnavailable(),
  cancel: requestId => isDesktop ? commands.lspCancel(requestId) : Promise.resolve(null),
  install: server => isDesktop ? commands.lspInstall(server) : hubPreview!.active() ? hubPreview!.install(server) : lspUnavailable(),
  restart: server => isDesktop ? commands.lspRestart(server) : hubPreview!.active() ? hubPreview!.restart(server) : lspUnavailable(),
  status: () => isDesktop ? commands.lspStatus() : Promise.resolve(hubPreview!.rows()),
  onDiagnostics: listener => isDesktop ? events.diagnosticsPublished.listen(event => listener(event.payload)) : noListener(),
  onState: listener => isDesktop ? events.languageServerStateChanged.listen(event => listener(event.payload)) : hubPreview!.onState(listener),
  onInstallProgress: listener => isDesktop ? events.languageServerInstallProgress.listen(event => listener(event.payload)) : hubPreview!.onInstallProgress(listener),
  onError: listener => isDesktop ? events.languageServerError.listen(event => listener(event.payload)) : noListener(),
  onWatchRecovery: listener => isDesktop ? events.languageServerWatchRecovery.listen(event => listener(event.payload)) : noListener(),
};

/** Sign in with a method whose `input` is `apiKey` or `gateway`. The secret goes to the agent only; Span does not log or store it. Returns the session id. */
export async function agentAuthenticateWith(methodId: string, credential: import('../bindings').AuthCredential_Deserialize): Promise<string> {
  if (!isDesktop) nativeRequired('Signing in to agents');
  try {
    return await commands.agentAuthenticateWith(methodId, credential);
  } catch (cause) {
    return authFailure(cause);
  }
}

/** Rethrows a typed sign-in refusal as an Error whose `auth` field is the `AuthError`. It never carries the credential. */
function authFailure(cause: unknown): never {
  if (cause && typeof cause === 'object' && 'kind' in cause && 'message' in cause) throw Object.assign(new Error(String((cause as AuthError).message)), { auth: cause as AuthError });
  throw cause;
}

/** Agents launched by a known custom command (OpenCode) rather than a registry install. */
export async function agentPresets(): Promise<import('../bindings').AgentPreset_Serialize[]> {
  return isDesktop ? commands.agentPresets() : [];
}

/** Delegation state of the connected agent and its current chat: whether `agents.delegation.enabled` is on (honoured from user settings only), whether the agent can use span-agents and why not, and the lead's tasks and decisions. */
export async function agentDelegationStatus(): Promise<import('../bindings').DelegationStatus_Serialize> {
  if (!isDesktop) nativeRequired('Agent delegation');
  return commands.agentDelegationStatus();
}

/** Answer a permission request from a delegated child session. Only for the user's own choice in the UI; user sessions use `api.agentPermission`. */
export async function agentChildPermission(connectionId: string, sessionId: string, requestId: string, optionId: string | null): Promise<void> {
  if (!isDesktop) nativeRequired('Responding to agent permissions');
  await commands.agentChildPermission(connectionId, sessionId, requestId, optionId);
}

/** Stop one delegated task: its child session and everything below it are cancelled and the task ends as cancelled. The user's own action; no agent tool can call it. */
export async function agentCancelTask(taskId: string): Promise<void> {
  if (!isDesktop) nativeRequired('Cancelling an agent task');
  await commands.agentCancelTask(taskId);
}

/** One delegated task and the text its child session wrote so far, for opening the child session from its card. Read only. */
export async function agentTaskTranscript(taskId: string): Promise<import('../bindings').DelegationTranscript_Serialize> {
  if (!isDesktop) nativeRequired('Opening a delegated session');
  return commands.agentTaskTranscript(taskId);
}

type SessionKey = import('../bindings').SessionKey;
type LiveSession = import('../bindings').LiveSession_Serialize;
type AgentKeyedEvent = import('../bindings').AgentKeyedEvent_Serialize;

/** Rethrows a typed prompt refusal as an Error whose `prompt` field is the `PromptError`, like `api.agentPrompt`. */
function promptFailure(cause: unknown): never {
  if (cause && typeof cause === 'object' && 'kind' in cause && 'message' in cause) throw Object.assign(new Error(String((cause as PromptError).message)), { prompt: cause as PromptError });
  throw cause;
}

/**
 * Keyed agent sessions (ADR 0011 phase 1). Every call names its session by `SessionKey` (connection id plus session id),
 * so several live threads can run at once. The sidebar keeps using the unkeyed `api.agent*` calls, which the backend
 * resolves to the focused session; `focused()` returns that key.
 */
export const agentSessions = {
  /** Open a new session on `connectionId`, on a process for `command`, or on the focused connection. Never closes another session. */
  async open(options: { connectionId?: string; command?: AgentCommand; focus?: boolean } = {}): Promise<SessionKey> {
    if (!isDesktop) nativeRequired('Opening agent sessions');
    return commands.agentOpenSession(options.connectionId ?? null, options.command ?? null, options.focus ?? false);
  },
  /** Every live session with state, agent, title, model, mode, health and parent key. */
  async live(): Promise<LiveSession[]> {
    return isDesktop ? commands.agentLiveSessions() : [];
  },
  /** The session the unkeyed sidebar commands act on, null without one. */
  async focused(): Promise<SessionKey | null> {
    return isDesktop ? commands.agentFocusedSession() : null;
  },
  async prompt(key: SessionKey, text: string, attachments: PromptAttachment[] = []): Promise<void> {
    if (!isDesktop) nativeRequired('Sending agent prompts');
    try {
      await commands.agentPromptKeyed(key, text, attachments.length ? attachments : null);
    } catch (cause) {
      promptFailure(cause);
    }
  },
  async cancel(key: SessionKey): Promise<void> {
    if (!isDesktop) nativeRequired('Cancelling agents');
    await commands.agentCancelKeyed(key);
  },
  /** The user's own answer only. */
  async permission(key: SessionKey, requestId: string, optionId: string | null): Promise<void> {
    if (!isDesktop) nativeRequired('Responding to agent permissions');
    await commands.agentPermissionKeyed(key, requestId, optionId);
  },
  /** The user's own answer only. */
  async elicitation(key: SessionKey, requestId: string, action: 'accept' | 'decline' | 'cancel', contentJson: string | null = null): Promise<void> {
    if (!isDesktop) nativeRequired('Answering agent requests');
    await commands.agentElicitationKeyed(key, requestId, action, contentJson);
  },
  async setConfig(key: SessionKey, configId: string, value: string): Promise<void> {
    if (!isDesktop) nativeRequired('Changing agent options');
    await commands.agentSetConfigKeyed(key, configId, value);
  },
  async setPermissionMode(key: SessionKey, mode: ThreadPermissionMode): Promise<void> {
    if (!isDesktop) nativeRequired('Changing the permission mode');
    await commands.agentSetPermissionModeKeyed(key, mode);
  },
  async review(key: SessionKey, proposalId: string, accept: boolean, expectedRevision: number): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Reviewing agent edits');
    return commands.agentReviewKeyed(key, proposalId, accept, expectedRevision);
  },
  async reviewHunks(key: SessionKey, proposalId: string, acceptedHunkIds: string[], expectedRevision: number): Promise<BufferSnapshot> {
    if (!isDesktop) nativeRequired('Reviewing agent edit hunks');
    return commands.agentReviewHunksKeyed(key, proposalId, acceptedHunkIds, expectedRevision);
  },
  /** Close a session; its delegated children close with it. */
  async close(key: SessionKey): Promise<void> {
    if (!isDesktop) nativeRequired('Closing a chat');
    await commands.agentCloseKeyed(key);
  },
  /** Every agent event of every connection, tagged with its session key (null for connection level events). */
  async onEvent(listener: (event: AgentKeyedEvent) => void): Promise<() => void> {
    return isDesktop ? events.agentKeyedEvent.listen(event => listener(event.payload)) : () => undefined;
  },
};

/** Preview only: the browser answers navigation requests from a labelled text-scanning fixture, see navigation-preview.ts. */
const previewNavigation = createPreviewNavigationPort(() => Object.fromEntries(Object.keys(fixture).map(path => { const buffer = buffers.get(path); return [path, { text: buffer?.text ?? fixture[path], revision: buffer?.revision ?? 0 }]; })));

/** Code navigation commands. Browser preview answers from the labelled fixture. */
export const navigationPort: NavigationPort = isDesktop ? {
  definition: (path, position, id) => commands.lspDefinition(path, position, id),
  typeDefinition: (path, position, id) => commands.lspTypeDefinition(path, position, id),
  implementation: (path, position, id) => commands.lspImplementation(path, position, id),
  declaration: (path, position, id) => commands.lspDeclaration(path, position, id),
  references: (path, position, include, id) => commands.lspReferences(path, position, include, id),
  documentSymbols: (path, id) => commands.lspDocumentSymbols(path, id),
  workspaceSymbols: (query, hint, id) => commands.lspWorkspaceSymbols(query, hint, id),
  callPrepare: (path, position, id) => commands.lspCallHierarchyPrepare(path, position, id),
  callIncoming: (item, id) => commands.lspCallHierarchyIncoming(item, id),
  callOutgoing: (item, id) => commands.lspCallHierarchyOutgoing(item, id),
  typePrepare: (path, position, id) => commands.lspTypeHierarchyPrepare(path, position, id),
  typeSupertypes: (item, id) => commands.lspTypeHierarchySupertypes(item, id),
  typeSubtypes: (item, id) => commands.lspTypeHierarchySubtypes(item, id),
  highlights: (path, position, id) => commands.lspDocumentHighlights(path, position, id),
  prepareRename: (path, position, id) => commands.lspPrepareRename(path, position, id),
  rename: (path, position, name, id) => commands.lspRename(path, position, name, id),
  readSource: (location, context) => commands.lspReadSource(location, context),
  cancel: id => commands.lspCancel(id),
} : previewNavigation;

/** Check-only agent update status: Span-installed registry agents against the registry's current version, and local programs through the version probe. Unknown means unknown; nothing is installed or run to update. */
export async function agentUpdateStatus(): Promise<import('../bindings').AgentUpdate_Serialize[]> {
  if (!isDesktop) nativeRequired('Agent update checks');
  return commands.agentUpdateStatus();
}

/** Check-only app update check for this build's channel against the public GitHub release list. Never downloads or installs. Open `releaseUrl` with `api.openExternal` after a user click. */
export async function appUpdateCheck(): Promise<import('../bindings').AppUpdate_Serialize> {
  if (!isDesktop) nativeRequired('App update checks');
  return commands.appUpdateCheck();
}

/** Session history metadata of the active workspace (ADR 0005), most recently active first. Browser preview has no history and returns an empty list. */
export async function sessionMetaList(): Promise<import('../bindings').SessionMeta_Serialize[]> {
  return isDesktop ? commands.sessionMetaList() : [];
}

/** Usage totals by day, agent and model over every folder's sessions (ADR 0012). Browser preview records no usage and returns `undefined`. */
export async function usageSummary(range: import('../bindings').UsageRange_Deserialize): Promise<import('../bindings').UsageSummary_Serialize | undefined> {
  return isDesktop ? commands.usageSummary(range) : undefined;
}

/** Sessions with usage in the range, most recently active first (ADR 0012). Empty in the browser preview. */
export async function usageSessions(range: import('../bindings').UsageRange_Deserialize): Promise<import('../bindings').SessionUsageRow_Serialize[]> {
  return isDesktop ? commands.usageSessions(range) : [];
}

/** Starts a background scan of the agents' local usage logs when `agents.usage.importLocalLogs` is on (the default, ADR 0012). Returns at once. */
export async function usageImportScan(): Promise<import('../bindings').UsageImportStatus_Serialize | undefined> {
  return isDesktop ? commands.usageImportScan() : undefined;
}

/** The local log importer's state and the running scan's progress. */
export async function usageImportStatus(): Promise<import('../bindings').UsageImportStatus_Serialize | undefined> {
  return isDesktop ? commands.usageImportStatus() : undefined;
}

/** Claude Code's five-hour usage blocks from its local logs over the last `days` days (ADR 0012). */
export async function usageBlocks(days: number): Promise<import('../bindings').UsageBlock_Serialize[]> {
  return isDesktop ? commands.usageBlocks(days) : [];
}

/** Merge a patch into one session's metadata: model and agent uses add up, counters and stop reason replace. Debouncing is the caller's job. */
export async function sessionMetaUpdate(patch: import('../bindings').SessionMetaPatch_Deserialize): Promise<import('../bindings').SessionMeta_Serialize> {
  if (!isDesktop) nativeRequired('Saving session history');
  return commands.sessionMetaUpdate(patch);
}

/** Set or clear (null or blank) the user's title for a session. */
export async function sessionMetaSetTitle(agentId: string, sessionId: string, title: string | null): Promise<import('../bindings').SessionMeta_Serialize> {
  if (!isDesktop) nativeRequired('Renaming sessions');
  return commands.sessionMetaSetTitle(agentId, sessionId, title);
}

export async function sessionMetaSetArchived(agentId: string, sessionId: string, archived: boolean): Promise<import('../bindings').SessionMeta_Serialize> {
  if (!isDesktop) nativeRequired('Archiving sessions');
  return commands.sessionMetaSetArchived(agentId, sessionId, archived);
}

/** Forget Span's metadata for a session; the agent's own session is not deleted. Resolves true when something was removed. */
export async function sessionMetaDelete(agentId: string, sessionId: string): Promise<boolean> {
  if (!isDesktop) nativeRequired('Removing session history');
  return commands.sessionMetaDelete(agentId, sessionId);
}

/** Render a transcript as Markdown for "Export as Markdown"; workspace paths become `.` and the home directory `~`. */
export async function sessionExportMarkdown(transcript: import('../bindings').Transcript_Deserialize): Promise<string> {
  if (!isDesktop) nativeRequired('Exporting chats as Markdown');
  return commands.sessionExportMarkdown(transcript);
}

/** Uploads panel (ADR 0006): files the user sent to agents or added, stored per workspace in app data, never in the workspace. Newest first. Browser preview has no store, so it lists nothing. */
export async function uploadsList(): Promise<import('../bindings').Upload_Serialize[]> {
  return isDesktop ? commands.uploadsList() : [];
}

/** Store usage and caps. Over a cap, new uploads are refused; nothing is evicted. */
export async function uploadsUsage(): Promise<import('../bindings').UploadUsage> {
  if (isDesktop) return commands.uploadsUsage();
  return { count: 0, totalBytes: 0, maxCount: 2000, maxTotalBytes: 512 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, orphanBlobs: 0, orphanBytes: 0, quarantinedIndexes: 0 };
}

/** The uploads store folder of the open workspace, in app data. */
export async function uploadsFolder(): Promise<string> {
  if (!isDesktop) nativeRequired('The uploads store');
  return commands.uploadsFolder();
}

/** Open the uploads store folder in the system file manager. */
export async function uploadsRevealFolder(): Promise<void> {
  if (!isDesktop) nativeRequired('Revealing the uploads folder');
  await commands.uploadsRevealFolder();
}

/** Clear this workspace's uploads store after the user confirmed. Workspace files are never touched. */
export async function uploadsClear(): Promise<import('../bindings').ClearedUploads> {
  if (!isDesktop) nativeRequired('Clearing uploads');
  return commands.uploadsClear();
}

/** Bounded outline of a workspace folder (folder-relative paths) in one call. Desktop only. */
export async function folderOutline(path: string, limit: number): Promise<import('../bindings').FolderOutline> {
  if (!isDesktop) nativeRequired('Folder outlines');
  return commands.folderOutline(path, limit);
}

/** Page count of a PDF read in Rust, for files the viewer's PDF library cannot open. Undefined when not reliably readable. */
export async function pdfPageCountNative(dataBase64: string): Promise<number | undefined> {
  if (!isDesktop) return undefined;
  return (await commands.pdfPageCount(dataBase64)) ?? undefined;
}

/** Store a file (at most 32 MiB). `name` follows the workspace attachment naming rules. */
export async function uploadsAdd(name: string, dataBase64: string, source: import('../bindings').UploadSource_Deserialize): Promise<import('../bindings').Upload_Serialize> {
  if (!isDesktop) nativeRequired('Storing uploads');
  return commands.uploadsAdd(name, dataBase64, source);
}

/** Bounded read for previews: at most 4 MiB per call, `eof` marks the last chunk. */
export async function uploadsRead(id: string, offset: number, len: number): Promise<import('../bindings').UploadChunk> {
  if (!isDesktop) nativeRequired('Reading uploads');
  return commands.uploadsRead(id, offset, len);
}

export async function uploadsRename(id: string, name: string): Promise<import('../bindings').Upload_Serialize> {
  if (!isDesktop) nativeRequired('Renaming uploads');
  return commands.uploadsRename(id, name);
}

export async function uploadsDuplicate(id: string): Promise<import('../bindings').Upload_Serialize> {
  if (!isDesktop) nativeRequired('Duplicating uploads');
  return commands.uploadsDuplicate(id);
}

export async function uploadsRemove(id: string): Promise<void> {
  if (!isDesktop) nativeRequired('Removing uploads');
  await commands.uploadsRemove(id);
}

/** Copy into a workspace-relative folder. Never overwrites: a taken name gets a numbered suffix. */
export async function uploadsSaveToWorkspace(id: string, dir: string): Promise<SavedAttachment> {
  if (!isDesktop) nativeRequired('Saving uploads to the workspace');
  return commands.uploadsSaveToWorkspace(id, dir);
}

/** App data path of a named copy, only for an explicit "Copy path". Show the upload name otherwise. */
export async function uploadsCopyPath(id: string): Promise<string> {
  if (!isDesktop) nativeRequired('Copying upload paths');
  return commands.uploadsCopyPath(id);
}

export async function uploadsReveal(id: string): Promise<void> {
  if (!isDesktop) nativeRequired('Revealing uploads');
  await commands.uploadsReveal(id);
}

/** Open with the system default app. Programs, scripts and installers are refused with advice to save to the workspace instead. */
export async function uploadsOpen(id: string): Promise<void> {
  if (!isDesktop) nativeRequired('Opening uploads with another app');
  await commands.uploadsOpen(id);
}
