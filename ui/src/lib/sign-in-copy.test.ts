import { describe, expect, it } from "vitest";
import { cleanAgentText, signInCopy } from "./sign-in-copy";

describe("cleanAgentText", () => {
  it("drops an empty trailing object the agent appended", () => {
    expect(cleanAgentText("Authentication required: provider authentication required: {}")).toBe("Authentication required: provider authentication required");
    expect(cleanAgentText("Authentication required:{ }  ")).toBe("Authentication required");
  });
  it("leaves other text alone", () => {
    expect(cleanAgentText("Authentication required")).toBe("Authentication required");
    expect(cleanAgentText("Bad key: {\"code\":1}")).toBe("Bad key: {\"code\":1}");
    expect(cleanAgentText("Use {} as a placeholder here")).toBe("Use {} as a placeholder here");
  });
});

describe("signInCopy", () => {
  const base = { agent: "OpenCode", message: "Authentication required: provider authentication required: {}", promptFailed: true, models: 3 };
  it("speaks about the model when a prompt failed and other models exist", () => {
    expect(signInCopy(base)).toEqual({ title: "Sign in to OpenCode", text: "OpenCode could not use this model. Pick another model or sign in.", secondary: false });
  });
  it("keeps the existing wording, cleaned, when no model can be offered", () => {
    expect(signInCopy({ ...base, models: 0 })).toEqual({ title: "Sign in to OpenCode", text: "Authentication required: provider authentication required", secondary: false });
    expect(signInCopy({ ...base, promptFailed: false })).toEqual({ title: "Sign in to OpenCode", text: "Authentication required: provider authentication required", secondary: false });
  });
  it("defers to the agent's own message when it is not a sign-in request", () => {
    expect(signInCopy({ ...base, agentMessage: "Quota exceeded" })).toEqual({ title: "Other sign-in options", text: undefined, secondary: true });
  });
});
