import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { ConfigOptionView } from "./types";
import { arrowFocus, useEscape } from "./util";
import { TRAIT_INFO, chipTrait, isFastSwitchOn, modelTraits, overlayTrait, type ModelTrait } from "../../lib/model-traits";
import type { BrandIdentity } from "../../lib/brand-icons";
import { modelBrandFor } from "../../lib/model-brands";
import { EffortSlider, defaultLevel, focusModelRow, modelNameOf } from "./EffortSlider";
import { groupOptions } from "../../lib/agent-options";
import { COST_INFO, COST_ORDER, hasCostTiers, modelCost, readFreeOnly, writeFreeOnly, type ModelCost } from "../../lib/model-cost";

type ModelPopoverProps = {
  agentName: string;
  /** Every session config option. Only the model list and the effort slider are drawn; the fast switch still badges the current model. */
  options: ConfigOptionView[];
  /** Brand of the connected agent, shown on the provider row and every model row. */
  brand?: BrandIdentity;
  busy?: boolean;
  onSelect: (configId: string, value: string) => void;
  /** Opens the agent popover from the provider row. Without it the row is not drawn. */
  onOpenAgents?: () => void;
  onClose: () => void;
};

/** True while a boolean fast switch among the options is on. It only applies to the current model. */
export const fastSwitchOn = (options: readonly ConfigOptionView[]) => options.some(isFastSwitchOn);

/** Traits of the model option's current choice, for the composer button. */
export function currentModelTraits(options: readonly ConfigOptionView[]): ModelTrait[] {
  const model = options.find((option) => option.category === "model");
  const choice = model?.choices.find((candidate) => candidate.value === model.currentValue);
  return choice ? modelTraits(choice, { fastOn: fastSwitchOn(options) }) : [];
}

/** The primary trait (fast bolt, or the star for heavy models) as a small round badge. */
export function TraitBadge(props: { trait: ModelTrait; class?: string }) {
  const info = () => TRAIT_INFO[props.trait];
  return (
    <span class={`sb-trait-badge ${props.class ?? ""}`} data-trait={props.trait} role="img" aria-label={info().label} title={info().label}>
      <Icon name={info().icon!} size={9} />
    </span>
  );
}

/** True for a provider-prefixed id such as "opencode/deepseek-v4.1-flash-free": the mark of a router agent that serves many vendors. */
export const isRouted = (model?: { value: string }) => Boolean(model?.value.includes("/"));

/**
 * A router agent (OpenCode) shows the model's vendor mark with the agent that serves it as a small badge at the bottom
 * left, and the primary trait badge at the bottom right. A routed model with no known vendor mark shows the agent mark
 * alone, never a guessed logo. Every other agent keeps its own single mark with the trait badge, no vendor logo.
 */
export function ModelIcon(props: BrandIdentity & { traits: readonly ModelTrait[]; size?: number; model?: { value: string; name: string }; agentName?: string }) {
  const size = () => props.size ?? 16;
  const routed = () => isRouted(props.model);
  const vendor = createMemo(() => (props.model && routed() ? modelBrandFor(props.model) : undefined));
  const agent = () => props.agentName ?? props.name ?? props.id;
  const label = () => {
    const where = agent() ? ` on ${agent()}` : "";
    return vendor() ? `${vendor()!.name} model${where}` : `Model${where}`;
  };
  return (
    <span class="sb-model-icon" role={routed() ? "img" : undefined} aria-label={routed() ? label() : undefined}>
      <Show when={vendor()} fallback={<BrandIcon id={props.id} name={props.name} size={size()} />}>
        {(mark) => (
          <>
            <BrandIcon id={mark().id} name={mark().name} asset={mark()} size={size()} />
            <BrandIcon class="sb-agent-badge" id={props.id} name={props.name} size={Math.round(size() * 0.58)} />
          </>
        )}
      </Show>
      <Show when={overlayTrait(props.traits)}>{(trait) => <TraitBadge trait={trait()} />}</Show>
    </span>
  );
}

function TraitChip(props: { trait: ModelTrait }) {
  const info = () => TRAIT_INFO[props.trait];
  return (
    <span class="sb-trait-chip" data-trait={props.trait} aria-label={info().label} title={info().label}>
      <Show when={info().icon}>{(icon) => <Icon name={icon()} size={10} />}</Show>
      {info().chip}
    </span>
  );
}

