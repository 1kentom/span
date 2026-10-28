// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { RunCatalog_Serialize as RunCatalog, RunConfiguration_Serialize as RunConfiguration, RunApprovalRequest } from "../bindings";
import { RunConfigurationManager } from "./RunConfigurationManager";
import { RunConfigurationSelect } from "./RunConfigurationSelect";
import { RunApprovalModal } from "./RunApprovalModal";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
const configuration: RunConfiguration = { id: "saved", name: "Application", executable: "node", args: ["app.js"], cwd: ".", env: { PORT: "3000" } };
const catalog: RunCatalog = { workspaceRoot: "/workspace", configurations: [configuration], detected: [{ configuration: { ...configuration, id: "detected:npm:test", name: "npm test", executable: "npm", args: ["test"] }, source: "package.json" }] };
const click = (root: HTMLElement, text: string) => { const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text); if (!button) throw new Error(`Missing button ${text}`); button.click(); };
const input = (root: HTMLElement, label: string, text: string) => { const field = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; field.value = text; field.dispatchEvent(new Event("input", { bubbles: true })); };
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function manager(available = true) {
  const root = document.createElement("div"); document.body.append(root);
  const save = vi.fn(async (value: RunConfiguration) => ({ ...value, id: value.id || "created" }));
  const duplicate = vi.fn(async () => ({ ...configuration, id: "copy", name: "Application copy" })); const remove = vi.fn(async () => {}); const close = vi.fn(); const select = vi.fn();
  cleanups.push(render(() => <RunConfigurationManager catalog={catalog} available={available} onSave={save} onDuplicate={duplicate} onDelete={remove} onSelect={select} onClose={close} />, root));
  return { root, save, duplicate, remove, close, select };
}
describe("run configuration controls", () => {
  it("selects by keyboard without launching, then runs only on explicit Shift Enter", async () => {
    const root = document.createElement("div"); document.body.append(root); const run = vi.fn(); const stop = vi.fn(); const manage = vi.fn();
    const [selected, setSelected] = createSignal("saved");
    cleanups.push(render(() => <RunConfigurationSelect options={[{ id: "saved", label: "Application", detected: false }, { id: "detected", label: "npm test", detected: true }]} value={selected()} onSelect={setSelected} onManage={manage} onRun={run} onStop={stop} />, root));
    root.querySelector<HTMLButtonElement>('[aria-label="Run configuration"]')!.click(); await settle();
    const detected = root.querySelector<HTMLButtonElement>('[data-configuration="detected"]')!; detected.click();
    expect(selected()).toBe("detected"); expect(run).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[aria-label="Run configuration"]')!.click(); await settle();
    root.querySelector('[data-configuration="saved"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    expect(selected()).toBe("saved"); expect(run).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
  });
  it("retains invalid and rejected edits, then applies the exact executable arguments and environment", async () => {
    const view = manager(); await settle();
    input(view.root, "Arguments JSON", "not-json"); click(view.root, "Apply"); await settle();
    expect(view.save).not.toHaveBeenCalled(); expect(view.root.textContent).toContain("Arguments must be a JSON array");
    input(view.root, "Arguments JSON", '["file with spaces.js", "日本語"]');
    input(view.root, "Environment JSON", '{"TOKEN":"${env:API_KEY}"}');
    view.save.mockRejectedValueOnce(new Error("Working directory is outside workspace"));
    click(view.root, "Apply"); await settle();
    expect(view.root.querySelector<HTMLInputElement>('[aria-label="Arguments JSON"]')!.value).toContain("日本語");
    expect(view.root.textContent).toContain("outside workspace"); expect(view.close).not.toHaveBeenCalled();
    click(view.root, "Apply"); await settle();
    expect(view.save).toHaveBeenLastCalledWith(expect.objectContaining({ args: ["file with spaces.js", "日本語"], env: { TOKEN: "${env:API_KEY}" } }));
    expect(view.root.textContent).toContain("Configuration saved"); expect(view.close).not.toHaveBeenCalled();
  });
  it("protects unapplied form changes on Cancel and keeps detected tasks read-only until copied", async () => {
    const view = manager(); await settle(); input(view.root, "Configuration name", "Unsaved name"); click(view.root, "Cancel");
    expect(view.close).not.toHaveBeenCalled(); expect(view.root.textContent).toContain("Discard unapplied changes?");
    click(view.root, "Keep editing"); expect(view.root.querySelector<HTMLInputElement>('[aria-label="Configuration name"]')!.value).toBe("Unsaved name");
    click(view.root, "Cancel"); click(view.root, "Discard changes"); expect(view.close).toHaveBeenCalledOnce();
    const next = manager(); await settle(); click(next.root, "npm testpackage.json");
    expect(next.root.querySelector<HTMLInputElement>('[aria-label="Executable"]')!.disabled).toBe(true);
    click(next.root, "Save an editable copy"); await settle(); expect(next.duplicate).toHaveBeenCalledWith("detected:npm:test");
    expect(next.root.querySelector<HTMLInputElement>('[aria-label="Executable"]')!.disabled).toBe(false); expect(next.select).toHaveBeenCalledWith("copy");
  });
  it("requires confirmation before deletion and performs no native action in preview", async () => {
    const view = manager(); await settle(); view.root.querySelector<HTMLButtonElement>('[aria-label="Delete configuration"]')!.click();
    expect(view.remove).not.toHaveBeenCalled();
    const confirmation = view.root.querySelector('[aria-label="Delete run configuration"]')!;
    (confirmation.querySelector('[data-modal-cancel]') as HTMLButtonElement).click(); expect(view.remove).not.toHaveBeenCalled();
    view.root.querySelector<HTMLButtonElement>('[aria-label="Delete configuration"]')!.click();
    (view.root.querySelector('[aria-label="Delete run configuration"] [data-modal-default]') as HTMLButtonElement).click(); await settle(); expect(view.remove).toHaveBeenCalledWith("saved");
    const preview = manager(false); await settle(); expect(preview.root.textContent).toContain("Browser preview does not save or execute commands");
    expect(preview.root.querySelector<HTMLButtonElement>('[aria-label="New configuration"]')!.disabled).toBe(true);
  });
  it("shows exact local execution details and explicit approval without exposing environment contents", async () => {
    const root = document.createElement("div"); document.body.append(root); const resolve = vi.fn();
    const request: RunApprovalRequest = { id: "approval", action: "run", agentName: "Fixture agent", lead: { connectionId: "connection", sessionId: "lead" }, name: "Application", executable: "/usr/bin/node", args: ["<script>not html</script>"], cwd: "/workspace", envKeys: ["TOKEN"], envReferences: { TOKEN: "${env:API_KEY}" }, envChanges: {}, configRevision: "rev", expiresAt: 1999999999, executionResolved: true };
    cleanups.push(render(() => <RunApprovalModal request={request} busy={false} queued={1} onResolve={resolve} />, root)); await settle();
    expect(root.textContent).toContain("exact execution command"); expect(root.textContent).toContain("TOKEN = ${env:API_KEY}"); expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("agent can read run output"); expect(resolve).not.toHaveBeenCalled();
    expect((document.activeElement as HTMLElement).textContent).toContain("Reject");
    click(root, "Approve once"); expect(resolve).toHaveBeenCalledWith("approval", true);
  });
  it("conceals proposed environment values and resets reveal/focus when approval changes", async () => {
    const root = document.createElement("div"); document.body.append(root); const resolve = vi.fn();
    const [request, setRequest] = createSignal<RunApprovalRequest>({ id: "first", action: "save", agentName: "Fixture agent", lead: { connectionId: "connection", sessionId: "lead" }, name: "Application", executable: "node", args: [], cwd: ".", envKeys: ["PORT"], envReferences: {}, envChanges: { PORT: "private-first" }, configRevision: "rev", expiresAt: 1999999999, executionResolved: false });
    cleanups.push(render(() => <RunApprovalModal request={request()} busy={false} queued={1} onResolve={resolve} />, root)); await settle();
    expect(root.textContent).not.toContain("private-first"); root.querySelector<HTMLButtonElement>('[aria-label="Reveal proposed environment value for PORT"]')!.click(); expect(root.textContent).toContain("private-first");
    setRequest({ ...request(), id: "second", envChanges: { PORT: "private-second" } }); await settle();
    expect(root.textContent).not.toContain("private-first"); expect(root.textContent).not.toContain("private-second"); expect((document.activeElement as HTMLElement).textContent).toContain("Reject"); expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps the manager open when an OK save completes after Cancel then Keep editing", async () => {
    const view = manager(); await settle(); input(view.root, "Configuration name", "Pending save");
    let release!: (value: RunConfiguration) => void;
    view.save.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    click(view.root, "OK"); await settle(); click(view.root, "Cancel"); click(view.root, "Keep editing");
    release({ ...configuration, name: "Pending save" }); await settle(); expect(view.close).not.toHaveBeenCalled(); expect(view.root.querySelector<HTMLInputElement>('[aria-label="Configuration name"]')!.value).toBe("Pending save");
  });

});
