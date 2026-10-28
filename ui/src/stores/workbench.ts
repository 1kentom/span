import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { ChangeSet, Text } from "@codemirror/state";
import type { EditorEdit, EditorDocumentChange } from "../components/Editor";
import { api, isDesktop } from "../lib/client";
import type { BufferSnapshot, FileEntry, SearchMatch, Settings_Serialize as Settings, Workspace } from "../bindings";

export type EditorGroup = { id: number; tabs: string[]; active?: string };
export function createWorkbench() {
  const [workspace, setWorkspace] = createSignal<Workspace>();
  const [workspaceGeneration, setWorkspaceGeneration] = createSignal(0);
  const [directories, setDirectories] = createStore<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([""]));
  const [buffers, setBuffers] = createStore<Record<string, BufferSnapshot>>({});
  const [documents, setDocuments] = createSignal<Record<string, { document: Text; change?: EditorDocumentChange }>>({});
  const [groups, setGroups] = createSignal<EditorGroup[]>([{ id: 1, tabs: [] }]);
  const [activeGroup, setActiveGroup] = createSignal(1);
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [settings, setSettings] = createSignal<Settings>({ theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false });
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [searchResults, setSearchResults] = createSignal<SearchMatch[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [pendingClose, setPendingClose] = createSignal<{ path: string; group: number }>();
  const [pendingWorkspace, setPendingWorkspace] = createSignal(false);
  const [pendingRecovery, setPendingRecovery] = createSignal<{ path: string; document: Text }>();
  const [failed, setFailed] = createSignal<Set<string>>(new Set());
  const accepted = new Map<string, BufferSnapshot>();
  const writes = new Map<string, Promise<void>>();
  const pendingEdits = new Map<string, EditorEdit[]>();
  const histories = new Map<string, { undo: { forward: ChangeSet; backward: ChangeSet; time: number; origin?: object }[]; redo: { forward: ChangeSet; backward: ChangeSet; time: number; origin?: object }[] }>();
  let workspaceVersion = 0;
  let searchVersion = 0;
  let activeSearch: { cancel: () => Promise<void> } | undefined;
  const report = (e: unknown) => setError(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
  const activePath = () => groups().find(g => g.id === activeGroup())?.active;
  const dirty = (path: string) => { documents()[path]; return !!buffers[path] && ((pendingEdits.get(path)?.length || 0) > 0 || buffers[path].revision !== buffers[path].savedRevision); };
  const hasDirty = () => Object.keys(buffers).some(dirty);

  async function loadDirectory(path: string) {
    try { setDirectories(path, await api.listDirectory(path)); } catch (e) { report(e); }
  }
  async function toggleDirectory(path: string) {
    if (expanded().has(path)) setExpanded(current => { const next = new Set(current); next.delete(path); return next; });
    else { if (!directories[path]) await loadDirectory(path); setExpanded(current => new Set([...current, path])); }
  }
  async function openFile(path: string, group = activeGroup()) {
    const version = workspaceVersion;
    try {
      if (!buffers[path]) { const buffer = await api.openBuffer(path); if (version !== workspaceVersion) return; accepted.set(path, buffer); setBuffers(path, buffer); setDocuments(current => ({ ...current, [path]: { document: Text.of(buffer.text.split("\n")) } })); }
      batch(() => { setGroups(current => current.map(g => g.id === group ? { ...g, tabs: g.tabs.includes(path) ? g.tabs : [...g.tabs, path], active: path } : g)); setActiveGroup(group); });
    } catch (e) { report(e); }
  }
  async function openWorkspace(path?: string) {
    setBusy(true);
    try {
      if (activeSearch) await activeSearch.cancel().catch(() => undefined);
      searchVersion++;
      await Promise.all([...writes.values()]);
      const value = await api.openWorkspace(path);
      if (!value) return;
      workspaceVersion++;
      setWorkspaceGeneration(workspaceVersion);
      batch(() => { setWorkspace(value); setGroups([{ id: 1, tabs: [] }]); setActiveGroup(1); setExpanded(new Set([""])); setError(""); setSearchResults([]); });
      for (const key of Object.keys(buffers)) setBuffers(key, undefined!);
      for (const key of Object.keys(directories)) setDirectories(key, undefined!);
      accepted.clear(); pendingEdits.clear(); histories.clear(); setDocuments({});
      const [rootFiles, allFiles, prefs] = await Promise.all([api.listDirectory(""), api.listFiles(), api.getSettings().catch(e => { report(e); return settings(); })]);
      batch(() => { setDirectories("", rootFiles); setFiles(allFiles); setSettings(prefs); });
      if (!isDesktop) {
        const sample = allFiles.find(f => f.path.endsWith("rpc-node.ts")) || allFiles.find(f => f.path.endsWith("App.tsx")) || allFiles[0];
        if (sample) {
          const parents = sample.path.split("/").slice(0, -1);
          let parent = "";
          for (const part of parents) { parent = parent ? `${parent}/${part}` : part; await loadDirectory(parent); setExpanded(current => new Set([...current, parent])); }
          await openFile(sample.path);
          for (const ending of ["package.json", "main.rs", "test.js"]) { const f = allFiles.find(f => f.path.endsWith(ending)); if (f) await openFile(f.path); }
          setGroups(current => current.map(g => ({ ...g, active: sample.path })));
        }
      }
    } catch (e) { report(e); } finally { setBusy(false); }
  }
  function requestWorkspace() { if (hasDirty()) setPendingWorkspace(true); else void openWorkspace(); }
  async function initialize() {
    if (!isDesktop) await openWorkspace();
    else try { setSettings(await api.getSettings()); } catch { /* Workspace settings load after folder selection. */ }
  }
  function edit(path: string, event: EditorEdit, recordHistory = true) {
    if (recordHistory) {
      const history = histories.get(path) || { undo: [], redo: [] };
      const backward = event.changeSet.invert(event.previousDocument);
      const time = Date.now();
      const last = history.undo[history.undo.length - 1];
      if (last && event.historyOrigin && last.origin === event.historyOrigin && time - last.time < 500 && last.forward.newLength === event.changeSet.length) {
        last.forward = last.forward.compose(event.changeSet);
        last.backward = backward.compose(last.backward);
        last.time = time;
      } else history.undo.push({ forward: event.changeSet, backward, time, origin: event.historyOrigin });
      if (history.undo.length > 1000) history.undo.shift();
      history.redo = []; histories.set(path, history);
    }
    const queue = pendingEdits.get(path) || [];
    queue.push(event); pendingEdits.set(path, queue);
    setDocuments(current => ({ ...current, [path]: { document: event.document, change: { before: event.previousDocument, changes: event.changeSet } } }));
    if (!writes.has(path)) void flush(path);
  }
  function applyHistory(path: string, redo = false) {
    const history = histories.get(path);
    const entry = (redo ? history?.redo : history?.undo)?.pop();
    const previousDocument = documents()[path]?.document;
    if (!entry || !history || !previousDocument) return;
    const changeSet = redo ? entry.forward : entry.backward;
    if (changeSet.length !== previousDocument.length) { report("The document changed outside this edit history. Reopen the file before undoing."); return; }
    const changes: EditorEdit["changes"] = [];
    changeSet.iterChanges((from, to, _fromNext, _toNext, inserted) => changes.push({ from, to, insert: inserted.toString() }));
    const document = changeSet.apply(previousDocument);
    entry.time = 0;
    (redo ? history.undo : history.redo).push(entry);
    edit(path, { baseRevision: buffers[path].revision, changes, previousDocument, document, changeSet }, false);
  }
  async function flush(path: string): Promise<void> {
    const previous = writes.get(path);
    if (previous) return previous;
    const operation = (async () => {
      try {
        const queue = pendingEdits.get(path);
        while (queue?.length) {
          const base = accepted.get(path);
          if (!base) return;
          const next = await api.editBuffer(path, base.revision, queue[0].changes);
          accepted.set(path, { ...base, ...next, savedRevision: Math.max(base.savedRevision, next.savedRevision) });
          queue.shift();
          batch(() => { setBuffers(path, "revision", next.revision); setBuffers(path, "savedRevision", Math.max(buffers[path].savedRevision, next.savedRevision)); });
          setFailed(current => { const result = new Set(current); result.delete(path); return result; });
        }
      } catch (e) { setFailed(current => new Set([...current, path])); report(e); }
    })();
    writes.set(path, operation);
    await operation;
    writes.delete(path);
  }
  const synchronized = (path: string) => { documents()[path]; return !(pendingEdits.get(path)?.length); };
  async function save(path = activePath()): Promise<boolean> {
    if (!path) return false;
    const version = workspaceVersion;
    try {
      await flush(path);
      const base = accepted.get(path);
      if (!base || failed().has(path)) return false;
      const result = await api.saveBuffer(path, base.revision);
      if (version !== workspaceVersion) return false;
      const current = accepted.get(path);
      accepted.set(path, current && current.revision > result.revision ? { ...current, savedRevision: Math.max(current.savedRevision, result.savedRevision) } : result);
      setBuffers(path, "savedRevision", Math.max(buffers[path].savedRevision, result.savedRevision));
      void api.listFiles().then(setFiles).catch(report);
      for (const directory of Object.keys(directories)) if (directories[directory]) void loadDirectory(directory);
      if (path === ".span/settings.jsonc") setSettings(await api.getSettings());
      return true;
    } catch (e) { report(e); return false; }
  }
  function removeTab(path: string, group: number) {
    setGroups(current => current.map(g => {
      if (g.id !== group) return g;
      const tabs = g.tabs.filter(p => p !== path);
      return { ...g, tabs, active: g.active === path ? tabs[Math.min(g.tabs.indexOf(path), tabs.length - 1)] : g.active };
    }));
  }
  function closeTab(path: string, group: number) {
    const elsewhere = groups().some(g => g.id !== group && g.tabs.includes(path));
    if (dirty(path) && !elsewhere) setPendingClose({ path, group });
    else removeTab(path, group);
  }
  async function confirmClose(action: "save" | "discard" | "cancel") {
    const pending = pendingClose(); if (!pending) return;
    if (action === "save" && !await save(pending.path)) return;
    if (action !== "cancel") {
      if (action === "discard") {
        await writes.get(pending.path);
        try {
          const base = await api.discardBuffer(pending.path);
          accepted.set(pending.path, base); pendingEdits.delete(pending.path); histories.delete(pending.path);
          setBuffers(pending.path, base);
          setDocuments(current => ({ ...current, [pending.path]: { document: Text.of(base.text.split("\n")) } }));
        } catch (e) { report(e); return; }
      }
      removeTab(pending.path, pending.group);
    }
    setPendingClose(undefined);
  }
  function splitEditor() {
    if (groups().length >= 2) { setGroups(current => [{ ...current[0], tabs: [...new Set(current.flatMap(group => group.tabs))] }]); setActiveGroup(groups()[0].id); return; }
    const path = activePath();
    setGroups(current => [...current, { id: 2, tabs: path ? [path] : [], active: path }]);
    setActiveGroup(2);
  }
  async function search(query: string) {
    const version = ++searchVersion;
    if (activeSearch) void activeSearch.cancel().catch(() => undefined);
    setSearchResults([]);
    if (!query.trim()) { setSearching(false); return; }
    setSearching(true);
    const matches: SearchMatch[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => { timer = undefined; if (version === searchVersion) setSearchResults([...matches]); };
    try {
      const stream = api.searchStream(query, match => { if (version !== searchVersion) return; matches.push(match); if (!timer) timer = setTimeout(publish, 25); });
      activeSearch = stream;
      await stream.done;
      if (timer) clearTimeout(timer);
      publish();
    } catch (e) { if (version === searchVersion) report(e); }
    finally { if (version === searchVersion) { setSearching(false); activeSearch = undefined; } }
  }
  async function updateSettings(patch: Partial<Settings>) {
    try { const next = await api.updateSettings({ ...settings(), ...patch }); setSettings(next); } catch (e) { report(e); }
  }
  async function acceptAgentBuffer(path: string, snapshot?: BufferSnapshot) {
    const version = workspaceVersion;
    await writes.get(path);
    try {
      const result = await api.openBuffer(path);
      if (version !== workspaceVersion) return;
      if (writes.has(path)) { await writes.get(path); return acceptAgentBuffer(path, snapshot); }
      const latest = result.revision >= (snapshot?.revision ?? 0) ? result : snapshot!;
      if (latest.revision < (accepted.get(path)?.revision ?? 0)) return;
      if (pendingEdits.get(path)?.length || failed().has(path)) {
        const draft = documents()[path]?.document;
        if (draft) setPendingRecovery({ path, document: draft });
        pendingEdits.delete(path);
        setFailed(current => { const next = new Set(current); next.delete(path); return next; });
      }
      histories.delete(path);
      accepted.set(path, latest);
      setBuffers(path, latest);
      setDocuments(current => ({ ...current, [path]: { document: Text.of(latest.text.split("\n")) } }));
      await openFile(path);
    } catch (e) { report(e); }
  }
  function resolveRecovery(restore: boolean) {
    const recovery = pendingRecovery();
    if (!recovery) return;
    if (restore) {
      const previousDocument = documents()[recovery.path]?.document;
      if (previousDocument) {
        const changes = [{ from: 0, to: previousDocument.length, insert: recovery.document.toString() }];
        edit(recovery.path, { baseRevision: buffers[recovery.path].revision, changes, document: recovery.document, previousDocument, changeSet: ChangeSet.of(changes, previousDocument.length) });
      }
    }
    setPendingRecovery(undefined);
  }
  async function refreshBuffer(path: string) {
    if (dirty(path)) { setError("This file has unsaved changes. Save or close it before loading agent edits."); return; }
    try { const result = await api.openBuffer(path); accepted.set(path, result); setBuffers(path, result); setDocuments(current => ({ ...current, [path]: { document: Text.of(result.text.split("\n")) } })); } catch (e) { report(e); }
  }
  return { workspace, workspaceGeneration, directories, expanded, buffers, documents, synchronized, groups, activeGroup, setActiveGroup, files, settings, setSettings, pendingRecovery, resolveRecovery, acceptAgentBuffer, error, setError, busy, searching, searchResults, pendingClose, pendingWorkspace, setPendingWorkspace, failed, activePath, dirty, hasDirty, loadDirectory, toggleDirectory, openFile, openWorkspace, requestWorkspace, initialize, edit, applyHistory, save, closeTab, confirmClose, splitEditor, search, updateSettings, refreshBuffer };
}
export type Workbench = ReturnType<typeof createWorkbench>;
