// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Modal, modalAllowsGlobalShortcut } from "./Modal";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
async function settle() { for (let index = 0; index < 5; index += 1) await Promise.resolve(); }
function key(element: Element, key: string, options: KeyboardEventInit = {}) { const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }); element.dispatchEvent(event); return event; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function container() { const root = document.createElement("div"); document.body.append(root); return root; }

describe("modal focus and keyboard", () => {
  it("starts at autofocus, traps Tab in both directions and restores focus on cancel", async () => {
    const root = container(); let trigger!: HTMLButtonElement;
    disposers.push(render(() => {
      const [open, setOpen] = createSignal(false);
      return <><button ref={trigger} onClick={() => setOpen(true)}>Open</button><Show when={open()}><Modal label="Rename file" onClose={() => setOpen(false)}><button>First action</button><input autofocus aria-label="Filename" /><button hidden>Hidden action</button><button disabled>Unavailable</button><button>Last action</button></Modal></Show></>;
    }, root)); trigger.focus(); trigger.click(); await settle();
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!; const input = dialog.querySelector<HTMLInputElement>("input")!;
    const actions = dialog.querySelectorAll<HTMLButtonElement>("button"); expect(document.activeElement).toBe(input); expect(trigger.hasAttribute("inert")).toBe(true);
    actions[3].focus(); key(actions[3], "Tab"); expect(document.activeElement).toBe(actions[0]);
    key(actions[0], "Tab", { shiftKey: true }); expect(document.activeElement).toBe(actions[3]);
    key(input, "Escape"); await settle(); expect(root.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger); expect(trigger.hasAttribute("inert")).toBe(false);
  });
  it("supports explicit initial focus and contains programmatic focus escapes", async () => {
    const root = container(); const outside = document.createElement("button"); document.body.append(outside);
    disposers.push(render(() => <Modal label="Confirm" initialFocus="#cancel" onClose={vi.fn()}><button>Discard</button><button id="cancel">Cancel</button></Modal>, root)); await settle();
    expect(document.activeElement?.id).toBe("cancel"); outside.focus(); expect(document.activeElement?.id).toBe("cancel");
  });
  it("focuses the dialog itself if it has no interactive content", async () => {
    const root = container(); disposers.push(render(() => <Modal label="Status" onClose={vi.fn()}><p>Reading workspace…</p></Modal>, root)); await settle();
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!; expect(document.activeElement).toBe(dialog); expect(key(dialog, "Tab").defaultPrevented).toBe(true); expect(document.activeElement).toBe(dialog);
  });
  it("retains the underlying modal focus and inert background through a nested dialog", async () => {
    const root = container(); let openSecond!: () => void; let closeSecond!: () => void;
    disposers.push(render(() => {
      const [second, setSecond] = createSignal(false); openSecond = () => setSecond(true); closeSecond = () => setSecond(false);
      return <><button id="outside">Outside</button><Modal label="First" onClose={vi.fn()}><button id="first">First action</button></Modal><Show when={second()}><Modal label="Second" onClose={closeSecond}><button id="second">Second action</button></Modal></Show></>;
    }, root)); await settle(); openSecond(); await settle(); expect(document.activeElement?.id).toBe("second");
    key(document.activeElement!, "Escape"); await settle(); expect(document.activeElement?.id).toBe("first"); expect(root.querySelector("#outside")?.hasAttribute("inert")).toBe(true);
  });
  it("isolates editor shortcuts while allowing an explicitly permitted zoom shortcut", async () => {
    const root = container(); const dispatched = vi.fn(); const handler = (event: KeyboardEvent) => { if (modalAllowsGlobalShortcut(event)) dispatched(event.key); };
    window.addEventListener("keydown", handler, true);
    disposers.push(() => window.removeEventListener("keydown", handler, true));
    disposers.push(render(() => <Modal label="Settings" onClose={vi.fn()} allowGlobalShortcut={event => event.ctrlKey && event.key === "+"}><input autofocus /></Modal>, root)); await settle();
    const input = root.querySelector("input")!; key(input, "s", { ctrlKey: true }); key(input, "+", { ctrlKey: true }); expect(dispatched.mock.calls).toEqual([["+"]]);
  });
});

