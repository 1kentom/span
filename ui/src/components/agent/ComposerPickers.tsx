import { For, Show, createMemo, createSignal } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { AgentController } from "../../lib/agent-controller";
import { groupOptions, hasModePicker, hasModelPicker, isBooleanOption, modeChipOption } from "../../lib/agent-options";
import { BYPASS_MODE_EXPLANATION } from "../../lib/agent-hint-text";
import { configViews, currentChoice, levelOf } from "../../lib/agent-view";
import { isDesktop } from "../../lib/client";
import { overlayTrait } from "../../lib/model-traits";
import { agentUpdateError, agentUpdates, agentUpdatesBusy, checkAgentUpdates } from "../../lib/updates";
import { AgentPopover } from "./AgentPopover";
import { effortColor } from "./EffortSlider";
import { ModePopover } from "./ModePopover";
import { modeInfo } from "../../lib/permission-modes";
import { ModelIcon, ModelPopover, isRouted, TraitBadge, currentModelTraits } from "./ModelPopover";
import { modelBrandFor } from "../../lib/model-brands";
import type { Brand } from "./types";

type Picker = "model" | "mode" | "agents";

/**
 * The three composer pickers: the agent mark opens the agent popover, the model chip the model popover (provider
 * row, model list, effort slider) and the mode chip the mode popover (mode and every other option). They share the
 * controller's single menu value, so only one is open at a time, and focus returns to the chip that opened it.
 */
