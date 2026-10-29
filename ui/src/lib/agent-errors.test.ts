import { describe, expect, it } from "vitest";
import { classifyAgentError, httpsLinks, isLimitKind, limitStatus, limitTitle, parseDuration, resetTime, waitText } from "./agent-errors";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const classify = (message: string, extra: { code?: number; data?: unknown; agent?: string } = {}) => classifyAgentError({ message, ...extra }, NOW);

// The exact text OpenCode sends when its free tier is used up, as the backend wraps it.
const OPENCODE_FREE =
  "Agent could not complete session/prompt: Internal error: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go";

describe("classifyAgentError", () => {
  it("reads the OpenCode free-tier limit with its plan link", () => {
    const info = classify(OPENCODE_FREE, { agent: "OpenCode" });
    expect(info).toMatchObject({ kind: "quota", provider: "OpenCode", freeTier: true, link: { url: "https://opencode.ai/go", host: "opencode.ai", label: "Open OpenCode Go" } });
    expect(info.resetAt).toBeUndefined();
    expect(limitTitle(info, NOW)).toBe("OpenCode free usage limit reached");
    expect(limitStatus(info)).toBe("Free limit reached");
  });

  it("reads Claude Code usage limits and their reset time", () => {
    const epoch = classify("Claude AI usage limit reached|1761746400");
    expect(epoch).toMatchObject({ kind: "quota", provider: "Claude", freeTier: false, resetAt: 1761746400_000 });
    const window = classify("5-hour limit reached ∙ resets 3pm", { agent: "Claude Code" });
    expect(window.kind).toBe("quota");
    expect(window.provider).toBe("Claude Code");
    const reset = new Date(window.resetAt!);
    expect(reset.getHours()).toBe(15);
    expect(window.resetAt! > NOW).toBe(true);
    expect(classify("Claude usage limit reached. Your limit will reset at 3pm").kind).toBe("quota");
    expect(limitStatus(epoch)).toBe("Usage limit reached");
  });

  it("reads OpenAI and Codex quota and rate limits", () => {
    const quota = classify("You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.");
    expect(quota).toMatchObject({ kind: "quota", provider: "OpenAI", link: { host: "platform.openai.com" } });
    expect(quota.link!.url.endsWith(".")).toBe(false);
    expect(classify('{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}').kind).toBe("quota");
    const rate = classify("Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 30000. Please try again in 20s.");
    expect(rate).toMatchObject({ kind: "rate_limit", resetAt: NOW + 20_000 });
    expect(limitTitle(rate, NOW)).toBe("Rate limited, try again in 20s");
    expect(limitTitle(rate, NOW + 25_000)).toBe("Rate limited");
  });

  it("reads Gemini RESOURCE_EXHAUSTED with its retry delay", () => {
    const info = classify('Internal error: {"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"36s"}]}}');
    expect(info).toMatchObject({ kind: "quota", provider: "Gemini", resetAt: NOW + 36_000 });
    expect(classify("Quota exceeded for quota metric 'Gemini 2.5 Pro Requests' and limit 'Gemini 2.5 Pro Requests per day per user per tier'").kind).toBe("quota");
  });

  it("reads OpenRouter credit errors and a bare 402 code", () => {
    expect(classify("402 Insufficient credits. Add more using https://openrouter.ai/settings/credits")).toMatchObject({ kind: "quota", provider: "OpenRouter", link: { host: "openrouter.ai" } });
    expect(classify("Payment failed", { code: 402 }).kind).toBe("quota");
    expect(classify("Your credit balance is too low to access the Anthropic API.").kind).toBe("quota");
  });

  it("reads rate limits and overloads with Retry-After", () => {
    expect(classify("Internal error: 429 Too Many Requests")).toMatchObject({ kind: "rate_limit" });
    expect(classify("rate limited", { data: { retry_after: 30 } })).toMatchObject({ kind: "rate_limit", resetAt: NOW + 30_000 });
    expect(classify("Too many requests. Retry-After: 12").resetAt).toBe(NOW + 12_000);
    expect(classify('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toMatchObject({ kind: "overloaded", provider: undefined });
    expect(classify("upstream returned 529")).toMatchObject({ kind: "overloaded" });
    expect(classify("Busy", { code: 429 }).kind).toBe("rate_limit");
  });

  it("keeps auth, context and ordinary errors out of the limit kinds", () => {
    expect(classify("Authentication required: provider authentication required").kind).toBe("auth");
    expect(classify("prompt is too long: 210000 tokens > 200000 maximum").kind).toBe("context_too_long");
    for (const message of ["Something odd", "Could not read src/limits.ts", "Command failed with exit code 1", "The free function returned null", "Prompt failed: file not found", "usage: span [options]", "quota.ts: syntax error"]) {
      const info = classify(message);
      expect(isLimitKind(info.kind), message).toBe(false);
    }
  });

  it("takes the provider from the text before the agent name", () => {
    expect(classify("Rate limited", { agent: "Codex" }).provider).toBe("Codex");
    expect(classify("OpenRouter: rate limited", { agent: "Codex" }).provider).toBe("OpenRouter");
  });
});

describe("helpers", () => {
  it("keeps only https links, without trailing punctuation or credentials", () => {
    expect(httpsLinks("see http://a.test, javascript:alert(1), https://b.test/x. and https://u:p@c.test/")).toEqual([{ url: "https://b.test/x", host: "b.test", index: expect.any(Number) }]);
  });

  it("parses durations and reset times", () => {
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("2h 10m")).toBe(7_800_000);
    expect(parseDuration("soon")).toBeUndefined();
    expect(resetTime("resets in 2h 10m", NOW)).toBe(NOW + 7_800_000);
    expect(resetTime("no hint", NOW)).toBeUndefined();
  });

  it("words waits", () => {
    expect(waitText(30_000)).toBe("30s");
    expect(waitText(245_000)).toBe("4m 05s");
    expect(waitText(7_800_000)).toBe("2h 10m");
  });
});