describe("modal default actions", () => {
  it("runs the explicit default button on Enter without changing a focused Cancel button", async () => {
    const root = container(); const save = vi.fn(); const cancel = vi.fn();
    disposers.push(render(() => <Modal label="Save changes" onClose={cancel} defaultAction="#save"><h2 tabIndex={-1} id="question">Save changes?</h2><button data-modal-cancel>Cancel</button><button id="save" onClick={save}>Save</button></Modal>, root)); await settle();
    key(root.querySelector("h2")!, "Enter"); expect(save).toHaveBeenCalledOnce();
    key(root.querySelector("h2")!, "Enter", { repeat: true }); expect(save).toHaveBeenCalledOnce();
    const cancelButton = root.querySelector<HTMLButtonElement>("[data-modal-cancel]")!; cancelButton.click(); expect(cancel).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledOnce();
  });
  it("preserves textarea editing, combobox selection, and actual form submission", async () => {
    const root = container(); const save = vi.fn(); const formSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    disposers.push(render(() => <Modal label="Edit file" onClose={vi.fn()} onSubmit={save}><textarea /><input role="combobox" /><form onSubmit={formSubmit}><input aria-label="Form field" /><button type="submit">Submit form</button></form></Modal>, root)); await settle();
    const textarea = root.querySelector("textarea")!; const combo = root.querySelector('[role="combobox"]')!; const field = root.querySelector('[aria-label="Form field"]')!;
    expect(key(textarea, "Enter").defaultPrevented).toBe(false); expect(key(combo, "Enter").defaultPrevented).toBe(false); expect(key(field, "Enter").defaultPrevented).toBe(false);
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); expect(formSubmit).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });
  it("prevents duplicate Save and Discard while an asynchronous save is pending", async () => {
    const root = container(); const pending = deferred<boolean>(); const save = vi.fn(() => pending.promise); const discard = vi.fn();
    disposers.push(render(() => <Modal label="Save changes" onClose={vi.fn()} onSubmit={save}><h2>Save?</h2><div class="dialog-actions"><button onClick={discard}>Discard</button><button data-modal-default>Save</button></div></Modal>, root)); await settle();
    const buttons = root.querySelectorAll<HTMLButtonElement>("button"); buttons[1].click(); buttons[1].click(); buttons[0].click(); key(root.querySelector("h2")!, "Enter");
    expect(save).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled(); expect(root.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
    pending.resolve(true); await settle(); expect(root.querySelector('[role="dialog"]')?.hasAttribute("aria-busy")).toBe(false); buttons[0].click(); expect(discard).toHaveBeenCalledOnce();
  });
  it("keeps the dirty draft and dialog open after a rejected save, and permits retry", async () => {
    const root = container(); const save = vi.fn().mockRejectedValueOnce(new Error("Disk is full")).mockResolvedValueOnce(false); const onError = vi.fn();
    disposers.push(render(() => <Modal label="Save draft" onClose={vi.fn()} onSubmit={save} onSubmitError={onError}><input autofocus value="unsaved local draft" /><div class="dialog-actions"><button data-modal-default>Save</button></div></Modal>, root)); await settle();
    root.querySelector<HTMLButtonElement>("button")!.click(); await settle(); expect(root.querySelector('[role="alert"]')?.textContent).toBe("Disk is full"); expect(onError).toHaveBeenCalledOnce();
    expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("unsaved local draft"); expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>("button")!.click(); await settle(); expect(save).toHaveBeenCalledTimes(2); expect(root.querySelector('[role="alert"]')).toBeNull(); expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("unsaved local draft");
  });
  it("cancels a pending dialog without applying its late failure to the next intent", async () => {
    const root = container(); const pending = deferred<boolean>(); const onError = vi.fn(); let next!: () => void;
    disposers.push(render(() => {
      const [intent, setIntent] = createSignal("first"); next = () => setIntent("second");
      return <Show when={intent()} keyed>{current => <Modal label={current} onClose={next} onSubmit={() => pending.promise} onSubmitError={onError}><input autofocus value={current === "first" ? "first dirty draft" : "second dirty draft"} /><button data-modal-default>Save</button></Modal>}</Show>;
    }, root)); await settle(); root.querySelector<HTMLButtonElement>("button")!.click(); key(root.querySelector("input")!, "Escape"); await settle();
    pending.reject(new Error("Late old request")); await settle(); expect(root.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("second"); expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("second dirty draft"); expect(root.querySelector('[role="alert"]')).toBeNull(); expect(onError).not.toHaveBeenCalled();
  });
});
