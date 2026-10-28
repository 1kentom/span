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
