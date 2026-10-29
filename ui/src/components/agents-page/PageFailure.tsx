import { Show, createMemo } from "solid-js";
import type { AgentController } from "../../lib/agent-controller";
import { otherFreeModels, rankAlternatives } from "../../lib/agent-alternatives";
import { isLimitKind } from "../../lib/agent-errors";
import { classifyFailure } from "../../lib/agent-view";
import { api, isDesktop } from "../../lib/client";
import { modelCost } from "../../lib/model-cost";
import { ErrorCard } from "../agent/Banners";
import { LimitCard } from "../agent/LimitCard";
import type { ActionView } from "../agent/types";

/**
 * The thread's failure on the Agents page: the limit card for usage and rate limits, else the error card. Every action
 * stays on the page: model and agent pickers open in the page composer, "Choose agent" opens the in-page connect view
 * and "Show ACP log" the in-page log. Nothing here opens the editor sidebar.
 */
export function PageFailure(props: { agent: AgentController; label: string; onChooseAgent: () => void; onShowLog: () => void }) {
  const a = props.agent;
  const failure = createMemo(() => {
    const current = a.state().failure;
    return current ? { ...classifyFailure(current, props.label), log: current.log } : undefined;
  });
  const limitInfo = createMemo(() => {
    const current = failure();
    return current && isLimitKind(current.error.kind) ? current.error : undefined;
  });
  const modelOption = () => a.state().config.find((option) => option.category === "model");
  const alternatives = createMemo(() => (limitInfo() ? rankAlternatives(a.installed().map((entry) => ({ id: entry.id, name: a.registryName(entry.id) || entry.id })), a.health(), { id: a.agentId(), name: props.label }).slice(0, 2) : []));
  const freeModels = createMemo(() => {
    const option = modelOption();
    if (!limitInfo()?.freeTier || !option) return [];
    const choices = option.groups.flatMap((group) => group.choices).map((choice) => ({ value: choice.value, name: choice.name }));
    return otherFreeModels(choices, option.currentValue, (choice) => modelCost(choice) === "free", a.limitedModelValues());
  });
  const chooseAgent = () => {
    a.dismissFailure();
    a.leaveConnecting();
    props.onChooseAgent();
  };
  const actions = createMemo<ActionView[]>(() => {
    const current = failure();
    if (!current) return [];
    const list: ActionView[] = [];
    const phase = a.state().failure?.phase;
    if (["exit", "timeout"].includes(current.kind) || (current.kind === "auth" && phase !== "auth")) {
      if (a.launch()) list.push({ label: "Reconnect", primary: true, onAct: a.reconnect });
      list.push({ label: "Choose agent", onAct: chooseAgent });
    } else if (["missing-binary", "protocol"].includes(current.kind) || (current.kind === "other" && phase === "connect")) {
      list.push({ label: "Choose agent", primary: true, onAct: chooseAgent });
    }
    if (isDesktop && current.kind !== "workspace") list.push({ label: "Show ACP log", onAct: props.onShowLog });
    list.push({
      label: "Dismiss",
      onAct: () => {
        a.dismissFailure();
        if (a.connecting()?.failed) a.leaveConnecting();
      },
    });
    return list;
  });
  return (
    <Show when={failure()}>
      {(current) => (
        <div class="ap-thread-failure">
          <Show when={limitInfo()} fallback={<ErrorCard level={current().level} title={current().title} text={current().text} log={current().log?.length ? current().log : undefined} actions={actions()} />}>
            {(info) => (
              <LimitCard
                info={info()}
                raw={a.state().failure?.message ?? ""}
                canResend={Boolean(a.limitTurn())}
                alternatives={alternatives()}
                freeModels={freeModels()}
                hasModels={a.connected() && Boolean(modelOption())}
                onTryModel={() => a.openResendPicker("model")}
                onUseModel={(value) => void a.retryWithModel(value)}
                onSwitchAgent={(id) => void a.switchAgentAndResend(id)}
                onMoreAgents={() => a.openResendPicker("agents")}
                onRetry={a.retryLimited}
                onOpenLink={(url) => (a.props.onOpenExternal ? a.props.onOpenExternal(url) : void api.openExternal(url).catch(() => undefined))}
                onShowLog={isDesktop ? props.onShowLog : undefined}
                onDismiss={a.dismissFailure}
              />
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
