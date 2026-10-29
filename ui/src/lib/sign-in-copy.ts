/** Agent text with an empty trailing object removed: OpenCode appends ": {}" when its error carries no data. */
export function cleanAgentText(message: string): string {
  return message.replace(/:\s*\{\s*\}\s*$/, "").trim();
}

type SignInCopyInput = {
  /** The agent's display name, for example "OpenCode". */
  agent: string;
  /** The short message from the authRequired event. */
  message: string;
  /** The agent's own text when it is not a sign-in request. */
  agentMessage?: string;
  /** True when a prompt in an open session was refused, so another model can take it. */
  promptFailed: boolean;
  /** How many other models the card offers. */
  models: number;
};

/** Title and lede of the sign-in card. */
export function signInCopy(input: SignInCopyInput): { title: string; text?: string; secondary: boolean } {
  if (input.agentMessage) return { title: "Other sign-in options", text: undefined, secondary: true };
  const title = `Sign in to ${input.agent}`;
  if (input.promptFailed && input.models > 0) return { title, text: `${input.agent} could not use this model. Pick another model or sign in.`, secondary: false };
  return { title, text: cleanAgentText(input.message), secondary: false };
}

/** A provider whose gateway URL Span knows, so the user only types a key. */
export type GatewayPreset = {
  id: string;
  name: string;
  baseUrl: string;
  /** The key travels as `Authorization: Bearer <key>`. */
  keyLabel: string;
  /** What is not guaranteed or not verified for this agent and provider. */
  note: string;
};

const OPENROUTER = { id: "openrouter", name: "OpenRouter", keyLabel: "OpenRouter API key" } as const;

/**
 * Presets for a gateway method by the protocol the agent expects from it: Claude Code speaks `anthropic` and Codex
 * `openai`. A protocol with no known preset (Bedrock, Google, none) gets only the custom form.
 */
export function gatewayPresets(protocol: string | undefined): GatewayPreset[] {
  if (protocol === "anthropic") {
    return [{ ...OPENROUTER, baseUrl: "https://openrouter.ai/api", note: "OpenRouter supports only Anthropic models for Claude Code. Others may fail. Not yet verified in Span." }];
  }
  if (protocol === "openai") {
    return [{ ...OPENROUTER, baseUrl: "https://openrouter.ai/api/v1", note: "OpenRouter's Responses API keeps no server state. Not yet verified with Codex in Span." }];
  }
  return [];
}

/** The headers a preset sends: the key as a bearer token, nothing else. */
export function presetHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key.trim()}` };
}

type NamedMethod = { id: string; name: string; protocol?: string };

const PROTOCOL_NAMES: Record<string, string> = { anthropic: "Anthropic", bedrock: "Bedrock", openai: "OpenAI", google: "Google" };

/**
 * The button label for a sign-in method. Claude Code names its `anthropic` and `bedrock` gateways the same, so a
 * gateway whose name another method shares gets its protocol after it.
 */
export function methodLabel(method: NamedMethod, methods: readonly NamedMethod[]): string {
  const shared = methods.some((other) => other.id !== method.id && other.name === method.name);
  const protocol = method.protocol && (PROTOCOL_NAMES[method.protocol] ?? method.protocol);
  return shared && protocol ? `${method.name} (${protocol})` : method.name;
}
