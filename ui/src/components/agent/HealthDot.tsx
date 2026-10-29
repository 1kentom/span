import { healthText, healthTone, type AgentHealth } from "../../lib/agent-health";

/**
 * The health check dot of one agent (ADR 0010): green Live, amber Slow, red-ish Unreachable, grey Signed out or not
 * checked yet. The tooltip says what the last check found and when, for example "Replied OK in 1.2 s, 4 min ago".
 */
export function HealthDot(props: { health?: AgentHealth; now: number }) {
  const text = () => healthText(props.health, props.now);
  return <span class="sb-health" data-tone={healthTone(props.health)} title={text()} role="img" aria-label={`Health check: ${text()}`} />;
}
