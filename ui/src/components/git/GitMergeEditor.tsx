import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { GitConflictResource } from "../../bindings";
import Icon from "../Icon";
import "../../styles/git-review.css";

export type MergeConflict = { start: number; end: number; ours: string; theirs: string; base?: string };
/** Parse complete standard or diff3 marker blocks. Malformed markers remain editable. */
export function mergeConflicts(text: string): MergeConflict[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const result: MergeConflict[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{7}(?: |\r?\n|$)/.test(lines[i])) { offset += lines[i].length; continue; }
    const start = offset; let divider = -1, ancestor = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^<{7}(?: |\r?\n|$)/.test(lines[j])) break;
      if (/^\|{7}(?: |\r?\n|$)/.test(lines[j])) ancestor = j;
      if (/^={7}\r?\n?$/.test(lines[j])) divider = j;
      if (/^>{7}(?: |\r?\n|$)/.test(lines[j])) { end = j; break; }
    }
    if (divider < 0 || end < divider || (ancestor >= 0 && ancestor > divider)) { offset += lines[i].length; continue; }
    const endOffset = start + lines.slice(i, end + 1).join("").length;
    result.push({ start, end: endOffset, ours: lines.slice(i + 1, ancestor >= 0 ? ancestor : divider).join(""), theirs: lines.slice(divider + 1, end).join(""), ...(ancestor >= 0 ? { base: lines.slice(ancestor + 1, divider).join("") } : {}) });
    offset = endOffset; i = end;
  }
  return result;
}
export function acceptMergeChoice(text: string, conflict: MergeConflict, choice: "ours" | "theirs" | "both"): string {
  return text.slice(0, conflict.start) + (choice === "ours" ? conflict.ours : choice === "theirs" ? conflict.theirs : conflict.ours + conflict.theirs) + text.slice(conflict.end);
}
export type GitMergeEditorProps = {
  path: string; resource?: GitConflictResource; loading: boolean; error?: string; saving?: boolean; resolving?: boolean;
  onRefresh(): void; onSave(content: string, reviewed?: GitConflictResource): Promise<unknown>; onDirtyChange?(dirty: boolean): void; onSaveReady?(save: (() => Promise<boolean>) | undefined): void; onMarkResolved(reviewed?: GitConflictResource): Promise<unknown>;
};
export function GitMergeEditor(props: GitMergeEditorProps) {
  const drafts = new Map<string, { text: string; saved: string; reviewed?: GitConflictResource }>();
  const [text, setText] = createSignal(""); const [saved, setSaved] = createSignal("");
  const [reviewed, setReviewed] = createSignal<GitConflictResource>();
  const [selected, setSelected] = createSignal(0); const [localError, setLocalError] = createSignal("");
  let activePath = "", resultInput: HTMLTextAreaElement | undefined;
  createEffect(on(() => [props.path, props.resource] as const, ([path, resource]) => {
    if (activePath && activePath !== path) {
      if (text() !== saved()) drafts.set(activePath, { text: text(), saved: saved(), reviewed: reviewed() });
      else drafts.delete(activePath);
    }
    const draft = drafts.get(path);
    if (activePath !== path) {
      activePath = path; setText(draft?.text || ""); setSaved(draft?.saved || ""); setReviewed(draft?.reviewed); setSelected(0); setLocalError("");
    }
    if (resource?.path === path && !draft && text() === saved()) { setText(resource.working); setSaved(resource.working); setReviewed(resource); }
  }));
  const conflicts = createMemo(() => mergeConflicts(text()));
  const current = () => conflicts()[Math.min(selected(), Math.max(0, conflicts().length - 1))];
  const dirty = () => text() !== saved();
  const busy = () => props.loading || props.saving || props.resolving;
  const editable = () => reviewed()?.path === props.path && text().length <= 2_000_000;
  const navigate = (step: number) => {
    const next = Math.max(0, Math.min(conflicts().length - 1, selected() + step)); setSelected(next);
    const conflict = conflicts()[next]; if (conflict && resultInput) { resultInput.focus(); resultInput.setSelectionRange(conflict.start, conflict.end); }
  };
  const save = async (): Promise<boolean> => {
    if (!dirty()) return drafts.size === 0;
    if (!editable() || busy()) return false;
    const content = text(), path = props.path, snapshot = reviewed(); setLocalError("");
    try {
      const result = await props.onSave(content, snapshot);
      if (result === false) throw new Error("Resolution was not saved. Refresh sources and review before retrying.");
      drafts.delete(path);
      if (props.path === path) {
        setSaved(content);
        const refreshed = props.resource;
        if (refreshed?.path === path && refreshed.working === content) setReviewed(refreshed);
      }
      return drafts.size === 0;
    } catch (error) { if (props.path === path) setLocalError(String(error)); return false; }
  };
  createEffect(() => props.onDirtyChange?.(dirty() || drafts.size > 0));
  createEffect(() => props.onSaveReady?.(save));
  onCleanup(() => { props.onSaveReady?.(undefined); props.onDirtyChange?.(false); });
  const resolve = async () => { setLocalError(""); try { const result = await props.onMarkResolved(reviewed()); if (result === false) throw new Error("The saved resolution could not be staged."); } catch (error) { setLocalError(String(error)); } };
  return <section class="git-merge-editor" aria-label="Three-way conflict editor" aria-busy={busy()}>
    <header class="git-diff-header"><div><strong>{props.path}</strong><span>Three-way merge · Saved disk snapshots</span></div><button class="button" disabled={busy()} onClick={props.onRefresh}>Refresh sources</button></header>
    <p class="git-note">Review all three sources and edit the result. Save writes the working file. Mark resolved stages the saved resolution.</p>
    <Show when={props.error || localError()}><p class="git-error" role="alert">{props.error || localError()} Your draft is retained.</p></Show>
    <Show when={!props.resource}><p class="git-empty">{props.loading ? "Loading conflict sources…" : "Conflict sources unavailable. Binary, oversized, and unsupported conflicts require an external merge tool."}</p></Show>
    <Show when={reviewed()?.path === props.path}><>
      <Show when={dirty() && props.resource && props.resource !== reviewed()}><p class="git-note" role="status">Refreshed sources are available. This draft still uses its original review snapshot.</p><button class="button" disabled={busy()} onClick={() => { setReviewed(props.resource); setLocalError(""); }}>Review refreshed sources and use their snapshot</button></Show>
      <div class="git-merge-sources"><For each={[{ label: "Base", value: reviewed()!.base }, { label: "Current (ours)", value: reviewed()!.ours }, { label: "Incoming (theirs)", value: reviewed()!.theirs }]}>{source => <section><h3>{source.label}</h3><Show when={source.value !== null} fallback={<p class="git-note">File absent on this side (addition or deletion).</p>}><pre tabIndex={0} aria-label={`${source.label} source`}>{source.value || "Empty file"}</pre></Show></section>}</For></div>
      <div class="git-review-toolbar" role="toolbar" aria-label="Conflict choices">
        <button class="icon-button" aria-label="Previous conflict" disabled={!conflicts().length || selected() <= 0} onClick={() => navigate(-1)}><Icon name="arrow-left4" /></button>
        <span role="status">{conflicts().length ? `Conflict ${Math.min(selected() + 1, conflicts().length)} of ${conflicts().length}` : "No complete conflict markers"}</span>
        <button class="icon-button" aria-label="Next conflict" disabled={selected() >= conflicts().length - 1} onClick={() => navigate(1)}><Icon name="arrow-right4" /></button>
        <For each={["ours", "theirs", "both"] as const}>{choice => <button class="button" disabled={!current() || !editable() || busy()} onClick={() => { const block = current(); if (block) setText(acceptMergeChoice(text(), block, choice)); }}>Accept {choice === "ours" ? "current" : choice === "theirs" ? "incoming" : "both"}</button>}</For>
      </div>
      <label class="git-merge-result-label" for="git-merge-result">Result {dirty() ? "· Unsaved draft" : "· Saved"}</label>
      <textarea id="git-merge-result" ref={resultInput} class="git-merge-result" spellcheck={false} value={text()} disabled={!editable() || !!props.saving || !!props.resolving} onInput={event => setText(event.currentTarget.value)} />
      <div class="git-review-toolbar"><button class="button" disabled={!editable() || !dirty() || busy()} onClick={() => void save()}>{props.saving ? "Saving…" : "Save resolution"}</button><button class="button" disabled={!editable() || dirty() || busy() || conflicts().length > 0 || /^(<{7}|={7}|>{7}|\|{7})/m.test(text())} onClick={() => void resolve()}>{props.resolving ? "Marking resolved…" : "Mark resolved"}</button><span class="git-note">{conflicts().length ? "Resolve remaining markers before staging." : "Review the complete result before marking resolved."}</span></div>
    </></Show>
  </section>;
}
