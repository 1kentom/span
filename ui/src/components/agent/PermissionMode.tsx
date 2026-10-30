import { For, Show, createSignal } from "solid-js";
import type { ThreadPermissionMode } from "../../bindings";
import type { AgentState } from "../../lib/agent-session";
import { FULL_ACCESS_WARNING, PERMISSION_MODES, modeInfo, policyRowText, unsupportedReason } from "../../lib/permission-modes";
import { Icon } from "../Icon";

type SpanMode = NonNullable<AgentState["permissionMode"]>;

/**
 * The Span permission modes at the top of the mode popover (ADR 0015): label, one line description and a risk label
 * per mode. Full access has the warning treatment; a mode the session cannot run in is disabled with the reason.
 */
export function SpanModeSection(props: { mode: SpanMode; busy?: boolean; onSelect: (mode: ThreadPermissionMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Permissions" class="sb-perm-modes">
      <div class="sb-eyebrow">Permissions <span class="sb-perm-key" aria-label="Shift Tab cycles Ask, Accept edits and Plan">⇧⇥</span></div>
      <For each={PERMISSION_MODES}>
        {(info) => {
          const supported = () => props.mode.supported.includes(info.mode);
          const current = () => props.mode.mode === info.mode;
          const reason = () => (supported() ? undefined : unsupportedReason(info.mode, props.mode.child));
          return (
            <button
              class="sb-option sb-perm-option"
              classList={{ danger: info.danger }}
              role="radio"
              aria-checked={current()}
              disabled={props.busy || !supported()}
              title={reason()}
              data-mode={info.mode}
              onClick={() => props.onSelect(info.mode)}
            >
              <span class={`sb-option-lead${info.danger ? " warn" : ""}`}><Icon name={info.icon} size={16} /></span>
              <span class="sb-option-text">
                <span class="sb-option-name">
                  {info.label}
                  <span class="sb-perm-risk" classList={{ warn: info.danger }}>{info.risk}</span>
                </span>
                <span class="sb-sub wrap">{reason() ?? info.description}</span>
              </span>
              <Show when={current()}><Icon name="TickCircle" size={14} class="sb-accent" /></Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}

/** Asked the first time a thread is switched to Full access. */
export function FullAccessConfirm(props: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div class="sb-confirm sb-perm-confirm" role="alertdialog" aria-label="Allow full access" onKeyDown={(event) => event.key === "Escape" && props.onCancel()}>
      <Icon name="Warning2" size={13} class="sb-glyph warn" />
      <span class="sb-confirm-text">{FULL_ACCESS_WARNING}. Span still logs each action.</span>
      <button class="sb-btn" onClick={props.onCancel}>Cancel</button>
      <button class="sb-btn danger" ref={(el) => queueMicrotask(() => el.focus())} onClick={props.onConfirm}>Allow full access</button>
    </div>
  );
}

/**
 * The agent reports another mode than the thread's Span mode needs. Span keeps answering requests by the thread's
 * mode and has asked the agent once to switch back; the banner stays until the agent reports the right mode.
 */
export function ModeMismatchBanner(props: { agent: string; mismatch: NonNullable<AgentState["modeMismatch"]>; busy?: boolean; onRetry: () => void }) {
  const label = () => modeInfo(props.mismatch.mode).label;
  return (
    <div class="sb-card alert warn sb-perm-mismatch" role="alert">
      <div class="sb-alert-head">
        <Icon name="Warning2" size={14} class="sb-glyph warn" />
        <span class="sb-alert-text">
          <span class="sb-card-title">{`${props.agent} switched its mode to ${props.mismatch.actual || "another mode"}`}</span>
          <span class="sb-body">{`This thread is in ${label()}, which needs ${props.mismatch.expected}. Span still answers by ${label()}, but actions the agent no longer asks about cannot be checked.`}</span>
        </span>
      </div>
      <div class="sb-actions">
        <button class="sb-btn primary" disabled={props.busy} onClick={props.onRetry}>{`Set ${label()} again`}</button>
      </div>
    </div>
  );
}

/** One muted line for a request Span answered itself: "Blocked in Plan mode: Edit a.rs", or allowed with the reason. */
export function PolicyRow(props: { item: { decision: string; reason: string; title: string } }) {
  const text = () => policyRowText(props.item.decision, props.item.reason, props.item.title);
  const blocked = () => props.item.decision === "rejected";
  return (
    <div class="sb-perm-row" classList={{ blocked: blocked() }} data-decision={props.item.decision} title={text()}>
      <Icon name={blocked() ? "ModePlan" : props.item.reason === "full_access" ? "ModeDanger" : "TickCircle"} size={12} />
      <span class="sb-ellipsis">{text()}</span>
    </div>
  );
}

/** The plan the agent wrote in Plan mode, with Implement plan (then Accept edits or Ask) and Refine plan. */
export function PlanReadyCard(props: {
  plan: string;
  status: "ready" | "implementing" | "refining";
  /** Only the latest card acts, and only while the agent is idle. */
  active: boolean;
  supported: readonly ThreadPermissionMode[];
  renderPlan: (text: string) => unknown;
  onImplement: (mode: "acceptEdits" | "ask") => void;
  onRefine: () => void;
}) {
  const [then, setThen] = createSignal<"acceptEdits" | "ask">(props.supported.includes("acceptEdits") ? "acceptEdits" : "ask");
  return (
    <section class="sb-card sb-plan-ready" aria-label="Plan ready">
      <div class="sb-alert-head">
        <Icon name="ModePlan" size={14} class="sb-accent" />
        <span class="sb-card-title sb-flex">Plan ready</span>
        <Show when={props.status !== "ready"}>
          <span class="sb-sub">{props.status === "implementing" ? "Implementing" : "Refining"}</span>
        </Show>
      </div>
      <Show when={props.plan.trim()}>
        <div class="sb-plan-body">{props.renderPlan(props.plan) as never}</div>
      </Show>
      <Show when={props.active && props.status === "ready"}>
        <div class="sb-plan-then" role="radiogroup" aria-label="After the plan">
          <span class="sb-sub">Then</span>
          <button role="radio" class="sb-chip" aria-checked={then() === "acceptEdits"} disabled={!props.supported.includes("acceptEdits")} onClick={() => setThen("acceptEdits")}>Accept edits</button>
          <button role="radio" class="sb-chip" aria-checked={then() === "ask"} onClick={() => setThen("ask")}>Ask every time</button>
        </div>
        <div class="sb-actions">
          <button class="sb-btn" onClick={props.onRefine}>Refine plan</button>
          <button class="sb-btn primary" onClick={() => props.onImplement(then())}>Implement plan</button>
        </div>
      </Show>
    </section>
  );
}
