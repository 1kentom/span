import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { hunkLines, restoreConfirmText, turnSummary, type CheckpointStore } from "../../lib/checkpoints";
import { Icon, MenuIcon } from "../Icon";
import { Modal } from "../Modal";
import "../../styles/checkpoints.css";

const leaf = (path: string) => path.split("/").pop() || path;
const dir = (path: string) => path.split("/").slice(0, -1).join("/");

function Delta(props: { add: number; del: number }) {
  return (
    <span class="cp-delta sb-mono" aria-label={`${props.add} added, ${props.del} removed`}>
      <span class="add">+{props.add}</span>
      <span class="del">-{props.del}</span>
    </span>
  );
}

/**
 * Changes on disk recorded by turn checkpoints (ADR 0013), for any agent, including those that write files directly.
 * Accepting is implicit (the change is already on disk); Revert puts the pre-turn text back. Renders nothing when the
 * folder has no checkpoints, except a quiet unavailable line where `showUnavailable` is set.
 */
export function CheckpointChanges(props: { store: CheckpointStore; running: boolean; onOpenFile: (path: string) => void; showUnavailable?: boolean }) {
  const s = props.store;
  const files = () => s.changes()?.files ?? [];
  const total = () => files().reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), { add: 0, del: 0 });
  const unavailable = () => s.status() && !s.status()!.available;
  return (
    <>
      <Show when={unavailable() && props.showUnavailable}>
        <div class="cp-unavailable" role="note">
          <span>{s.status()?.reason ?? "Checkpoints are unavailable here."}</span>
          <Show when={s.status()?.canInit}>
            <button type="button" class="ap-btn small" disabled={s.busy()} onClick={() => void s.enable()}>
              Enable checkpoints (git init)
            </button>
          </Show>
        </div>
      </Show>
      <Show when={!unavailable() && s.turns().length}>
        <section class="cp-changes" aria-label="Changes on disk">
          <div class="cp-head">
            <div class="cp-filter" role="radiogroup" aria-label="Show changes from">
              <button type="button" role="radio" aria-checked={s.filter() === "all"} classList={{ on: s.filter() === "all" }} onClick={() => s.showAll()}>
                All turns
              </button>
              <button type="button" role="radio" aria-checked={s.filter() === "turn"} classList={{ on: s.filter() === "turn" }} onClick={() => s.focusTurn() !== undefined && s.viewTurn(s.focusTurn()!)}>
                {s.filter() === "turn" && s.focusTurn() !== undefined ? `Turn ${s.focusTurn()}` : "This turn"}
              </button>
            </div>
            <Delta add={total().add} del={total().del} />
            <span class="ap-grow" />
            <Show when={files().length}>
              <button type="button" class="ap-btn small ghost" disabled={s.busy()} onClick={() => void s.revertAll()}>
                <MenuIcon name="reset" size={11} />
                Revert all
              </button>
            </Show>
          </div>
          <Show when={s.notice()}>
            <p class="cp-notice" role="alert">
              <span>{s.notice()}</span>
              <button type="button" class="ap-icon-btn" aria-label="Dismiss" onClick={() => s.clearNotice()}>
                <Icon name="CloseCircle" size={12} />
              </button>
            </p>
          </Show>
          <Show
            when={files().length}
            fallback={
              <p class="ap-fine">
                {props.running && s.filter() === "turn" ? "This turn is still running. Its changes show here when it ends." : "No files changed on disk in these turns."}
              </p>
            }
          >
            <ul class="cp-files">
              <For each={files()}>
                {(file) => (
                  <li class="cp-file" data-kind={file.kind}>
                    <div class="cp-file-head">
                      <span class="cp-file-name sb-mono" title={file.path}>{leaf(file.path)}</span>
                      <span class="cp-file-dir sb-ellipsis">{dir(file.path)}</span>
                      <Show when={file.kind !== "modified"}>
                        <span class="cp-file-kind">{file.kind}</span>
                      </Show>
                      <Delta add={file.additions} del={file.deletions} />
                      <span class="ap-grow" />
                      <Show when={file.kind !== "deleted"}>
                        <button type="button" class="sb-link" onClick={() => props.onOpenFile(file.path)}>
                          Open in editor
                        </button>
                      </Show>
                      <button type="button" class="ap-btn small ghost" aria-label={`Revert ${file.path}`} disabled={s.busy()} onClick={() => void s.revertFile(file.path)}>
                        Revert file
                      </button>
                    </div>
                    <Show when={file.binary}>
                      <p class="ap-fine">Binary or large file: only the whole file can be reverted.</p>
                    </Show>
                    <For each={file.kind === "modified" ? file.hunks : []}>
                      {(hunk, index) => (
                        <div class="cp-hunk">
                          <div class="cp-hunk-head">
                            <span class="cp-hunk-label">Change {index() + 1}</span>
                            <span class="ap-grow" />
                            <button type="button" class="ap-btn small ghost" aria-label={`Revert change ${index() + 1} in ${file.path}`} disabled={s.busy()} onClick={() => void s.revertHunk(file.path, hunk.id)}>
                              <MenuIcon name="reset" size={11} />
                              Revert
                            </button>
                          </div>
                          <div class="sb-diff-body sb-mono" role="region" aria-label={`Change ${index() + 1} in ${file.path}`} tabIndex={0}>
                            <For each={hunkLines(hunk)}>
                              {(line) => (
                                <div class={`sb-diff-line ${line.kind}`}>
                                  <span class="sb-diff-n" />
                                  <span class="sb-diff-text">{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </li>
                )}
              </For>
            </ul>
            <p class="ap-fine">These changes are already on disk. Revert writes the earlier text back; Span takes a snapshot first.</p>
          </Show>
        </section>
      </Show>
    </>
  );
}

/** The Undo toast after a restore or revert. Stays for a while, then the undo point stays reachable only by refresh. */
export function CheckpointUndoToast(props: { store: CheckpointStore; duration?: number }) {
  const s = props.store;
  createEffect(() => {
    if (!s.undo()) return;
    const timer = setTimeout(() => s.clearUndo(), props.duration ?? 12000);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <div class="sb-toast-host cp-toast-host" role="status" aria-live="polite">
      <Show when={s.undo()}>
        {(offer) => (
          <div class="sb-toast cp-toast">
            <span>{offer().text}</span>
            <button type="button" class="sb-link" disabled={s.busy()} onClick={() => void s.undoLast()}>
              Undo
            </button>
            <button type="button" class="ap-icon-btn" aria-label="Dismiss" onClick={() => s.clearUndo()}>
              <Icon name="CloseCircle" size={11} />
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * The thread's turn timeline: one row per checkpointed turn with its changed file count, View changes and Restore
 * files to before this turn (behind a confirm that states the conversation is not rolled back).
 */
export function CheckpointTimeline(props: { store: CheckpointStore; running: boolean; onViewChanges: (turn: number) => void }) {
  const s = props.store;
  const [confirming, setConfirming] = createSignal<number>();
  const text = () => restoreConfirmText(confirming() ?? 0);
  return (
    <Show when={s.status()?.available && s.turns().length}>
      <section class="cp-timeline" aria-label="Checkpoints">
        <ol>
          <For each={s.turns()}>
            {(turn, index) => {
              const live = () => props.running && index() === s.turns().length - 1;
              return (
                <li class="cp-turn" data-state={turn.hasEnd ? "done" : live() ? "capturing" : "partial"}>
                  <span class="cp-turn-dot" aria-hidden="true" />
                  <span class="cp-turn-title">Checkpoint</span>
                  <span class="cp-turn-meta">
                    Turn {turn.turn} · {turnSummary(turn, live())}
                  </span>
                  <span class="ap-grow" />
                  <Show when={turn.hasEnd && turn.changedFiles > 0}>
                    <button type="button" class="ap-btn small ghost" onClick={() => props.onViewChanges(turn.turn)}>
                      View changes
                    </button>
                  </Show>
                  <button type="button" class="ap-btn small ghost" disabled={s.busy() || props.running} title={props.running ? "Wait for the turn to finish." : undefined} onClick={() => setConfirming(turn.turn)}>
                    <MenuIcon name="reset" size={11} />
                    Restore files to before this turn
                  </button>
                </li>
              );
            }}
          </For>
        </ol>
        <Show when={s.notice()}>
          <p class="cp-notice" role="alert">{s.notice()}</p>
        </Show>
      </section>
      <Show when={confirming() !== undefined}>
        <Modal label={text().title} class="confirm-modal" initialFocus="[data-modal-cancel]" onClose={() => setConfirming(undefined)}>
          <h2>{text().title}</h2>
          <p>{text().body}</p>
          <div class="dialog-actions">
            <button class="button" data-modal-cancel onClick={() => setConfirming(undefined)}>
              Cancel
            </button>
            <span />
            <button
              class="button primary"
              data-modal-default
              onClick={() => {
                const turn = confirming();
                setConfirming(undefined);
                if (turn !== undefined) void s.restore(turn);
              }}
            >
              {text().confirm}
            </button>
          </div>
        </Modal>
      </Show>
    </Show>
  );
}
