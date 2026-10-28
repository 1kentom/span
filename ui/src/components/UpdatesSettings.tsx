import { For, Show } from "solid-js";
import type { AgentUpdate_Serialize as AgentUpdate, AppUpdate_Serialize as AppUpdate } from "../bindings";
import Icon from "./Icon";
import "../styles/updates.css";

export interface UpdatesSettingsProps {
  desktop: boolean;
  busy?: boolean;
  app?: AppUpdate;
  agents?: AgentUpdate[];
  agentError?: string;
  /** The merged value of `updates.checkOnLaunch`. It is edited only in the user settings file. */
  checkOnLaunch?: boolean;
  onCheck: () => void | Promise<void>;
  /** Opens the release page through the validated external-open command. Called only from a click. */
  onOpenRelease: (url: string) => void;
}

const statusText = { upToDate: "Up to date", updateAvailable: "Update available", unknown: "Version unknown", notInstalled: "Not installed" } as const;

export function UpdatesSettings(props: UpdatesSettingsProps) {
  const shown = () => (props.agents ?? []).filter((agent) => agent.status !== "notInstalled");
  return (
    <section class="updates-settings" aria-label="Updates">
      <div class="updates-heading">
        <div>
          <h2>Check for updates</h2>
          <p>Span only checks. It never downloads or installs an update, and a check is a plain request that sends no identifiers.</p>
        </div>
        <button class="button" disabled={!props.desktop || props.busy} onClick={() => void props.onCheck()}>
          <Icon name="Refresh2" size={13} />
          {props.busy ? "Checking…" : "Check for updates"}
        </button>
      </div>
      <Show when={props.desktop} fallback={<p class="updates-result">The browser preview cannot check for updates. Open Span desktop.</p>}>
        <dl class="updates-facts" aria-label="This build">
          <dt>Current version</dt>
          <dd>{props.app?.currentVersion || "Shown after a check"}</dd>
          <dt>Channel</dt>
          <dd>{props.app?.channel || "Shown after a check"}</dd>
          <dt>Check on launch</dt>
          <dd>
            {props.checkOnLaunch ? "On" : "Off"}. <code class="updates-key">updates.checkOnLaunch</code> is read only from your user settings file, so it cannot be changed on this page: settings saved here go to the workspace file, which cannot enable it.
          </dd>
        </dl>
        <Show when={props.app}>
          {(app) => (
            <>
              <Show when={app().status === "notConfigured"}><p class="updates-result" role="status">{app().message || "Update checks are not configured for this build."}</p></Show>
              <Show when={app().status === "error"}><p class="updates-result error" role="alert">Could not check for a Span update: {app().message}</p></Show>
              <Show when={app().status === "upToDate"}><p class="updates-result" role="status">Span {app().currentVersion} is up to date on the {app().channel} channel (latest {app().latestVersion}).</p></Show>
              <Show when={app().status === "updateAvailable"}>
                <p class="updates-result" role="status">
                  Update available: {app().currentVersion} to {app().latestVersion} on the {app().channel} channel. Download and install it yourself from the release page.
                  <Show when={app().releaseUrl}>{(url) => <button class="sp-text-button text-button" onClick={() => props.onOpenRelease(url())}>View release page</button>}</Show>
                </p>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.agentError}><p class="updates-result error" role="alert">Could not check agents: {props.agentError}</p></Show>
        <Show when={shown().length}>
          <div class="updates-agents" role="list" aria-label="Agent versions">
            <For each={shown()}>
              {(agent) => (
                <div class="updates-agent" role="listitem">
                  <div>
                    <strong>{agent.name}</strong>
                    <p>
                      Installed {agent.installedVersion ?? "version unknown"}
                      {agent.latestVersion ? `, registry ${agent.latestVersion}` : ""}
                    </p>
                    <Show when={agent.note}><p>{agent.note}</p></Show>
                    <Show when={agent.howToUpdate}><p>{agent.howToUpdate}</p></Show>
                    <Show when={agent.repository}><p>Repository: {agent.repository}</p></Show>
                  </div>
                  <span>{statusText[agent.status]}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}
