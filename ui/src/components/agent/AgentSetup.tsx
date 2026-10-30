import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import type { AgentHint } from "../../bindings";
import { buildAgentCatalog, curatedAgent } from "../../lib/acp-catalog";
import type { AgentController, AgentPanelProps } from "../../lib/agent-controller";
import { hintText } from "../../lib/agent-hint-text";
import { fallbackModels } from "../../lib/agent-options";
import { capabilityChips, configViews, leaf } from "../../lib/agent-view";
import { api, isDesktop } from "../../lib/client";
import { cleanAgentText, signInCopy } from "../../lib/sign-in-copy";
import { agentUpdateError, agentUpdates, agentUpdatesBusy, checkAgentUpdates } from "../../lib/updates";
import { AgentCatalog, catalogPreset } from "./AgentCatalog";
import { ErrorCard } from "./Banners";
import { ConnectingSteps, ReadyCard } from "./ConnectFlow";
import { ConnectScreen } from "./ConnectScreen";
import { HintLine, SignIn } from "./SignIn";

export type SetupView = "connect" | "connecting" | "signin";

export type AgentSetupProps = Pick<AgentPanelProps, "workspacePath" | "removeAgent" | "onOpenExternal" | "delegationEnabled" | "onDelegationChange"> & {
  agent: AgentController;
  view: SetupView;
  /** A curated agent's local command waiting in the custom ACP row. Kept by the host so it survives a view change. */
  customDraft?: () => { command: string } | undefined;
  onCustomDraft?: (draft: { command: string } | undefined) => void;
};

/**
 * Choosing, installing and connecting an agent, the connecting steps and sign in. The editor sidebar and the Agents
 * page render the same flow from the same controller, so neither needs the other to finish connecting.
 */
