import { batch, createSignal } from "solid-js";
import type { FileEntry } from "../bindings";
import type { Workbench } from "../stores/workbench";
import { copyName, creationFolder, join, rangeBetween, renameSelectionEnd, topLevelPaths, validateName } from "./explorer-ops";
import { compactChain } from "./compact-tree";
import { explorerPreferences } from "./explorer-prefs";
import { fileName, parentPath } from "./navigation";
import { desktopTransfer, importSummary, pastedName, sameEntries, type ConflictPolicy, type ExplorerTransfer, type ImportItems, type ImportProgress, type PastedKind } from "./explorer-transfer";
import type { DroppedPath } from "./native-drop";
import { notify } from "../stores/notifications";

export type ExplorerEdit = { mode: "create" | "rename"; kind: "file" | "folder"; parent: string; path?: string; value: string; template?: string; error?: string; warning?: string; select?: [number, number]; busy?: boolean };
export type ConflictChoice = "cancel" | "keep" | "replace";
/** Answer to one name clash of an import from outside Span. Undefined cancels the whole import. */
export type ImportChoice = { policy: ConflictPolicy; all: boolean };
export type ExplorerDialog =
  | { kind: "conflict"; folder: string; names: string[]; resolve: (choice: ConflictChoice) => void }
  | { kind: "import-conflict"; folder: string; name: string; remaining: number; resolve: (choice: ImportChoice | undefined) => void }
  | { kind: "paste-name"; folder: string; pasted: PastedKind; value: string; resolve: (name: string | undefined) => void }
  | { kind: "delete"; paths: string[]; resolve: (ok: boolean) => void };

export const templates = [
  { id: "file", label: "File", icon: "file", group: "a", kind: "file" as const },
  { id: "folder", label: "Folder", icon: "folder", group: "a", kind: "folder" as const },
  { id: "ts", label: "TypeScript File", icon: "typescript", detail: ".ts", group: "b", kind: "file" as const, ext: ".ts" },
  { id: "class", label: "TypeScript Class", icon: "typescript", detail: "class", group: "b", kind: "file" as const, ext: ".ts" },
  { id: "react", label: "React Component", icon: "react_ts", detail: ".tsx", group: "b", kind: "file" as const, ext: ".tsx" },
  { id: "test", label: "Test", icon: "test-ts", detail: ".test.ts", group: "b", kind: "file" as const, ext: ".test.ts" },
  { id: "package", label: "package.json", icon: "nodejs", group: "c", kind: "file" as const, fixed: "package.json" },
  { id: "docker", label: "Dockerfile", icon: "docker", group: "c", kind: "file" as const, fixed: "Dockerfile" },
  { id: "gitignore", label: ".gitignore", icon: "git", group: "c", kind: "file" as const, fixed: ".gitignore" },
  { id: "readme", label: "README.md", icon: "readme", group: "c", kind: "file" as const, fixed: "README.md" },
];

