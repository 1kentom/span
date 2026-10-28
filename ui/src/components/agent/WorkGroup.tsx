import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../Icon";
import type { ChangedFile, ChildStep, DiffLine, SearchMatch, StepDetail, StepImage, StepKind, StepView, TermLine } from "./types";

const KIND_ICON: Record<StepKind, string> = {
  read: "DocumentText",
  search: "SearchNormal1",
  edit: "Edit2",
  run: "u-terminal",
  fetch: "Global",
  think: "Lamp",
  other: "Code1",
};

export function StepGlyph(props: { kind: StepKind; status?: string; size?: number }) {
  return (
    <span class="sb-step-glyph" classList={{ failed: props.status === "failed" }} aria-hidden="true">
      <Show when={props.status === "in_progress"} fallback={<Icon name={KIND_ICON[props.kind]} size={props.size ?? 14} />}>
        <span class="sb-spinner" />
      </Show>
    </span>
  );
}

const signed = (value: number, sign: "+" | "-") => `${sign}${value}`;

export function Delta(props: { add: number; del: number }) {
  return (
    <span class="sb-delta sb-mono" aria-label={`${props.add} added, ${props.del} removed`}>
      <span class="add">{signed(props.add, "+")}</span>
      <span class="del">{signed(props.del, "-")}</span>
    </span>
  );
}

/** Shell output with the command, stdout and stderr lines, cwd and exit code. */
export function TerminalOutput(props: { lines: TermLine[]; cwd?: string; exitCode?: number | null; running?: boolean; onCopy?: () => void }) {
  return (
    <div class="sb-term">
      <div class="sb-term-body sb-mono" role="log" aria-label="Terminal output" tabIndex={0}>
        <For each={props.lines}>
          {(line) => (
            <div class={`sb-term-line ${line.kind}`}>
              <Show when={line.kind === "cmd"}><span class="sb-prompt">$ </span></Show>
              {line.text}
            </div>
          )}
        </For>
        <Show when={props.running}><div class="dim">…</div></Show>
      </div>
      <div class="sb-term-foot">
        <span class="sb-mono">{props.cwd}</span>
        <span class="sb-flex" />
        <Show when={props.exitCode !== undefined && props.exitCode !== null}>
          <span classList={{ "sb-bad-text": props.exitCode !== 0 }}>exit {props.exitCode}</span>
        </Show>
        <Show when={props.onCopy}>
          <button class="sb-icon-btn" aria-label="Copy command" onClick={() => props.onCopy?.()}><Icon name="Copy" size={12} /></button>
        </Show>
      </div>
    </div>
  );
}

const MARK = { add: "+ ", del: "- ", ctx: "  " } as const;

