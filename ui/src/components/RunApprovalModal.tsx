import { For, Show, createUniqueId, createEffect, createSignal, on } from "solid-js";
import type { RunApprovalRequest } from "../bindings";
import { Modal } from "./Modal";
import { MenuIcon } from "./Icon";
import type { RunApprovals } from "../stores/run-approvals";
import "../styles/run-configurations.css";

export function RunToolsPreference(props: { approvals: RunApprovals; available: boolean }) {
  const id = `run-tools-help-${createUniqueId()}`;
  return <section class="run-tools-preference" aria-label="Agent run tools"><div><h3>Agent run tools</h3><p id={id}>Allow agents to request configuration changes and process actions. Changes and process actions require your approval. Agents can read run output. User preference. Enabling applies to new conversations; turning off immediately blocks existing conversations and cancels pending requests.</p></div><button role="switch" aria-label="Allow agents to request run tools" aria-describedby={id} aria-checked={props.approvals.enabled()} disabled={!props.available || !props.approvals.loaded() || props.approvals.busy()} onClick={() => void props.approvals.setAllowed(!props.approvals.enabled())}><span /></button><Show when={props.approvals.error()}><p class="run-error" role="alert">{props.approvals.error()}</p></Show></section>;
}
export function RunApprovalModal(props: { request: RunApprovalRequest; busy: boolean; error?: string; queued: number; onResolve: (id: string, allow: boolean) => void }) {
  const rejectId = `run-reject-${createUniqueId()}`;
  const [revealed, setRevealed] = createSignal(new Set<string>());
  createEffect(on(() => props.request.id, () => setRevealed(new Set<string>())));
  createEffect(() => { props.request.id; if (!props.busy) queueMicrotask(() => document.getElementById(rejectId)?.focus()); });
  const verbs: Record<string, string> = { save: "Save configuration", delete: "Delete configuration", run: "Run configuration", stop: "Stop process", restart: "Restart process" };
  return <Modal label="Agent run tool approval" class="run-approval-modal" initialFocus={`#${rejectId}`} busy={props.busy} onClose={() => props.onResolve(props.request.id, false)}>
    <div class="run-review"><div class="run-approval-heading"><MenuIcon name="file" size={18} /><h3>{verbs[props.request.action] || "Run tool request"}</h3></div><p><strong>{props.request.agentName}</strong> requests an action for <strong>{props.request.name}</strong>.</p>
      <dl class="run-approval-details"><dt>{props.request.executionResolved ? "Exact executable" : "Executable"}</dt><dd><code>{props.request.executable || "Not applicable"}</code></dd><dt>Arguments</dt><dd><code>{JSON.stringify(props.request.args)}</code></dd><dt>Working directory</dt><dd><code>{props.request.cwd || "."}</code></dd><dt>Environment keys</dt><dd>{props.request.envKeys.length ? props.request.envKeys.join(", ") : "No overrides"}</dd><Show when={Object.keys(props.request.envReferences).length}><dt>Variable references</dt><dd><For each={Object.entries(props.request.envReferences)}>{([key, value]) => <div><code>{key} = {value}</code></div>}</For></dd></Show></dl>
      <Show when={Object.keys(props.request.envChanges).length}><section class="run-env-review" aria-label="Proposed environment changes"><strong>Proposed environment changes</strong><For each={Object.entries(props.request.envChanges)}>{([key, value]) => <div><code>{key}</code><Show when={value !== null} fallback={<span>Removed</span>}><Show when={revealed().has(key)} fallback={<button aria-label={`Reveal proposed environment value for ${key}`} onClick={() => setRevealed(previous => new Set([...previous, key]))}>Reveal value</button>}><code>{value}</code><button aria-label={`Hide proposed environment value for ${key}`} onClick={() => setRevealed(previous => { const next = new Set(previous); next.delete(key); return next; })}>Hide</button></Show></Show></div>}</For></section></Show>
      <p class="run-approval-note">{props.request.executionResolved ? "This is the exact execution command and working directory." : "Configuration references are resolved when launched."} Existing environment values are omitted. Proposed changes can be revealed above. The agent can read run output, including anything the command prints. Processes run with your account permissions.</p>
      <Show when={props.queued > 1}><p class="run-approval-note">{props.queued - 1} more {props.queued === 2 ? "request is" : "requests are"} waiting.</p></Show>
      <Show when={props.error}><p class="run-error" role="alert">{props.error}</p></Show>
      <div class="dialog-actions"><button id={rejectId} class="button" disabled={props.busy} onClick={() => props.onResolve(props.request.id, false)}><MenuIcon name="cancel" size={14} />Reject</button><button class="button primary" disabled={props.busy} onClick={() => props.onResolve(props.request.id, true)}><MenuIcon name="save" size={14} />Approve once</button></div>
    </div>
  </Modal>;
}
