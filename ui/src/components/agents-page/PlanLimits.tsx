import { For, Show } from "solid-js";
import { resetText, type PlanLimit } from "../../lib/agents-page";
import { BrandIcon } from "../BrandIcon";

/**
 * The rail footer: one meter per installed agent. ACP reports no plan usage, so a meter shows only what Span saw: a
 * usage limit a model hit (with its reset time when the agent said it) or that no limit was reported.
 */
export function PlanLimits(props: { limits: PlanLimit[]; now: number }) {
  const describe = (limit: PlanLimit) =>
    limit.limited ? `${limit.name}: usage limit reached${limit.models.length ? ` on ${limit.models.join(", ")}` : ""}, ${resetText(limit.resetAt, props.now)}` : `${limit.name}: no usage limit reported`;
  return (
    <Show when={props.limits.length}>
      <section class="ap-limits" aria-label="Plan limits">
        <div class="ap-limits-head">
          <span class="ap-grow">Plan limits</span>
          <span class="ap-limits-hint">From limits agents reported</span>
        </div>
        <ul class="ap-limits-grid">
          <For each={props.limits}>
            {(limit) => (
              <li class="ap-limit" data-limited={limit.limited ? "true" : undefined} title={describe(limit)} aria-label={describe(limit)} tabIndex={0}>
                <span class="ap-limit-ring" aria-hidden="true">
                  <BrandIcon id={limit.id} name={limit.name} size={16} />
                </span>
                <span class="ap-limit-value">{limit.limited ? "Limited" : "No limit"}</span>
                <span class="ap-limit-window">{limit.limited ? resetText(limit.resetAt, props.now).replace("reset time unknown", "reset unknown") : limit.name}</span>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}
