import { createSignal } from "solid-js";
import type { AgentUpdate_Serialize as AgentUpdate, AppUpdate_Serialize as AppUpdate } from "../bindings";
import { agentUpdateStatus, appUpdateCheck, isDesktop } from "./client";

/**
 * Session cache for update checks (ADR 0004). A check runs only when asked:
 * a button, or once per launch when the user turned on `updates.checkOnLaunch`.
 * Without `force`, a finished result is reused for the rest of the session.
 */
const [agentUpdates, setAgentUpdates] = createSignal<AgentUpdate[] | undefined>();
const [agentUpdateError, setAgentUpdateError] = createSignal("");
const [agentUpdatesBusy, setAgentUpdatesBusy] = createSignal(false);
const [appUpdate, setAppUpdate] = createSignal<AppUpdate | undefined>();
const [appUpdateBusy, setAppUpdateBusy] = createSignal(false);
export { agentUpdates, agentUpdateError, agentUpdatesBusy, appUpdate, appUpdateBusy };

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function checkAgentUpdates(force = false): Promise<void> {
  if (!isDesktop || agentUpdatesBusy() || (!force && agentUpdates())) return;
  setAgentUpdatesBusy(true);
  setAgentUpdateError("");
  try {
    setAgentUpdates(await agentUpdateStatus());
  } catch (error) {
    // The failure is shown as it is. Earlier results stay on screen.
    setAgentUpdateError(text(error));
  } finally {
    setAgentUpdatesBusy(false);
  }
}

export async function checkAppUpdate(force = false): Promise<void> {
  if (!isDesktop || appUpdateBusy() || (!force && appUpdate())) return;
  setAppUpdateBusy(true);
  try {
    setAppUpdate(await appUpdateCheck());
  } catch (error) {
    setAppUpdate({ currentVersion: "", channel: "unknown", latestVersion: null, newer: false, releaseUrl: null, status: "error", message: text(error) });
  } finally {
    setAppUpdateBusy(false);
  }
}

export const checkAllUpdates = (force = false) => Promise.all([checkAppUpdate(force), checkAgentUpdates(force)]).then(() => undefined);

/** Test helper. */
export function resetUpdateChecks() {
  setAgentUpdates(undefined);
  setAgentUpdateError("");
  setAgentUpdatesBusy(false);
  setAppUpdate(undefined);
  setAppUpdateBusy(false);
}
