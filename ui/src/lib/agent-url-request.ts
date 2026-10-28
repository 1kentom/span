/**
 * URL-mode elicitation (browser sign-in). ACP v1 carries `message`, `url` and `elicitationId` only: there is no
 * code field and no provider field. So the provider comes from the host through a small allowlist, and a device
 * code is read from the agent's message only when it has a documented shape. Everything here is untrusted input.
 */

/** Exact hosts (lowercase, no port) mapped to the name shown in the title. Anything else is "Open <host>". */
export const PROVIDER_HOSTS: Record<string, string> = {
  "github.com": "GitHub",
  "www.github.com": "GitHub",
  "gitlab.com": "GitLab",
  "bitbucket.org": "Bitbucket",
  "accounts.google.com": "Google",
  "login.microsoftonline.com": "Microsoft",
  "login.microsoft.com": "Microsoft",
  "login.live.com": "Microsoft",
  "microsoft.com": "Microsoft",
  "www.microsoft.com": "Microsoft",
};

/** Every user-visible string of the browser sign-in flow. */
export const URL_COPY = {
  openTitle: (host: string) => `Open ${host}`,
  authorizeTitle: (provider: string) => `Authorize ${provider}`,
  openBrowser: "Open browser",
  openAgain: "Open again",
  cancel: "Cancel",
  dismiss: "Dismiss",
  waitingBrowser: "Waiting for browser",
  enterCode: "Enter this code",
  codeLabel: "One-time code",
  codeDescription: "Code from the agent's message",
  copyCode: "Copy code",
  copied: "Copied",
  copyFailed: "Could not copy",
  activityUrl: "Waiting for you to finish in the browser",
  activityForm: "Waiting for your answer",
  consent: "Span opens this address in your browser only after you choose Open browser.",
  rejectNoUrl: "The agent sent no page address",
  rejectScheme: "Only http and https pages can be opened",
  cancelled: "Sign-in cancelled",
} as const;

export type UrlRejection = "noUrl" | "scheme";

export type UrlRequestView = {
  title: string;
  /** Lowercase host without port, punycode for international names. Empty when the URL is unusable. */
  host: string;
  /** The full address for the URL box, with the host split out so it can be emphasised. */
  displayUrl: string;
  parts: { scheme: string; userinfo: string; host: string; rest: string };
  /** The one-time code from the message, when it has a documented shape and is unambiguous. Never persist it. */
  code?: string;
  provider?: string;
  /** Sanitised, truncated message text, safe to render as text. */
  text: string;
  rejection?: UrlRejection;
};

const MESSAGE_MAX = 400;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Untrusted text: control and bidi characters out, whitespace collapsed, length capped. Render as text only. */
export function sanitizeMessage(raw: string | null | undefined, max = MESSAGE_MAX): string {
  const clean = (raw ?? "").replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** GitHub style device codes: XXXX-XXXX, uppercase letters and digits, not part of a longer token. */
const CODE_SHAPE = /(?<![A-Za-z0-9-])[A-Z0-9]{4}-[A-Z0-9]{4}(?![A-Za-z0-9-])/g;

/** Exactly one distinct candidate and the word "code" nearby, or nothing. Ambiguity shows no code. */
export function extractDeviceCode(message: string | null | undefined): string | undefined {
  const text = sanitizeMessage(message, 2000);
  if (!/\bcode\b/i.test(text)) return undefined;
  const found = new Set(text.match(CODE_SHAPE) ?? []);
  return found.size === 1 ? [...found][0] : undefined;
}

function parseHttpUrl(raw: string | null | undefined): { url?: URL; rejection?: UrlRejection } {
  const value = (raw ?? "").trim();
  if (!value) return { rejection: "noUrl" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { rejection: "scheme" };
  }
  return url.protocol === "http:" || url.protocol === "https:" ? { url } : { rejection: "scheme" };
}

/** The provider for a host, only through the allowlist. The host is the real one: userinfo and lookalikes never match. */
export function providerForHost(host: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_HOSTS, host) ? PROVIDER_HOSTS[host] : undefined;
}

export function parseUrlRequest(message: string | null | undefined, rawUrl: string | null | undefined): UrlRequestView {
  const text = sanitizeMessage(message);
  const { url, rejection } = parseHttpUrl(rawUrl);
  if (!url) {
    return { title: URL_COPY.openTitle(""), host: "", displayUrl: sanitizeMessage(rawUrl, 300), parts: { scheme: "", userinfo: "", host: "", rest: sanitizeMessage(rawUrl, 300) }, text, rejection };
  }
  const host = url.hostname.toLowerCase();
  const provider = providerForHost(host);
  const userinfo = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  const rest = `${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}${url.hash}`;
  const parts = { scheme: `${url.protocol}//`, userinfo, host, rest };
  const code = extractDeviceCode(message);
  return {
    title: provider ? URL_COPY.authorizeTitle(provider) : URL_COPY.openTitle(host),
    host,
    displayUrl: `${parts.scheme}${userinfo}${host}${rest}`,
    parts,
    provider,
    text,
    ...(code ? { code } : {}),
  };
}

export type UrlRecordStatus = "waiting" | "opened" | "completed" | "cancelled";

/** What the feed keeps about a sign-in request. Deliberately without the message, the code or the query string. */
export type UrlRecord = { requestId: string; elicitationId?: string; provider?: string; host: string; status: UrlRecordStatus; reason?: UrlRejection };

/** The one-line feed text for a record. */
export function urlRecordText(record: Pick<UrlRecord, "provider" | "host" | "status" | "reason">): string {
  const who = record.provider ?? record.host;
  switch (record.status) {
    case "waiting":
      return record.provider ? `Waiting for ${record.provider} sign-in · continue below` : `Waiting for ${who || "the browser"} · continue below`;
    case "opened":
      return record.provider ? `Opened ${record.provider} sign-in` : `Opened ${who}`;
    case "completed":
      return record.provider ? `Authorized ${record.provider}` : `Finished on ${who}`;
    case "cancelled": {
      const why = record.reason === "noUrl" ? URL_COPY.rejectNoUrl : record.reason === "scheme" ? URL_COPY.rejectScheme : "";
      return why ? `${URL_COPY.cancelled} · ${why}` : URL_COPY.cancelled;
    }
  }
}

/** The activity bar label: what the agent is waiting for while a dock is open. */
export function activityLabel(input: { stopRequested: boolean; mode?: string; browserWaiting?: boolean }): string {
  if (input.stopRequested) return "Stopping";
  if (input.mode === "url" || input.browserWaiting) return URL_COPY.activityUrl;
  if (input.mode === "form") return URL_COPY.activityForm;
  return "Working";
}