/** All Explorer state and file operations. The Explorer component renders it, App wires the actions and dialogs. */
export function createExplorerState(w: Workbench, transfer: ExplorerTransfer = desktopTransfer) {
  const preferences = () => explorerPreferences(w.settings());
  const [selection, setSelection] = createSignal<readonly string[]>([]);
  const [focus, setFocus] = createSignal<string>();
  const [anchor, setAnchor] = createSignal<string>();
  const [edit, setEdit] = createSignal<ExplorerEdit>();
  const [clipboard, setClipboard] = createSignal<{ paths: string[]; cut: boolean; generation: number }>();
  const [dialog, setDialog] = createSignal<ExplorerDialog>();
  const [templateRequest, setTemplateRequest] = createSignal<{ folder: string; x: number; y: number }>();
  const [notice, setNotice] = createSignal("");
  const undoStack: Array<{ label: string; run: () => Promise<void> }> = [];
  /** The import from outside Span that is running, with its latest progress. */
  const [importing, setImporting] = createSignal<{ folder: string; progress?: ImportProgress }>();

  const listing = (folder: string): readonly FileEntry[] | undefined => w.directories[folder];
  const entryOf = (path: string) => listing(parentPath(path))?.find(entry => entry.path === path);
  const isDirectory = (path: string) => path === "" || !!entryOf(path)?.isDir;
  const visiblePaths = () => Array.from(document.querySelectorAll<HTMLElement>('.file-tree [role="treeitem"]')).map(row => row.dataset.path ?? "").filter(Boolean);
  const fail = (error: unknown) => { w.setError(String(error instanceof Error ? error.message : error)); };

  function selectOnly(path: string) { batch(() => { setSelection([path]); setFocus(path); setAnchor(path); }); }
  function toggleSelect(path: string) { batch(() => { const current = selection(); setSelection(current.includes(path) ? current.filter(item => item !== path) : [...current, path]); setFocus(path); setAnchor(path); }); }
  function selectRange(path: string) { batch(() => { setSelection(rangeBetween(visiblePaths(), anchor() ?? path, path)); setFocus(path); }); }
  function clearSelection() { setSelection([]); }
  function clearClipboard() { setClipboard(undefined); }
  function selectAll() { const all = visiblePaths(); batch(() => { setSelection(all); setAnchor(all[0]); }); }
  const scrollTo = (path: string) => scrollIntoView(path);
  /** Selected paths, or the focused row when nothing is selected. */
  const targets = () => selection().length ? [...selection()] : focus() ? [focus()!] : [];

  async function ensureExpanded(folder: string) {
    const chain = ["", ...folder.split("/").filter(Boolean).map((_part, index, parts) => parts.slice(0, index + 1).join("/"))];
    for (const path of chain) { if (!w.expanded().has(path)) await w.toggleDirectory(path); else if (!w.directories[path]) await w.loadDirectory(path); }
  }
  function scrollIntoView(path: string) {
    queueMicrotask(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`.file-tree [data-path="${CSS.escape(path)}"], .file-tree .tree-edit-row`)?.scrollIntoView?.({ block: "nearest" })));
  }
  /** Reveal a path in the tree: expand its ancestors, select it, scroll it into view. */
  async function reveal(path: string, select = true) {
    await ensureExpanded(parentPath(path));
    if (select) selectOnly(path);
    scrollIntoView(path);
  }

  const creationParent = () => creationFolder(selection().length ? selection() : focus() ? [focus()!] : [], isDirectory, w.activePath());
  async function startCreate(kind: "file" | "folder", folder = creationParent(), template?: string) {
    const known = templates.find(item => item.id === template);
    await ensureExpanded(folder);
    // A compact chain shows only its deepest folder, so a new row for an inner segment belongs under that one.
    if (preferences().compactFolders && folder) { const deepest = compactChain(folder, w.directories).deepest; if (deepest !== folder) { await ensureExpanded(deepest); folder = deepest; } }
    setEdit({ mode: "create", kind, parent: folder, value: known?.ext ?? "", template, select: [0, 0] });
    scrollIntoView("");
  }
  async function startTemplate(id: string, folder = creationParent()) {
    const item = templates.find(entry => entry.id === id); if (!item) return;
    if (item.fixed) {
      await ensureExpanded(folder);
      const path = join(folder, item.fixed);
      if (listing(folder)?.some(entry => entry.name.toLowerCase() === item.fixed.toLowerCase())) { setNotice(`${item.fixed} already exists in ${folder ? fileName(folder) : "the project"}.`); await reveal(path); return; }
      try { await w.newFile(path); undoPush(`Create ${item.fixed}`, () => w.trashPath(path)); await reveal(path); } catch (error) { fail(error); }
      return;
    }
    await startCreate(item.kind, folder, id === "file" || id === "folder" ? undefined : id);
  }
  async function startRename(path = focus() ?? selection()[0]) {
    if (!path || !entryOf(path)) return;
    const name = fileName(path);
    await ensureExpanded(parentPath(path));
    setEdit({ mode: "rename", kind: isDirectory(path) ? "folder" : "file", parent: parentPath(path), path, value: name, select: [0, renameSelectionEnd(name, isDirectory(path))] });
    selectOnly(path);
  }
  function setEditValue(value: string) {
    const current = edit(); if (!current) return;
    const check = value ? validateName(value, current.parent, listing, current.path) : undefined;
    // Errors surface while typing so the user sees them before pressing Enter.
    setEdit({ ...current, value, error: check?.level === "error" && value.trim() ? check.msg : undefined, warning: check && check.level === "warn" ? check.msg : undefined });
  }
  function cancelEdit() { setEdit(undefined); }

  function undoPush(label: string, run: () => Promise<void>) { undoStack.push({ label, run }); if (undoStack.length > 50) undoStack.shift(); }
  async function undo() {
    const last = undoStack.pop(); if (!last) { setNotice("Nothing to undo."); return; }
    try { await last.run(); setNotice(`Undone: ${last.label.charAt(0).toLowerCase()}${last.label.slice(1)}`); } catch (error) { fail(error); }
  }

  async function commitEdit() {
    const current = edit(); if (!current || current.busy) return;
    const check = validateName(current.value, current.parent, listing, current.path);
    if (check.level === "error") { setEdit({ ...current, error: check.msg }); return; }
    setEdit({ ...current, busy: true });
    try {
      if (current.mode === "rename") {
        const from = current.path!; const to = join(current.parent, check.segs.join("/"));
        if (to !== from) { await w.renamePath(from, to); undoPush(`Rename ${fileName(from)}`, async () => { await w.renamePath(to, from); await reveal(from); }); }
        setEdit(undefined); await reveal(to);
        return;
      }
      let base = current.parent;
      for (const segment of check.segs.slice(0, -1)) { base = join(base, segment); if (check.newDirs.includes(segment) && !listing(parentPath(base))?.some(entry => entry.path === base)) await w.newDirectory(base); }
      const path = join(base, check.last);
      const folder = current.kind === "folder" || check.trailingSlash;
      const firstCreated = check.newDirs.length ? join(current.parent, check.segs[0]) : path;
      if (folder) await w.newDirectory(path); else await w.newFile(path);
      undoPush(`Create ${check.last}`, () => w.trashPath(firstCreated));
      setEdit(undefined); await reveal(path);
    } catch (error) {
      const latest = edit(); if (latest) setEdit({ ...latest, busy: false, error: String(error instanceof Error ? error.message : error) });
    }
  }

  /** Copy or cut: the in-app clipboard drives moves, and the OS clipboard gets the files so Finder or Explorer can paste them. */
  function setClip(cut: boolean) {
    const paths = topLevelPaths(targets()); if (!paths.length) return;
    setClipboard({ paths, cut, generation: w.workspaceGeneration() });
    // Browser preview has no OS clipboard command: the in-app clipboard still works.
    void Promise.resolve().then(() => transfer.writeClipboard(paths)).catch(() => undefined);
  }
  async function loaded(folder: string) { if (!w.directories[folder]) await w.loadDirectory(folder); return listing(folder) ?? []; }

  /** Move or copy items into a folder, asking Replace / Keep Both / Cancel on name conflicts. Returns whether anything changed. */
  async function move(sources: readonly string[], folder: string, copy: boolean): Promise<boolean> {
    const items = topLevelPaths(sources).filter(path => entryOf(path));
    if (!items.length) return false;
    for (const path of items) if (folder === path || folder.startsWith(`${path}/`)) { w.setError("A folder cannot be moved inside itself."); return false; }
    const siblings = await loaded(folder);
    const taken = (name: string) => siblings.some(entry => entry.name.toLowerCase() === name.toLowerCase());
    const plan = items.map(path => ({ path, name: fileName(path), same: parentPath(path) === folder, directory: isDirectory(path) }));
    const conflicts = plan.filter(item => taken(item.name) && !(item.same && !copy));
    const selfCopies = conflicts.filter(item => item.same);
    const real = conflicts.filter(item => !item.same);
    let choice: ConflictChoice = "keep";
    if (real.length) { choice = await new Promise<ConflictChoice>(resolve => setDialog({ kind: "conflict", folder, names: real.map(item => item.name), resolve })); setDialog(undefined); if (choice === "cancel") return false; }
    const done: string[] = []; const reverse: Array<() => Promise<void>> = [];
    try {
      for (const item of plan) {
        if (item.same && !copy) continue;
        let name = item.name; const clash = taken(name);
        if (clash && (choice === "keep" || selfCopies.includes(item))) name = copyName(name, item.directory, candidate => taken(candidate));
        else if (clash && choice === "replace") { const existing = join(folder, siblings.find(entry => entry.name.toLowerCase() === name.toLowerCase())!.name); await w.trashPath(existing); }
        const destination = join(folder, name);
        if (copy) { await w.duplicatePath(item.path, destination, false); reverse.push(() => w.trashPath(destination)); }
        else { await w.renamePath(item.path, destination); const from = item.path; reverse.push(async () => { await w.renamePath(destination, from); }); }
        done.push(destination);
      }
    } catch (error) { fail(error); }
    if (done.length) {
      undoPush(`${copy ? "Copy" : "Move"} ${done.length === 1 ? fileName(done[0]) : `${done.length} items`}`, async () => { for (const step of reverse.reverse()) await step(); });
      await ensureExpanded(folder);
      batch(() => { setSelection(done); setFocus(done[done.length - 1]); setAnchor(done[0]); });
      scrollIntoView(done[0]);
    }
    return done.length > 0;
  }

  /**
   * Paste into a folder. Span's own Copy or Cut moves or copies inside the project while the OS clipboard still
   * holds those items; files copied in Finder or Explorer are imported; otherwise a clipboard image or text
   * becomes a new file.
   */
  async function paste(folder = creationParent()) {
    const clip = clipboard(); const current = clip && clip.generation === w.workspaceGeneration() ? clip : undefined;
    let contents: Awaited<ReturnType<ExplorerTransfer["readClipboard"]>> | undefined;
    try { contents = await transfer.readClipboard(); } catch { contents = undefined; }
    if (current && (!contents?.files.length || sameEntries(contents.files, w.workspace()?.root, current.paths))) {
      const ok = await move(current.paths, folder, !current.cut);
      if (ok && current.cut) setClipboard(undefined);
      return;
    }
    if (contents?.files.length) { await importItems(contents.files, folder); return; }
    if (contents?.hasImage) { await pasteAsFile(folder, "image"); return; }
    if (contents?.hasText) { await pasteAsFile(folder, "text"); return; }
    setNotice("The clipboard has no files, image or text to paste.");
  }
  async function pasteAsFile(folder: string, pasted: PastedKind) {
    const siblings = await loaded(folder);
    const taken = (name: string) => siblings.some(entry => entry.name.toLowerCase() === name.toLowerCase());
    const name = await new Promise<string | undefined>(resolve => setDialog({ kind: "paste-name", folder, pasted, value: pastedName(pasted, taken), resolve }));
    setDialog(undefined);
    if (!name?.trim()) return;
    const check = validateName(name.trim(), folder, listing);
    if (check.level === "error") { w.setError(check.msg); return; }
    try {
      const entry = await transfer.pasteFile(join(folder, name.trim()), pasted);
      await w.refreshFiles();
      undoPush(`Paste ${fileName(entry.path)}`, () => w.trashPath(entry.path));
      await reveal(entry.path);
    } catch (error) { fail(error); }
  }

  /** Native drop: Rust describes each path of the latest drop, then the items are imported. */
  async function importDropped(paths: readonly string[], folder: string) {
    const items: DroppedPath[] = [];
    for (const path of paths) { try { items.push(await transfer.pathInfo(path)); } catch (error) { fail(error); } }
    return importItems(items, folder);
  }
  /** Copies items from outside Span into a folder, asking Keep both, Replace or Skip for each name clash. */
  async function importItems(items: readonly DroppedPath[], folder: string): Promise<boolean> {
    if (!items.length) return false;
    if (importing()) { setNotice("Wait for the running copy to finish."); return false; }
    const siblings = await loaded(folder);
    const taken = (name: string) => siblings.some(entry => entry.name.toLowerCase() === name.toLowerCase());
    const clashes = items.filter(item => taken(item.name));
    const plan: ImportItems = []; let forAll: ConflictPolicy | undefined; let asked = 0;
    for (const item of items) {
      let policy: ConflictPolicy = "keepBoth";
      if (taken(item.name)) {
        asked++;
        if (forAll) policy = forAll;
        else {
          const choice = await new Promise<ImportChoice | undefined>(resolve => setDialog({ kind: "import-conflict", folder, name: item.name, remaining: clashes.length - asked, resolve }));
          setDialog(undefined);
          if (!choice) return false;
          policy = choice.policy; if (choice.all) forAll = choice.policy;
        }
      }
      plan.push({ source: item.path, policy });
    }
    setImporting({ folder });
    const poll = setInterval(() => { void transfer.progress().then(progress => { if (progress && importing()) setImporting({ folder, progress }); }).catch(() => undefined); }, 250);
    let report: Awaited<ReturnType<ExplorerTransfer["importPaths"]>>;
    try { report = await transfer.importPaths(folder, plan); }
    catch (error) { fail(error); return false; }
    finally { clearInterval(poll); setImporting(undefined); }
    await w.refreshFiles();
    if (report.error) w.setError(report.error);
    const added = report.created.filter(path => !report.replaced.includes(path));
    const undoCopy = async () => { for (const path of [...added].reverse()) await w.trashPath(path); };
    if (added.length) undoPush(`Copy ${added.length === 1 ? fileName(added[0]) : `${added.length} items`}`, undoCopy);
    if (report.created.length) {
      await ensureExpanded(folder);
      batch(() => { setSelection(report.created); setFocus(report.created[report.created.length - 1]); setAnchor(report.created[0]); });
      scrollIntoView(report.created[0]);
    }
    notify({ level: report.created.length ? "success" : "info", message: importSummary(report, folder), actions: added.length ? [{ label: "Undo", run: () => void undo() }] : [] });
    return report.created.length > 0;
  }
  async function cancelImport() { try { await transfer.cancel(); } catch (error) { fail(error); } }
  async function duplicate(path = focus() ?? selection()[0]) {
    if (!path) return;
    const folder = parentPath(path);
    await move([path], folder, true);
  }
  async function trash(paths = targets()) {
    const items = topLevelPaths(paths); if (!items.length) return;
    if (preferences().confirmDelete) { const ok = await new Promise<boolean>(resolve => setDialog({ kind: "delete", paths: items, resolve })); setDialog(undefined); if (!ok) return; }
    const visible = visiblePaths(); const next = visible.find(path => !items.some(item => path === item || path.startsWith(`${item}/`)) && visible.indexOf(path) > visible.indexOf(items[items.length - 1]));
    try { for (const path of items) await w.trashPath(path); } catch (error) { fail(error); }
    batch(() => { setSelection(next ? [next] : []); setFocus(next); });
  }
  function collapseAll() { for (const path of [...w.expanded()]) if (path !== "") void w.toggleDirectory(path); }

  return { clearClipboard, selectAll, scrollTo, selection, focus, setFocus, anchor, edit, clipboard, dialog, setDialog, templateRequest, setTemplateRequest, notice, setNotice, selectOnly, toggleSelect, selectRange, clearSelection, targets, startCreate, startTemplate, startRename, setEditValue, cancelEdit, commitEdit, setClip, paste, duplicate, trash, transfer: move, importDropped, importItems, importing, cancelImport, undo, reveal, ensureExpanded, collapseAll, creationParent, isDirectory, entryOf, visiblePaths };
}
export type ExplorerState = ReturnType<typeof createExplorerState>;
