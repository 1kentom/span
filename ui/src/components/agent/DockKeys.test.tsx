// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { PermissionDock, QuestionDock, UrlDock } from "./Docks";
import { AttachmentViewer } from "../attachments";
import { createPastedText } from "../../lib/attachments";
import { composerHints } from "../../lib/agent-hints";
import { key, mount } from "./test-utils";

const options = [
  { optionId: "ao", name: "Allow once", kind: "allow_once" },
  { optionId: "aa", name: "Always allow", kind: "allow_always" },
  { optionId: "ro", name: "Reject", kind: "reject_once" },
];
const questions = [{ id: "pg", label: "Postgres" }, { id: "sq", label: "SQLite" }];

/** An empty composer next to open docks, the way the sidebar lays them out. */
function sidebar() {
  const chosen: string[] = [];
  const answers: unknown[] = [];
  const opened = vi.fn();
  const cancelled = vi.fn();
  const host = mount(() => (
    <div>
      <PermissionDock title="Run git push" command="git push" options={options} onChoose={(id) => chosen.push(id)} />
      <QuestionDock prompt="Which database?" options={questions} onAnswer={(answer) => answers.push(answer)} onCancel={cancelled} />
      <UrlDock title="Sign in" href="https://example.com" onOpen={opened} onCancel={cancelled} />
      <textarea id="composer" />
    </div>
  ));
  const composer = host.querySelector<HTMLTextAreaElement>("#composer")!;
  const docks = [...host.querySelectorAll<HTMLElement>(".sb-dock")];
  return { host, composer, docks, chosen, answers, opened, cancelled };
}

describe("dock keys answer only from inside the dock", () => {
  it("typing y, n and 1 into an empty composer answers nothing", () => {
    const { composer, chosen, answers, opened, cancelled } = sidebar();
    composer.focus();
    expect(composer.value).toBe("");
    for (const name of ["y", "n", "Y", "1", "2", "Enter", "Escape"]) key(name, {}, composer);
    expect(chosen).toEqual([]);
    expect(answers).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("keys sent to the window or the page body answer nothing", () => {
    const { chosen, answers, opened, cancelled } = sidebar();
    for (const name of ["y", "n", "1", "Enter", "Escape"]) {
      key(name);
      key(name, {}, document.body);
    }
    expect(chosen).toEqual([]);
    expect(answers).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("pressing y while the attachment viewer modal is open answers nothing", () => {
    const chosen: string[] = [];
    const host = mount(() => (
      <div>
        <PermissionDock title="Run git push" options={options} onChoose={(id) => chosen.push(id)} />
        <AttachmentViewer item={createPastedText("hello")} onClose={() => undefined} />
      </div>
    ));
    const dialog = document.querySelector<HTMLElement>("[aria-modal='true']")!;
    expect(dialog).not.toBeNull();
    const inside = dialog.querySelector<HTMLElement>("button") ?? dialog;
    key("y", {}, inside);
    key("y", {}, dialog);
    // Even a key that lands on the dock is ignored while a modal is open over it.
    key("y", {}, host.querySelector<HTMLButtonElement>(".sb-dock .sb-actions button")!);
    expect(chosen).toEqual([]);
  });

  it("still answers when the dock has focus", () => {
    const { docks, chosen, answers, opened, cancelled } = sidebar();
    const [permission, question, url] = docks;
    const button = permission.querySelector<HTMLButtonElement>(".sb-actions button")!;
    button.focus();
    key("y", {}, button);
    key("N", {}, permission);
    key("a", {}, permission);
    expect(chosen).toEqual(["ao", "ro", "aa"]);
    key("2", {}, question.querySelector("button")!);
    key("Escape", {}, question);
    expect(answers).toEqual([{ optionId: "sq" }]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    key("Enter", {}, url);
    key("Escape", {}, url);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("ignores repeats, composition, modifier combos and handled events inside the dock", () => {
    const { docks, chosen, answers } = sidebar();
    const [permission, question] = docks;
    key("y", { repeat: true }, permission);
    key("y", { isComposing: true }, permission);
    key("y", { ctrlKey: true }, permission);
    key("y", { metaKey: true }, permission);
    key("y", { altKey: true }, permission);
    key("1", { shiftKey: true }, question);
    const handled = new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true });
    handled.preventDefault();
    permission.dispatchEvent(handled);
    expect(chosen).toEqual([]);
    expect(answers).toEqual([]);
  });

  it("typing digits into the question's own text field does not pick an option", () => {
    const answers: unknown[] = [];
    const host = mount(() => <QuestionDock prompt="p" allowText options={questions} onAnswer={(answer) => answers.push(answer)} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    key("1", {}, input);
    expect(answers).toEqual([]);
  });

  it("does nothing while busy or inactive, even from inside", () => {
    const chosen: string[] = [];
    const [busy, setBusy] = createSignal(true);
    const host = mount(() => <PermissionDock title="t" options={options} busy={busy()} onChoose={(id) => chosen.push(id)} />);
    const dock = host.querySelector<HTMLElement>(".sb-dock")!;
    key("y", {}, dock);
    setBusy(false);
    key("y", {}, dock);
    expect(chosen).toEqual(["ao"]);
  });
});

describe("permission key hints", () => {
  it("lists A only when it differs from Y", () => {
    expect(composerHints({ permission: options }).permission.map((hint) => hint.keys[0])).toEqual(["Y", "A", "N"]);
    expect(composerHints({ permission: [options[1], options[2]] }).permission.map((hint) => hint.keys[0])).toEqual(["Y", "N"]);
  });
});
