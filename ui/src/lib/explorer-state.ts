import { batch, createSignal } from "solid-js";
import type { FileEntry } from "../bindings";
import type { Workbench } from "../stores/workbench";
import { copyName, creationFolder, join, rangeBetween, renameSelectionEnd, topLevelPaths, validateName } from "./explorer-ops";
import { compactChain } from "./compact-tree";
import { compactFolders, confirmDelete } from "./explorer-prefs";
import { fileName, parentPath } from "./navigation";

export type ExplorerEdit = { mode: "create" | "rename"; kind: "file" | "folder"; parent: string; path?: string; value: string; template?: string; error?: string; warning?: string; select?: [number, number]; busy?: boolean };
export type ConflictChoice = "cancel" | "keep" | "replace";
export type ExplorerDialog =
  | { kind: "conflict"; folder: string; names: string[]; resolve: (choice: ConflictChoice) => void }
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
export function createExplorerState(w: Workbench) {
  const [selection, setSelection] = createSignal<readonly string[]>([]);
  const [focus, setFocus] = createSignal<string>();
  const [anchor, setAnchor] = createSignal<string>();
  const [edit, setEdit] = createSignal<ExplorerEdit>();
  const [clipboard, setClipboard] = createSignal<{ paths: string[]; cut: boolean; generation: number }>();
  const [dialog, setDialog] = createSignal<ExplorerDialog>();
  const [templateRequest, setTemplateRequest] = createSignal<{ folder: string; x: number; y: number }>();
  const [notice, setNotice] = createSignal("");
  const undoStack: Array<{ label: string; run: () => Promise<void> }> = [];

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
    if (compactFolders() && folder) { const deepest = compactChain(folder, w.directories).deepest; if (deepest !== folder) { await ensureExpanded(deepest); folder = deepest; } }
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

  function setClip(cut: boolean) { const paths = topLevelPaths(targets()); if (paths.length) setClipboard({ paths, cut, generation: w.workspaceGeneration() }); }
  async function loaded(folder: string) { if (!w.directories[folder]) await w.loadDirectory(folder); return listing(folder) ?? []; }

  /** Move or copy items into a folder, asking Replace / Keep Both / Cancel on name conflicts. Returns whether anything changed. */
  async function transfer(sources: readonly string[], folder: string, copy: boolean): Promise<boolean> {
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

  async function paste(folder = creationParent()) {
    const clip = clipboard(); if (!clip || clip.generation !== w.workspaceGeneration()) return;
    const ok = await transfer(clip.paths, folder, !clip.cut);
    if (ok && clip.cut) setClipboard(undefined);
  }
  async function duplicate(path = focus() ?? selection()[0]) {
    if (!path) return;
    const folder = parentPath(path);
    await transfer([path], folder, true);
  }
  async function trash(paths = targets()) {
    const items = topLevelPaths(paths); if (!items.length) return;
    if (confirmDelete()) { const ok = await new Promise<boolean>(resolve => setDialog({ kind: "delete", paths: items, resolve })); setDialog(undefined); if (!ok) return; }
    const visible = visiblePaths(); const next = visible.find(path => !items.some(item => path === item || path.startsWith(`${item}/`)) && visible.indexOf(path) > visible.indexOf(items[items.length - 1]));
    try { for (const path of items) await w.trashPath(path); } catch (error) { fail(error); }
    batch(() => { setSelection(next ? [next] : []); setFocus(next); });
  }
  function collapseAll() { for (const path of [...w.expanded()]) if (path !== "") void w.toggleDirectory(path); }

  return { clearClipboard, selectAll, scrollTo, selection, focus, setFocus, anchor, edit, clipboard, dialog, setDialog, templateRequest, setTemplateRequest, notice, setNotice, selectOnly, toggleSelect, selectRange, clearSelection, targets, startCreate, startTemplate, startRename, setEditValue, cancelEdit, commitEdit, setClip, paste, duplicate, trash, transfer, undo, reveal, ensureExpanded, collapseAll, creationParent, isDirectory, entryOf, visiblePaths };
}
export type ExplorerState = ReturnType<typeof createExplorerState>;
