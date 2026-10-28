/** Scheduling stays independent of IPC. The workbench owns edit flushing and disk writes. */
import type { AutoSaveMode } from "../bindings";
export type { AutoSaveMode } from "../bindings";
export type AutoSaveBuffer = { path: string; revision: number; dirty: boolean; eligible?: boolean };
export type AutoSaveSnapshot = { generation: number; mode: AutoSaveMode; delay: number; buffers: readonly AutoSaveBuffer[]; paused?: boolean };
export type AutoSaveFailure = { path: string; revision: number; message: string; retryAfter: number };
type Entry = { revision: number; timer?: ReturnType<typeof setTimeout>; attempted?: number; failures: number; failure?: AutoSaveFailure };

export function createAutoSaveController(options: {
  read: () => AutoSaveSnapshot;
  save: (path: string, generation: number) => Promise<boolean>;
  onFailures?: (failures: readonly AutoSaveFailure[]) => void;
}) {
  const entries = new Map<string, Entry>();
  const queued = new Map<string, { generation: number; revision: number }>();
  let generation = options.read().generation;
  let configuration = "";
  let running = false;
  let disposed = false;
  const eligible = (buffer: AutoSaveBuffer) => buffer.dirty && buffer.eligible !== false && !buffer.path.startsWith("settings://") && !/(^|\/)(\.span\/settings\.jsonc?|\.vscode\/settings\.json)$/.test(buffer.path) && buffer.path !== "span:settings";
  const publish = () => options.onFailures?.([...entries.values()].flatMap(entry => entry.failure ? [entry.failure] : []));
  const cancelTimer = (entry: Entry) => { if (entry.timer !== undefined) clearTimeout(entry.timer); entry.timer = undefined; };
  const current = (path: string, expectedGeneration: number, revision: number) => {
    const snapshot = options.read();
    return !disposed && !snapshot.paused && snapshot.generation === expectedGeneration && snapshot.mode !== "off" && snapshot.buffers.some(buffer => buffer.path === path && buffer.revision === revision && eligible(buffer));
  };

  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (queued.size && !disposed) {
        const [path, request] = queued.entries().next().value!;
        queued.delete(path);
        const entry = entries.get(path);
        if (!entry || entry.attempted === request.revision || !current(path, request.generation, request.revision)) continue;
        entry.attempted = request.revision;
        let message = "Auto Save could not save this file. Save manually to review the error.";
        let saved = false;
        try { saved = await options.save(path, request.generation); }
        catch (error) { if (error instanceof Error) message = error.message; else if (typeof error === "string") message = error; }
        // An old operation cannot alter failure state in a new workspace or reopened buffer.
        if (disposed || options.read().generation !== request.generation || generation !== request.generation || entries.get(path) !== entry) continue;
        if (saved) { entry.failures = 0; entry.failure = undefined; }
        else {
          entry.failures++;
          entry.failure = { path, revision: request.revision, message, retryAfter: Date.now() + Math.min(30000, 1000 * 2 ** (entry.failures - 1)) };
        }
        publish();
        sync();
      }
    } finally { running = false; }
  }

  function enqueue(path: string, entry: Entry) {
    cancelTimer(entry);
    if (entry.attempted === entry.revision || !current(path, generation, entry.revision)) return;
    const remaining = (entry.failure?.retryAfter ?? 0) - Date.now();
    if (remaining > 0) { entry.timer = setTimeout(() => { entry.timer = undefined; enqueue(path, entry); }, remaining); return; }
    queued.set(path, { generation, revision: entry.revision });
    void drain();
  }

  function sync() {
    if (disposed) return;
    const snapshot = options.read();
    const nextConfiguration = `${snapshot.mode}:${snapshot.delay}:${!!snapshot.paused}`;
    if (snapshot.generation !== generation || nextConfiguration !== configuration) {
      for (const entry of entries.values()) cancelTimer(entry);
      queued.clear();
      if (snapshot.generation !== generation) { entries.clear(); generation = snapshot.generation; publish(); }
      configuration = nextConfiguration;
    }
    const dirty = new Set(snapshot.buffers.filter(eligible).map(buffer => buffer.path));
    let removed = false;
    for (const [path, entry] of entries) {
      if (!dirty.has(path)) { cancelTimer(entry); entries.delete(path); queued.delete(path); removed = true; }
    }
    if (removed) publish();
    for (const buffer of snapshot.buffers) {
      if (!eligible(buffer)) continue;
      let entry = entries.get(buffer.path);
      if (!entry) { entry = { revision: buffer.revision, failures: 0 }; entries.set(buffer.path, entry); }
      else if (entry.revision !== buffer.revision) { cancelTimer(entry); queued.delete(buffer.path); entry.revision = buffer.revision; }
      if (!snapshot.paused && snapshot.mode === "afterDelay" && entry.timer === undefined && entry.attempted !== entry.revision) {
        const delay = Math.max(0, Number.isFinite(snapshot.delay) ? snapshot.delay : 1000, (entry.failure?.retryAfter ?? 0) - Date.now());
        const pending = entry;
        entry.timer = setTimeout(() => { pending.timer = undefined; enqueue(buffer.path, pending); }, delay);
      }
    }
  }

  function editorBlur(path: string) {
    sync();
    if (options.read().mode === "onFocusChange") { const entry = entries.get(path); if (entry) enqueue(path, entry); }
  }
  function windowBlur() {
    sync();
    if (!["onFocusChange", "onWindowChange"].includes(options.read().mode)) return;
    for (const [path, entry] of entries) enqueue(path, entry);
  }
  function dispose() {
    disposed = true;
    for (const entry of entries.values()) cancelTimer(entry);
    entries.clear(); queued.clear(); publish();
  }
  return { sync, editorBlur, windowBlur, dispose };
}