/** Unified diff with line numbers. The sign is text so it survives forced colours. */
export function DiffView(props: { path: string; lines: DiffLine[]; onOpen?: () => void }) {
  return (
    <div class="sb-diff">
      <div class="sb-diff-head sb-mono">
        <span class="sb-ellipsis sb-flex" title={props.path}>{props.path}</span>
        <Show when={props.onOpen}>
          <button class="sb-link" onClick={() => props.onOpen?.()}>Open in editor</button>
        </Show>
      </div>
      <div class="sb-diff-body sb-mono" role="region" aria-label={`Diff of ${props.path}`} tabIndex={0}>
        <For each={props.lines}>
          {(line) => (
            <div class={`sb-diff-line ${line.kind}`}>
              <span class="sb-diff-n">{line.n ?? ""}</span>
              <span class="sb-diff-text">{MARK[line.kind]}{line.text}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** Search hits as file:line and the matching text. */
export function SearchMatches(props: { matches: SearchMatch[]; onOpen?: (loc: string) => void }) {
  return (
    <ul class="sb-matches" aria-label="Search matches">
      <For each={props.matches}>
        {(match) => (
          <li class="sb-match sb-mono">
            <Show when={props.onOpen} fallback={<span class="loc">{match.loc}</span>}>
              <button class="loc sb-link" onClick={() => props.onOpen?.(match.loc)}>{match.loc}</button>
            </Show>
            <span class="sb-ellipsis dim">{match.text}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** Thumbnails of images a tool produced. Each opens the shared file viewer with the bytes the agent sent. */
function StepImages(props: { images: StepImage[] }) {
  return (
    <ul class="sb-step-images" aria-label="Images from this step">
      <For each={props.images}>
        {(image) => (
          <li>
            <Show when={image.onOpen} fallback={<img class="sb-thumb" src={image.src} alt={image.name} />}>
              <button type="button" class="sb-thumb-btn" aria-label={`Open ${image.name}`} onClick={() => image.onOpen?.()}>
                <img class="sb-thumb" src={image.src} alt="" />
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

function ChildRows(props: { children: ChildStep[] }) {
  return (
    <ul class="sb-children">
      <For each={props.children}>
        {(child) => (
          <li class="sb-child">
            <StepGlyph kind={child.kind} size={12} />
            <span class="sb-child-verb">{child.verb}</span>
            <span class="sb-mono dim sb-ellipsis sb-flex">{child.target}</span>
            <Show when={child.meta}><span class="sb-sub nowrap">{child.meta}</span></Show>
          </li>
        )}
      </For>
    </ul>
  );
}

function Detail(props: { detail: StepDetail }) {
  const d = () => props.detail;
  return (
    <div class="sb-detail">
      {(() => {
        const detail = d();
        if (detail.type === "terminal") return <TerminalOutput lines={detail.lines} cwd={detail.cwd} exitCode={detail.exitCode} running={detail.running} />;
        if (detail.type === "diff") return <DiffView path={detail.path} lines={detail.lines} onOpen={detail.onOpen} />;
        return <SearchMatches matches={detail.matches} />;
      })()}
    </div>
  );
}

/** One tool step. The row toggles its detail when it has any. */
export function StepRow(props: { step: StepView; open?: boolean; onToggle?: () => void }) {
  const expandable = () => Boolean(props.step.detail);
  return (
    <div class="sb-step">
      <Show
        when={expandable()}
        fallback={
          <div class="sb-step-row" title={props.step.target}>
            <StepRowBody step={props.step} />
          </div>
        }
      >
        <button class="sb-step-row" title={props.step.target} aria-expanded={Boolean(props.open)} onClick={() => props.onToggle?.()}>
          <StepRowBody step={props.step} />
        </button>
      </Show>
      <Show when={props.step.note}><div class="sb-step-note sb-sub">{props.step.note}</div></Show>
      <Show when={props.open && props.step.detail}><Detail detail={props.step.detail!} /></Show>
      <Show when={props.step.images?.length}><StepImages images={props.step.images!} /></Show>
      <Show when={props.step.savedPath}>
        <div class="sb-step-saved sb-sub">
          <span>Saved by the agent at </span>
          <span class="sb-mono" title={props.step.savedPath}>{props.step.savedPath}</span>
          <span>. Span shows this path only and does not open it.</span>
        </div>
      </Show>
      <Show when={props.step.children?.length}><ChildRows children={props.step.children!} /></Show>
    </div>
  );
}

function StepRowBody(props: { step: StepView }) {
  return (
    <>
      <StepGlyph kind={props.step.kind} status={props.step.status} />
      <span class="sb-step-verb">{props.step.verb}</span>
      <Show when={props.step.onOpen && !props.step.detail} fallback={<span class="sb-step-target sb-mono">{props.step.target}</span>}>
        <button type="button" class="sb-step-target sb-mono sb-link" aria-label={`Open ${props.step.target} in the editor`} onClick={() => props.step.onOpen?.()}>{props.step.target}</button>
      </Show>
      <Show when={props.step.delta}><Delta add={props.step.delta!.add} del={props.step.delta!.del} /></Show>
      <Show when={props.step.meta}><span class="sb-sub nowrap">{props.step.meta}</span></Show>
      <Show when={props.step.status === "failed"}><span class="sb-bad-text nowrap sb-small">Failed</span></Show>
    </>
  );
}

export type StepSegment = { type: "step"; step: StepView } | { type: "internal"; key: string; steps: StepView[] };

/** Runs of consecutive internal steps collapse into one segment. Order is kept. */
export function groupInternal(steps: readonly StepView[]): StepSegment[] {
  const out: StepSegment[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (!step.internal) out.push({ type: "step", step });
    else if (last?.type === "internal") last.steps.push(step);
    else out.push({ type: "internal", key: `internal-${step.id}`, steps: [step] });
  }
  return out;
}

type WorkGroupProps = {
  headline: string;
  counts?: string;
  steps: StepView[];
  defaultOpen?: boolean;
  /** Step ids shown expanded at the start. */
  defaultExpanded?: string[];
};

/** A run of tool steps collapsed under one summary line. */
export function WorkGroup(props: WorkGroupProps) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? true);
  const [expanded, setExpanded] = createSignal(new Set(props.defaultExpanded ?? []));
  const failures = () => props.steps.filter((step) => step.status === "failed").length;
  const [internalOpen, setInternalOpen] = createSignal(new Set<string>());
  const segments = createMemo(() => groupInternal(props.steps));
  const toggleInternal = (key: string) => {
    const next = new Set(internalOpen());
    if (!next.delete(key)) next.add(key);
    setInternalOpen(next);
  };
  const toggle = (id: string) => {
    const next = new Set(expanded());
    if (!next.delete(id)) next.add(id);
    setExpanded(next);
  };
  return (
    <section class="sb-work" aria-label={props.headline}>
      <button class="sb-work-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon name={open() ? "arrow-down4" : "arrow-right4"} size={9} />
        <span class="sb-work-headline nowrap">{props.headline}</span>
        <Show when={props.counts}><span class="sb-ellipsis">{props.counts}</span></Show>
        <Show when={failures()}><span class="sb-bad-text nowrap">· {failures()} failed</span></Show>
      </button>
      <Show when={open()}>
        <div class="sb-steps">
          <For each={segments()}>
            {(segment) =>
              segment.type === "step" ? (
                <StepRow step={segment.step} open={expanded().has(segment.step.id)} onToggle={() => toggle(segment.step.id)} />
              ) : (
                <div class="sb-internal">
                  <button class="sb-step-row sb-internal-row" aria-expanded={internalOpen().has(segment.key)} onClick={() => toggleInternal(segment.key)}>
                    <Icon name={internalOpen().has(segment.key) ? "arrow-down4" : "arrow-right4"} size={9} />
                    <span class="sb-sub">Agent housekeeping ({segment.steps.length})</span>
                  </button>
                  <Show when={internalOpen().has(segment.key)}>
                    <div class="sb-internal-steps">
                      <For each={segment.steps}>{(step) => <StepRow step={step} open={expanded().has(step.id)} onToggle={() => toggle(step.id)} />}</For>
                    </div>
                  </Show>
                </div>
              )
            }
          </For>
        </div>
      </Show>
    </section>
  );
}

type ChangesCardProps = {
  headline: string;
  files: ChangedFile[];
  stateText?: string;
  /** Buttons render only for the callbacks the app supplies. */
  onReview?: () => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onAccept?: (path: string) => void;
  onReject?: (path: string) => void;
  onOpen?: (path: string) => void;
};

/** Files changed in a turn with +/- counts and optional accept or reject actions. */
export function ChangesCard(props: ChangesCardProps) {
  const total = () => props.files.reduce((sum, file) => ({ add: sum.add + file.add, del: sum.del + file.del }), { add: 0, del: 0 });
  const pending = () => props.files.some((file) => file.state === "pending");
  return (
    <section class="sb-card" aria-label={props.headline}>
      <div class="sb-changes-head">
        <span class="sb-card-title">{props.headline}</span>
        <Delta add={total().add} del={total().del} />
        <span class="sb-flex" />
        <Show when={props.stateText}><span class="sb-sub">{props.stateText}</span></Show>
      </div>
      <ul class="sb-changes">
        <For each={props.files}>
          {(file) => (
            <li class="sb-change">
              <Show when={props.onOpen} fallback={<span class="sb-change-name">{file.name}</span>}>
                <button class="sb-change-name sb-plain" onClick={() => props.onOpen?.(file.path)}>{file.name}</button>
              </Show>
              <span class="sb-sub sb-ellipsis sb-flex">{file.dir}</span>
              <Delta add={file.add} del={file.del} />
              <Show when={file.state === "pending" && (props.onAccept || props.onReject)}>
                <span class="sb-change-actions">
                  <Show when={props.onReject}>
                    <button class="sb-icon-btn" aria-label={`Reject ${file.name}`} onClick={() => props.onReject?.(file.path)}><Icon name="CloseCircle" size={11} /></button>
                  </Show>
                  <Show when={props.onAccept}>
                    <button class="sb-icon-btn" aria-label={`Accept ${file.name}`} onClick={() => props.onAccept?.(file.path)}><Icon name="TickCircle" size={12} /></button>
                  </Show>
                </span>
              </Show>
              <Show when={file.state !== "pending"}><span class="sb-sub nowrap">{file.state}</span></Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={pending() && (props.onReview || props.onAcceptAll || props.onRejectAll)}>
        <div class="sb-changes-foot">
          <Show when={props.onReview}><button class="sb-btn" onClick={() => props.onReview?.()}>Review</button></Show>
          <span class="sb-flex" />
          <Show when={props.onRejectAll}><button class="sb-btn" onClick={() => props.onRejectAll?.()}>Reject all</button></Show>
          <Show when={props.onAcceptAll}><button class="sb-btn primary" onClick={() => props.onAcceptAll?.()}>Accept all</button></Show>
        </div>
      </Show>
    </section>
  );
}
