import { For, Show } from "solid-js";
import type { ToolEvent } from "../lib/agent-feed";
import { toolSummary } from "../lib/agent-feed";
import { Icon } from "./Icon";

const label = (status: string | null | undefined) => status?.replaceAll("_", " ") || "pending";
const hasDetails = (json: string) => Boolean(json) && json !== "null" && json !== "[]";

/** A tool call card. Calls an agent attributes to a subagent nest under the call that started it. */
export function AgentTool(props: { tool: ToolEvent; children: ToolEvent[] }) {
  const busy = () => !["completed", "failed"].includes(props.tool.status ?? "");
  const done = () => props.children.filter((child) => child.status === "completed").length;
  return (
    <article class="agent-card" classList={{ subagent: props.children.length > 0 }}>
      <div class="agent-card-header">
        <Icon name="Code1" size={14} />
        <span class="agent-card-title">
          {props.tool.title || "Agent tool"}
          <Show when={props.tool.toolKind}>
            <small class="agent-tool-kind">{props.tool.toolKind}</small>
          </Show>
        </span>
        <span class={`agent-state ${props.tool.status || ""}`}>{label(props.tool.status)}</span>
      </div>
      <Show when={props.children.length}>
        <details class="agent-subagent" open={busy()}>
          <summary>
            Subagent activity · {done()}/{props.children.length} done
          </summary>
          <ul>
            <For each={props.children}>
              {(child) => (
                <li>
                  <span class={`agent-dot-small ${child.status || ""}`} aria-hidden="true" />
                  <span class="agent-subagent-title" title={toolSummary(child.contentJson)}>
                    {child.title || "Tool call"}
                    <Show when={toolSummary(child.contentJson)}>
                      <small>{toolSummary(child.contentJson)}</small>
                    </Show>
                  </span>
                  <span class={`agent-state ${child.status || ""}`}>{label(child.status)}</span>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={hasDetails(props.tool.contentJson)}>
        <details>
          <summary class="agent-card-body">Tool details</summary>
          <pre class="agent-card-body">
            {props.tool.contentJson.slice(0, 18000)}
            {props.tool.contentJson.length > 18000
              ? "\n[Details truncated. Inspect ACP log for recent transport lines.]"
              : ""}
          </pre>
        </details>
      </Show>
    </article>
  );
}