export function AgentSetup(props: AgentSetupProps) {
  const a = props.agent;
  const [ownDraft, setOwnDraft] = createSignal<{ command: string }>();
  const customDraft = () => (props.customDraft ? props.customDraft() : ownDraft());
  const setCustomDraft = (draft: { command: string } | undefined) => (props.onCustomDraft ? props.onCustomDraft(draft) : setOwnDraft(draft));
  const agent = () => a.state().agent;
  const label = () => agent()?.title || agent()?.name || a.agentName();
  const brand = () => ({ id: a.agentId() ?? agent()?.name, name: label() });
  /** Other models for a refused prompt: only while this session's own turn was refused, so it can be sent again. */
  const signInModels = createMemo(() => (a.canRetryModel() ? fallbackModels(configViews(a.state().config)) : []));
  const signInText = () => {
    const auth = a.state().auth;
    return signInCopy({ agent: label(), message: auth?.message ?? "", agentMessage: auth?.agentMessage, promptFailed: a.canRetryModel(), models: signInModels().length });
  };
  /** Methods that cannot run from Span and need nothing typed. Methods that take a key or gateway get a form instead. */
  const unsupportedAuth = () => a.state().auth?.methods.filter((method) => !method.supported && !method.input) ?? [];
  /** One method's hint line. Environment setup names the method, since several methods can need it. */
  const methodHint = (method: { name: string; hint?: AgentHint | null }) => {
    const line = hintText(method.hint);
    return line && method.hint === "needsEnvironmentSetup" ? `${method.name} ${line}` : line;
  };
  /** Per-method hints that the header hint does not already say. The model-aware OpenCode hint already covers its login method. */
  const methodHints = () => {
    const header = a.state().auth?.hint;
    const shown = hintText(header);
    const covered = (method: { hint?: AgentHint | null }) => header === "runOpencodeAuthLoginOrSwitchModel" && method.hint === "runOpencodeAuthLogin";
    return [...new Set(unsupportedAuth().flatMap((method) => (!covered(method) && methodHint(method) ? [methodHint(method)!] : [])))].filter((line) => line !== shown);
  };
  const unhinted = () => unsupportedAuth().filter((method) => !method.hint);
  const presetRows = () => a.presets().map((preset) => ({ id: preset.id, name: preset.name, description: preset.description, command: [preset.launch.command, ...preset.launch.args].join(" ") }));
  /** Local programs the curated list already connects through their known command, so Known commands never repeats them. */
  const catalogListedIds = () => buildAgentCatalog(a.registry(), a.installed()).filter((row) => catalogPreset(row, presetRows())).map((row) => row.definition.id);

  return (
    <Switch>
      <Match when={props.view === "connect"}>
        <div class="agent-body">
          <ConnectScreen
            catalog={
              <AgentCatalog
                rows={a.catalogRows()}
                search={a.catalogSearch()}
                onSearch={a.setCatalogSearch}
                installingIds={a.installingIds()}
                installErrors={a.installErrors()}
                registryBusy={a.registryBusy()}
                working={a.working()}
                desktop={isDesktop}
                onRefresh={() => void a.loadAgents()}
                onPick={(row) => {
                  const command = a.pickCatalog(row);
                  if (command) setCustomDraft({ command });
                }}
                removal={a.removal()}
                removalBlock={a.removalBlock()}
                removalConnected={Boolean(a.state().sessionId) && a.agentId() === a.removal()?.entry.id}
                onCancelRemoval={a.cancelRemoval}
                onConfirmRemoval={() => void a.confirmRemoval()}
                presets={presetRows()}
                onPreset={a.connectPreset}
                updates={agentUpdates()}
                onOpenExternal={props.onOpenExternal}
                onCopyCommand={(command) => api.writeClipboard(command)}
              />
            }
            customDraft={customDraft()}
            listedIds={catalogListedIds()}
            onCopyCommand={(command) => api.writeClipboard(command)}
            onRemove={
              props.removeAgent
                ? (id, uninstall) => {
                    const entry = a.installed().find((candidate) => candidate.id === id);
                    if (entry) a.requestRemoval(entry, uninstall);
                  }
                : undefined
            }
            found={a.installed().map((entry) => ({ id: entry.id, name: a.registryName(entry.id) || entry.id, subtitle: `${entry.version} · ${leaf(entry.launch.command)}` }))}
            health={a.healthOn() ? a.health() : undefined}
            healthNow={a.healthNow()}
            presets={presetRows()}
            updates={agentUpdates()}
            checkingUpdates={agentUpdatesBusy()}
            updateError={agentUpdateError()}
            onCheckUpdates={() => void checkAgentUpdates(true)}
            onPreset={a.connectPreset}
            registry={a
              .registry()
              .filter((entry) => !a.installed().some((candidate) => candidate.id === entry.id) && !curatedAgent(entry.id))
              .map((entry) => ({ id: entry.id, name: entry.name, subtitle: entry.description, status: a.installingIds().includes(entry.id) ? "installing" : entry.installable ? "available" : "unsupported" }))}
            busy={a.working()}
            onConnect={a.connectInstalled}
            onInstall={(id) => void a.install(id)}
            onCustom={a.connectCustom}
            onOpenExternal={props.onOpenExternal}
            delegationEnabled={props.delegationEnabled}
            onDelegationChange={props.onDelegationChange}
          />
          <Show when={a.registryBusy()}>
            <p class="sb-fine" role="status">
              Loading installed agents and the ACP registry…
            </p>
          </Show>
          <Show when={!props.workspacePath}>
            <p class="sb-fine">Open a folder first. Agents start in the workspace folder.</p>
          </Show>
        </div>
      </Match>
      <Match when={props.view === "connecting"}>
        <div class="agent-body agent-connecting">
          <ConnectingSteps phases={a.phases()} />
          <Show when={agent()}>{(info) => <ReadyCard id={brand().id} name={label()} title={info().title || info().name || label()} version={info().version} capabilities={capabilityChips(info().features)} />}</Show>
        </div>
      </Match>
      <Match when={props.view === "signin" && a.state().auth}>
        {(auth) => (
          <div class="agent-body">
            <Show when={auth().agentMessage}>{(message) => <ErrorCard level="error" title={`${label()} reported a problem`} text={cleanAgentText(message())} actions={[]} />}</Show>
            <SignIn
              id={brand().id}
              name={label()}
              title={signInText().title}
              text={signInText().text}
              secondary={signInText().secondary}
              hint={hintText(auth().hint)}
              methods={auth()
                .methods.filter((method) => method.supported || method.input)
                .map((method) => ({ id: method.id, name: method.name, description: method.description ?? undefined, input: method.input ?? undefined, protocol: method.gatewayProtocol ?? undefined }))}
              busy={a.pendingAction() === "auth"}
              signingIn={a.signingIn()}
              onCancelSignIn={() => void a.cancelSignIn()}
              onPick={(id) => void a.authenticate(id)}
              onRetry={a.reconnect}
              models={signInModels()}
              onUseModel={(value) => void a.retryWithModel(value)}
              onSubmit={(id, secret) => void a.authenticateWith(id, secret)}
            />
            <Show when={unsupportedAuth().length}>
              <For each={methodHints()}>
                {(line) => (
                  <p class="sb-fine">
                    <HintLine text={line} />
                  </p>
                )}
              </For>
              <Show when={unhinted().length}>
                <p class="sb-fine">
                  {unhinted()
                    .map((method) => method.name)
                    .join(", ")}{" "}
                  {unhinted().length === 1 ? "needs" : "need"} a terminal sign-in, which Span does not run. Sign in from a terminal, then reconnect.
                </p>
              </Show>
              <div class="sb-actions">
                <button class="sb-btn" disabled={a.working()} onClick={a.reconnect}>
                  Reconnect
                </button>
              </div>
            </Show>
          </div>
        )}
      </Match>
    </Switch>
  );
}