export function createPickers(a: AgentController, props: { brand: Brand; label: string }, prompt: () => HTMLElement | undefined) {
  const config = createMemo(() => configViews(a.state().config));
  const groups = createMemo(() => groupOptions(config()));
  const effort = () => groups().effort[0];
  const modelLabel = () => currentChoice(groups().model[0])?.name ?? props.label;
  /** The current model, only when it is provider-prefixed and has a vendor mark: the chip then carries the composite avatar. */
  const brandedModel = () => {
    const choice = currentChoice(groups().model[0]);
    return choice && isRouted(choice) && modelBrandFor(choice) ? choice : undefined;
  };
  const modelTrait = () => overlayTrait(currentModelTraits(config()));
  const busy = () => a.pendingAction().startsWith("config:") || a.working() || a.running();
  const select = (id: string, value: string) => {
    // Opened from the limit card: picking a model resends the refused turn with it (the existing retry path).
    if (a.resendArmed() === "model" && a.limitTurn() && config().find((option) => option.id === id)?.category === "model") {
      close();
      void a.retryWithModel(value);
      return;
    }
    void a.setConfig(id, value);
  };
  const presets = () => a.presets().filter((preset) => !a.installed().some((entry) => entry.id === preset.id)).map((preset) => ({ id: preset.id, name: preset.name, description: preset.description }));

  let agentChip: HTMLButtonElement | undefined;
  let modelChip: HTMLButtonElement | undefined;
  let modeChip: HTMLButtonElement | undefined;
  /** The chip that opened the current picker. The provider row keeps it, so Escape from the agent popover returns to the model chip. */
  let returnTo: HTMLElement | undefined;
  const open = () => a.menu() === "model" || a.menu() === "mode" || a.menu() === "agents";
  const close = () => {
    a.setMenu(null);
    const target = returnTo?.isConnected ? returnTo : prompt();
    returnTo = undefined;
    target?.focus();
  };
  const toggle = (menu: Picker, from: HTMLElement | undefined) => {
    if (a.menu() === menu) return close();
    returnTo = from;
    a.setMenu(menu);
  };
  /** Switching agents starts a new chat, so the picker closes first and focus settles before the connect view takes over. */
  const switchTo = (connect: () => void) => {
    close();
    connect();
  };

  function Popovers() {
    return (
      <>
        <Show when={a.menu() === "model"}>
          <ModelPopover
            agentName={props.label}
            brand={props.brand}
            options={config()}
            busy={busy()}
            limited={a.limitedModelValues()}
            freeOnly={a.resendArmed() === "model" && a.limitTurn()?.freeTier ? false : undefined}
            onSelect={select}
            onOpenAgents={() => (a.resendArmed() ? a.openResendPicker("agents") : a.setMenu("agents"))}
            onClose={close}
          />
        </Show>
        <Show when={a.menu() === "mode"}>
          <ModePopover
            agentName={props.label}
            options={config()}
            busy={busy() || a.permissionModes.busy()}
            onSelect={select}
            onClose={close}
            spanMode={a.state().permissionMode}
            onSpanMode={(mode) => {
              close();
              void a.permissionModes.choose(mode);
            }}
          />
        </Show>
        <Show when={a.menu() === "agents"}>
          <AgentPopover
            desktop={isDesktop}
            agents={a.installed().map((entry) => ({ id: entry.id, name: a.registryName(entry.id) || entry.id, subtitle: entry.version, current: a.connected() && entry.id === a.agentId() }))}
            health={a.healthOn() ? a.health() : undefined}
            healthNow={a.healthNow()}
            connectedName={a.connected() ? props.label : undefined}
            presets={presets()}
            updates={agentUpdates()}
            checkingUpdates={agentUpdatesBusy()}
            updateError={agentUpdateError()}
            busy={a.working()}
            onSelect={(id) => {
              // Opened from the limit card: the refused turn goes to the new agent through the switch and handoff path.
              const resend = a.resendArmed() === "agents" && Boolean(a.limitTurn());
              switchTo(() => (resend ? void a.switchAgentAndResend(id) : a.connectInstalled(id)));
            }}
            onPreset={(id) => switchTo(() => a.connectPreset(id))}
            onCheckUpdates={() => void checkAgentUpdates(true)}
            onAdd={() => {
              returnTo = undefined;
              a.setMenu(null);
              a.setView("connect");
            }}
            onClose={close}
          />
        </Show>
      </>
    );
  }

  function Chips() {
    return (
      <>
        <button
          ref={agentChip}
          class="agent-tool-button agent-agent-button"
          aria-label={a.connected() ? `Agent: ${props.label}` : "Select agent"}
          title={a.connected() ? `${props.label}. Switch agent` : "Select agent"}
          aria-haspopup="dialog"
          aria-expanded={a.menu() === "agents"}
          onClick={() => toggle("agents", agentChip)}
        >
          <BrandIcon id={props.brand.id} name={props.brand.name} size={15} />
          <Show when={!a.connected()}>
            <span class="agent-model-name">No agent</span>
            <Icon name="arrow-down4" size={10} />
          </Show>
        </button>
        <Show when={a.connected() && hasModelPicker(groups())}>
          <button
            ref={modelChip}
            class="agent-tool-button agent-model-button"
            aria-label={effort() ? `Model: ${modelLabel()}, ${effort()!.name}: ${currentChoice(effort())?.name ?? effort()!.currentValue}` : `Model: ${modelLabel()}`}
            title={modelLabel()}
            aria-haspopup="dialog"
            aria-expanded={a.menu() === "model"}
            onClick={() => toggle("model", modelChip)}
          >
            <Show when={brandedModel()} fallback={<Show when={modelTrait()}>{(trait) => <TraitBadge trait={trait()} class="inline" />}</Show>}>
              {(choice) => <ModelIcon id={props.brand.id} name={props.brand.name} agentName={props.label} model={choice()} traits={currentModelTraits(config())} size={15} />}
            </Show>
            <span class="agent-model-name">{modelLabel()}</span>
            <Show when={levelOf(effort())}>
              {(current) => (
                <span class="agent-level" aria-hidden="true" style={{ "--fx-c": effortColor(current().index - 1, current().count) }}>
                  <For each={Array.from({ length: current().count }, (_, index) => index)}>
                    {(index) => <span classList={{ on: index < current().index }} style={{ height: `${Math.round(30 + (70 * (index + 1)) / current().count)}%` }} />}
                  </For>
                </span>
              )}
            </Show>
            <Icon name="arrow-down4" size={10} />
          </button>
        </Show>
        <Show when={a.connected() ? a.state().permissionMode : undefined}>
          {(mode) => {
            const info = () => modeInfo(mode().mode);
            const mismatch = () => Boolean(a.state().modeMismatch);
            const label = () => (mismatch() ? `Permissions: ${info().label}. The agent reports another mode` : `Permissions: ${info().label}`);
            return (
              <button
                ref={modeChip}
                class="agent-tool-button agent-mode-button agent-perm-chip"
                classList={{ warn: info().danger || mismatch(), plan: mode().mode === "plan" }}
                data-mode={mode().mode}
                aria-label={`${label()}. Shift Tab cycles Ask, Accept edits and Plan`}
                title={`${label()} (⇧⇥)`}
                aria-haspopup="dialog"
                aria-expanded={a.menu() === "mode"}
                onClick={() => toggle("mode", modeChip)}
              >
                <Icon name={mismatch() ? "Warning2" : info().icon} size={12} class={info().danger || mismatch() ? "sb-glyph warn" : "sb-glyph"} />
                <span class="agent-model-name">{info().label}</span>
                <Icon name="arrow-down4" size={10} />
              </button>
            );
          }}
        </Show>
        <Show when={a.connected() && !a.state().permissionMode && hasModePicker(groups()) ? modeChipOption(groups()) : undefined}>
          {(option) => {
            const name = () => currentChoice(option())?.name ?? option().currentValue;
            // An on/off option says which switch it is: "Fast mode: On", not a bare "On".
            const shown = () => (isBooleanOption(option()) ? `${option().name}: ${name()}` : name());
            // The backend's bypass notice is the one source for "this mode skips approval prompts".
            const bypass = () => Boolean(a.state().permissionBypass);
            // The full label goes in the tooltip only when the chip had to cut it.
            const [clipped, setClipped] = createSignal(false);
            const measure = (event: Event) => {
              const label = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(".agent-model-name");
              setClipped(Boolean(label && label.scrollWidth > label.clientWidth));
            };
            return (
              <button
                ref={modeChip}
                class="agent-tool-button agent-mode-button"
                classList={{ warn: bypass() }}
                aria-label={bypass() ? `${option().name}: ${name()}. ${BYPASS_MODE_EXPLANATION}` : `${option().name}: ${name()}`}
                title={bypass() ? `${name()}. ${BYPASS_MODE_EXPLANATION}` : clipped() ? shown() : undefined}
                aria-haspopup="dialog"
                aria-expanded={a.menu() === "mode"}
                onPointerEnter={measure}
                onFocus={measure}
                onClick={() => toggle("mode", modeChip)}
              >
                <Show when={bypass()}>
                  <Icon name="Warning2" size={11} class="sb-glyph warn" />
                </Show>
                <span class="agent-model-name">
                  <Show when={bypass() && /\s+permissions$/i.test(shown())} fallback={shown()}>
                    {shown().replace(/\s+permissions$/i, "")}
                    <span class="agent-mode-suffix"> permissions</span>
                  </Show>
                </span>
                <Icon name="arrow-down4" size={10} />
              </button>
            );
          }}
        </Show>
      </>
    );
  }

  return { Chips, Popovers, open, close };
}
