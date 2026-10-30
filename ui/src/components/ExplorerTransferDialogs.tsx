import { Show, createSignal } from "solid-js";
import { Modal } from "./Modal";
import type { ImportChoice } from "../lib/explorer-state";
import type { PastedKind } from "../lib/explorer-transfer";
import { fileName } from "../lib/navigation";

const folderLabel = (folder: string, project: string) => folder ? fileName(folder) : project;

/** One name clash of a copy from outside Span. Keep both is the default; Replace moves the old item to the Trash. */
export function ImportConflictDialog(props: { folder: string; name: string; remaining: number; project: string; resolve: (choice: ImportChoice | undefined) => void }) {
  const [all, setAll] = createSignal(false);
  const choose = (policy: ImportChoice["policy"]) => props.resolve({ policy, all: all() });
  return <Modal label="Item already exists" class="confirm-modal" initialFocus="[data-modal-default]" onClose={() => props.resolve(undefined)} onSubmit={() => { choose("keepBoth"); }}>
    <h2>{`An item named '${props.name}' already exists in '${folderLabel(props.folder, props.project)}'.`}</h2>
    <p>Keep Both adds "copy" to the new item's name. Replace moves the existing item to the Trash. Skip leaves it and does not copy this one.</p>
    <Show when={props.remaining > 0}><label class="import-apply-all"><input type="checkbox" checked={all()} onChange={event => setAll(event.currentTarget.checked)} />{`Apply to the ${props.remaining} other ${props.remaining === 1 ? "clash" : "clashes"}`}</label></Show>
    <div class="dialog-actions"><button class="button" data-modal-cancel>Cancel</button><span /><button class="button" onClick={() => choose("skip")}>Skip</button><button class="button danger" onClick={() => choose("replace")}>Replace</button><button class="button primary" data-modal-default onClick={() => choose("keepBoth")}>Keep Both</button></div>
  </Modal>;
}

/** Name for clipboard content pasted as a new file. The default never exists; Rust refuses an existing name too. */
export function PasteNameDialog(props: { folder: string; pasted: PastedKind; value: string; project: string; resolve: (name: string | undefined) => void }) {
  const [name, setName] = createSignal(props.value);
  let input!: HTMLInputElement;
  return <Modal label={props.pasted === "image" ? "Paste image as file" : "Paste text as file"} class="confirm-modal" initialFocus={() => { queueMicrotask(() => { const dot = name().lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : name().length); }); return input; }} onClose={() => props.resolve(undefined)} onSubmit={() => { props.resolve(name()); }}>
    <h2>{`Paste the clipboard ${props.pasted} into '${folderLabel(props.folder, props.project)}'`}</h2>
    <input ref={input} class="paste-name-input" type="text" aria-label="File name" value={name()} spellcheck={false} autocomplete="off" onInput={event => setName(event.currentTarget.value)} />
    <div class="dialog-actions"><span /><button class="button" data-modal-cancel>Cancel</button><button class="button primary" data-modal-default disabled={!name().trim()} onClick={() => props.resolve(name())}>Create</button></div>
  </Modal>;
}
