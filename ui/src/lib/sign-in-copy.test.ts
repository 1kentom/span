import { describe, expect, it } from "vitest";
import { cleanAgentText, gatewayPresets, methodLabel, presetHeaders, signInCopy } from "./sign-in-copy";

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

describe("gateway presets", () => {
  it("offers OpenRouter at the endpoint each protocol needs", () => {
    expect(gatewayPresets("anthropic").map((preset) => preset.baseUrl)).toEqual(["https://openrouter.ai/api"]);
    expect(gatewayPresets("openai").map((preset) => preset.baseUrl)).toEqual(["https://openrouter.ai/api/v1"]);
    expect(gatewayPresets("bedrock")).toEqual([]);
    expect(gatewayPresets(undefined)).toEqual([]);
  });
  it("sends the key as a bearer token only", () => {
    expect(presetHeaders("  sk-or-1 ")).toEqual({ Authorization: "Bearer sk-or-1" });
  });
  it("labels same-named methods by protocol and leaves unique names alone", () => {
    const methods = [{ id: "gateway", name: "Custom model gateway", protocol: "anthropic" }, { id: "gateway-bedrock", name: "Custom model gateway", protocol: "bedrock" }, { id: "login", name: "Log in" }];
    expect(methods.map((method) => methodLabel(method, methods))).toEqual(["Custom model gateway (Anthropic)", "Custom model gateway (Bedrock)", "Log in"]);
    expect(methodLabel(methods[0], [methods[0]])).toBe("Custom model gateway");
  });
});