/** A provider-prefixed model reads without its prefix inside a cost tier ("opencode/Beam Free" becomes "Beam Free"); the full name stays in the tooltip. */
const shownName = (choice: { value: string; name: string }) => (modelCost(choice) ? choice.name.replace(/^[^/\s]+\//, "") : choice.name);

/** True when another model has the same name once provider prefixes are dropped, so the row needs its provider to tell them apart. */
const ambiguous = (choices: readonly { value: string; name: string }[], choice: { value: string; name: string }) =>
  Boolean(modelCost(choice)) && choices.some((other) => other.value !== choice.value && modelCost(other) && shownName(other) === shownName(choice));

/** The model popover: a provider row that opens the agent popover, the agent's model list, then the effort slider. */
export function ModelPopover(props: ModelPopoverProps) {
  let root: HTMLDivElement | undefined;
  useEscape(props.onClose);
  const brand = () => props.brand ?? { name: props.agentName };
  const fastOn = () => fastSwitchOn(props.options);
  const groups = createMemo(() => groupOptions(props.options));
  const [freeOnly, setFreeOnly] = createSignal(readFreeOnly());
  /** Model rows grouped by cost tier when the list mixes free and other models. Free-only keeps the current model visible. */
  const tiersOf = (option: ConfigOptionView): { cost?: ModelCost; values: string[] }[] => {
    if (option.category !== "model" || !hasCostTiers(option.choices)) return [{ values: option.choices.map((choice) => choice.value) }];
    return COST_ORDER.map((cost) => ({
      cost,
      values: option.choices
        .filter((choice) => modelCost(choice) === cost && (!freeOnly() || cost === "free" || choice.value === option.currentValue))
        .map((choice) => choice.value),
    })).filter((tier) => tier.values.length);
  };
  // Model lists first, then sliders, each keyed by id so a config update keeps the control under focus.
  const sections = createMemo(() => [...groups().model, ...groups().effort].map((option) => option.id), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  createEffect(() => {
    queueMicrotask(() => (root?.querySelector<HTMLElement>("[aria-checked='true']:not(:disabled)") ?? root?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus());
  });
  return (
    <div class="sb-popover sb-picker" role="dialog" aria-label={`${props.agentName} model`} ref={root} onKeyDown={(event) => arrowFocus(event, root, "button:not(:disabled)")}>
      <Show when={props.onOpenAgents}>
        <button class="sb-option sb-provider" aria-label={`Agent: ${props.agentName}. Switch agent`} aria-haspopup="dialog" onClick={() => props.onOpenAgents?.()}>
          <BrandIcon id={brand().id} name={brand().name} size={15} />
          <span class="sb-option-text">
            <span class="sb-option-name">{props.agentName}</span>
          </span>
          <Icon name="arrow-right4" size={11} />
        </button>
        <div class="sb-rule-h" />
      </Show>
      {/* Keyed by option id and choice value, not object identity: a config
          update delivers new option objects, and rebuilding the rows would
          drop keyboard focus from the control the user is on. */}
      <For each={sections()}>
        {(optionId, index) => {
          // The last seen option stays readable while a removed row is disposed.
          let last = props.options.find((candidate) => candidate.id === optionId)!;
          const option = () => (last = props.options.find((candidate) => candidate.id === optionId) ?? last);
          // Equal tiers keep their identity, so a config update does not rebuild the rows or drop focus.
          const tiers = createMemo(() => tiersOf(option()), undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
          return (
            <>
              <Show when={index() > 0}><div class="sb-rule-h" /></Show>
              <Show
                when={option().category === "thought_level"}
                fallback={
                  <div role="radiogroup" aria-label={option().name}>
                    <div class="sb-eyebrow">{`${option().name} · ${props.agentName}`}</div>
                    <Show when={option().category === "model" && hasCostTiers(option().choices)}>
                      <button class="sb-option sb-free-toggle" role="switch" aria-checked={freeOnly()} onClick={() => { setFreeOnly(!freeOnly()); writeFreeOnly(freeOnly()); }}>
                        <span class="sb-option-text">
                          <span class="sb-option-name">Free models only</span>
                          <span class="sb-sub wrap">{freeOnly() ? "Subscription and paid models are hidden" : "Showing every model"}</span>
                        </span>
                        <span class="sb-switch" aria-hidden="true"><span class="sb-switch-knob" /></span>
                      </button>
                    </Show>
                    <For each={tiers()}>
                      {(tier) => (
                        <>
                          <Show when={tier.cost}><div class="sb-eyebrow sb-tier">{COST_INFO[tier.cost!].chip}</div></Show>
                          <For each={tier.values}>
                            {(choiceValue) => {
                              let lastChoice = option().choices.find((candidate) => candidate.value === choiceValue)!;
                              const choice = () => (lastChoice = option().choices.find((candidate) => candidate.value === choiceValue) ?? lastChoice);
                              const current = () => choiceValue === option().currentValue;
                              const traits = () => modelTraits(choice(), { fastOn: current() && fastOn() });
                              return (
                                <button class="sb-option" role="radio" aria-checked={current()} disabled={props.busy} onClick={() => props.onSelect(option().id, choiceValue)}>
                                  <ModelIcon id={brand().id} name={brand().name} agentName={props.agentName} model={choice()} traits={traits()} />
                                  <span class="sb-option-text">
                                    <span class="sb-option-line">
                                      <span class="sb-option-name" title={choice().name}>{shownName(choice())}</span>
                                      <Show when={ambiguous(option().choices, choice())}><span class="sb-provider-tag">{choice().value.split("/")[0]}</span></Show>
                                      <Show when={chipTrait(traits(), choice().name)}>{(trait) => <TraitChip trait={trait()} />}</Show>
                                    </span>
                                    <Show when={choice().description}><span class="sb-sub wrap">{choice().description}</span></Show>
                                  </span>
                                  <Show when={current()}><Icon name="TickCircle" size={14} class="sb-accent" /></Show>
                                </button>
                              );
                            }}
                          </For>
                        </>
                      )}
                    </For>
                  </div>
                }
              >
                <EffortSlider
                  label={option().name}
                  options={option().choices}
                  value={option().currentValue}
                  defaultValue={defaultLevel(option().choices)}
                  disabled={props.busy}
                  modelName={modelNameOf(props.options)}
                  onModelClick={() => focusModelRow(root, props.options)}
                  onChange={(value) => props.onSelect(option().id, value)}
                />
              </Show>
            </>
          );
        }}
      </For>
    </div>
  );
}
