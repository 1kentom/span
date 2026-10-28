import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../bindings";
import { initialAgentState, markUrlOpened, reduceAgentEvent, type AgentState, type FeedItem } from "./agent-session";
import { PROVIDER_HOSTS, activityLabel, extractDeviceCode, parseUrlRequest, sanitizeMessage, urlRecordText } from "./agent-url-request";

const GH = "Open https://github.com/login/device and enter the code WDJB-MJHT to sign in.";

describe("parseUrlRequest", () => {
  it.each([
    ["github device message", GH, "https://github.com/login/device", { host: "github.com", provider: "GitHub", title: "Authorize GitHub", code: "WDJB-MJHT" }],
    ["two different codes", "Use the code ABCD-1234 or the code WXYZ-9876", "https://github.com/login/device", { host: "github.com", provider: "GitHub", code: undefined }],
    ["the same code twice is one candidate", "Your code is ABCD-1234. Enter code ABCD-1234.", "https://github.com/login/device", { code: "ABCD-1234" }],
    ["no code", "Sign in to continue", "https://github.com/login", { code: undefined, title: "Authorize GitHub" }],
    ["code shape without the word code", "The mode is READ-ONLY", "https://github.com/login", { code: undefined }],
    ["lowercase is not a device code", "code abcd-1234", "https://github.com/login", { code: undefined }],
    ["unknown host", "Sign in", "https://auth.example.org/start", { host: "auth.example.org", provider: undefined, title: "Open auth.example.org" }],
    ["subdomain lookalike", "x", "https://github.com.evil.example/login", { host: "github.com.evil.example", provider: undefined, title: "Open github.com.evil.example" }],
    ["userinfo lookalike", "x", "https://github.com@evil.example/login", { host: "evil.example", provider: undefined, title: "Open evil.example" }],
    ["userinfo with password", "x", "https://github.com:pw@evil.example/", { host: "evil.example", provider: undefined }],
    ["uppercase host", "x", "HTTPS://GitHub.COM/login/device", { host: "github.com", provider: "GitHub" }],
    ["IDN host stays punycode", "x", "https://gıthub.com/login", { host: "xn--gthub-n4a.com", provider: undefined }],
    ["port", "x", "https://github.com:8443/login", { host: "github.com", provider: "GitHub" }],
    ["trailing dot is not the allowlisted host", "x", "https://github.com./login", { host: "github.com.", provider: undefined }],
    ["google", "x", "https://accounts.google.com/o/oauth2/device/usercode", { provider: "Google", title: "Authorize Google" }],
    ["microsoft", "x", "https://login.microsoftonline.com/common/oauth2/deviceauth", { provider: "Microsoft" }],
    ["gitlab", "x", "https://gitlab.com/oauth/device", { provider: "GitLab" }],
  ])("%s", (_name, message, url, expected) => {
    const view = parseUrlRequest(message, url);
    expect(view.rejection).toBeUndefined();
    for (const [key, value] of Object.entries(expected)) expect(view[key as keyof typeof view], key).toBe(value);
  });

  it("keeps the full URL for the box and splits the host out", () => {
    const view = parseUrlRequest("x", "https://github.com@evil.example:8443/a?token=1#f");
    expect(view.displayUrl).toBe("https://github.com@evil.example:8443/a?token=1#f");
    expect(view.parts).toEqual({ scheme: "https://", userinfo: "github.com@", host: "evil.example", rest: ":8443/a?token=1#f" });
  });

  it.each([
    ["", "noUrl"],
    [undefined, "noUrl"],
    ["javascript:alert(1)", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["ftp://github.com/x", "scheme"],
    ["not a url", "scheme"],
  ])("rejects %s", (url, rejection) => {
    const view = parseUrlRequest("m", url);
    expect(view.rejection).toBe(rejection);
    expect(view.host).toBe("");
  });

  it("maps only exact hosts in the table", () => {
    expect(Object.keys(PROVIDER_HOSTS).every((host) => host === host.toLowerCase() && !host.includes("/"))).toBe(true);
    expect(PROVIDER_HOSTS["github.com"]).toBe("GitHub");
  });
});

describe("message handling", () => {
  it("strips control and bidi characters and truncates", () => {
    expect(sanitizeMessage("a‮b\u0000c\n\n d")).toBe("abc d");
    const long = sanitizeMessage("x".repeat(1000));
    expect(long.length).toBe(400);
    expect(long.endsWith("…")).toBe(true);
  });
  it("keeps markup as inert text", () => {
    expect(sanitizeMessage("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
  it("extracts a code only when unambiguous", () => {
    expect(extractDeviceCode(GH)).toBe("WDJB-MJHT");
    expect(extractDeviceCode(null)).toBeUndefined();
    expect(extractDeviceCode("code AAAA-BBBB and CCCC-DDDD")).toBeUndefined();
    expect(extractDeviceCode("code XAAAA-BBBBX")).toBeUndefined();
  });
});

describe("record text", () => {
  const github = { provider: "GitHub", host: "github.com" };
  const other = { host: "auth.example.org" };
  it("reads per status", () => {
    expect(urlRecordText({ ...github, status: "waiting" })).toBe("Waiting for GitHub sign-in · continue below");
    expect(urlRecordText({ ...github, status: "opened" })).toBe("Opened GitHub sign-in");
    expect(urlRecordText({ ...github, status: "completed" })).toBe("Authorized GitHub");
    expect(urlRecordText({ ...other, status: "opened" })).toBe("Opened auth.example.org");
    expect(urlRecordText({ ...other, status: "waiting" })).toBe("Waiting for auth.example.org · continue below");
    expect(urlRecordText({ ...other, status: "completed" })).toBe("Finished on auth.example.org");
    expect(urlRecordText({ ...github, status: "cancelled" })).toBe("Sign-in cancelled");
    expect(urlRecordText({ host: "", status: "cancelled", reason: "scheme" })).toBe("Sign-in cancelled · Only http and https pages can be opened");
    expect(urlRecordText({ host: "", status: "cancelled", reason: "noUrl" })).toBe("Sign-in cancelled · The agent sent no page address");
  });
});

describe("activityLabel", () => {
  it("names what the agent waits for", () => {
    expect(activityLabel({ stopRequested: false })).toBe("Working");
    expect(activityLabel({ stopRequested: true, mode: "url" })).toBe("Stopping");
    expect(activityLabel({ stopRequested: false, mode: "url" })).toBe("Waiting for you to finish in the browser");
    expect(activityLabel({ stopRequested: false, browserWaiting: true })).toBe("Waiting for you to finish in the browser");
    expect(activityLabel({ stopRequested: false, mode: "form" })).toBe("Waiting for your answer");
  });
});

const ask = (patch: Partial<Extract<AgentEvent, { kind: "elicitation" }>> = {}): AgentEvent => ({
  kind: "elicitation", requestId: "e1", sessionId: "s1", toolCallId: null, mode: "url", message: GH, schemaJson: null, url: "https://github.com/login/device?user_code=WDJB-MJHT&t=secret#frag", elicitationId: "x1", ...patch,
});
const apply = (events: AgentEvent[], state: AgentState = initialAgentState(true)) => events.reduce(reduceAgentEvent, state);
const records = (state: AgentState) => state.feed.filter((item): item is Extract<FeedItem, { kind: "signin" }> => item.kind === "signin");

describe("sign-in feed records in the reducer", () => {
  it("adds one waiting record on arrival, without the code, message or query string", () => {
    const state = apply([ask()]);
    expect(records(state)).toHaveLength(1);
    expect(records(state)[0]).toMatchObject({ requestId: "e1", elicitationId: "x1", provider: "GitHub", host: "github.com", status: "waiting" });
    const dump = JSON.stringify(state.feed);
    for (const secret of ["WDJB-MJHT", "secret", "frag", "user_code", "enter the code"]) expect(dump).not.toContain(secret);
    expect(apply([ask(), ask()]).feed).toHaveLength(1);
  });

  it("form requests get no record", () => {
    expect(records(apply([ask({ mode: "form", url: null })]))).toHaveLength(0);
  });

  it("opening marks the record, the agent finishing completes it", () => {
    const opened = markUrlOpened(apply([ask()]), "e1");
    expect(records(opened)[0].status).toBe("opened");
    const resolved = reduceAgentEvent(opened, { kind: "elicitationResolved", requestId: "e1" });
    expect(records(resolved)[0].status).toBe("opened");
    const done = reduceAgentEvent(resolved, { kind: "elicitationComplete", elicitationId: "x1" });
    expect(records(done)[0].status).toBe("completed");
    expect(done.feed.some((item) => item.kind === "note")).toBe(false);
  });

  it("a resolve without opening reads as cancelled, and a late open mark still wins", () => {
    const cancelled = apply([ask(), { kind: "elicitationResolved", requestId: "e1" }]);
    expect(records(cancelled)[0].status).toBe("cancelled");
    expect(records(markUrlOpened(cancelled, "e1"))[0].status).toBe("opened");
  });

  it("completion for an unknown elicitation keeps the old note", () => {
    const state = apply([{ kind: "elicitationComplete", elicitationId: "nope" }]);
    expect(state.feed.map((item) => item.kind)).toEqual(["note"]);
  });

  it("a disconnect cancels waiting records and keeps opened ones", () => {
    const state = markUrlOpened(apply([ask(), ask({ requestId: "e2", elicitationId: "x2" })]), "e1");
    const gone = reduceAgentEvent(state, { kind: "status", state: "disconnected", message: "gone" } as AgentEvent);
    expect(records(gone).map((item) => item.status)).toEqual(["opened", "cancelled"]);
    expect(gone.elicitations).toEqual([]);
  });

  it("unusable URLs get a cancelled record with the reason", () => {
    expect(records(apply([ask({ url: "javascript:alert(1)" })]))[0]).toMatchObject({ status: "cancelled", reason: "scheme" });
    expect(records(apply([ask({ url: null })]))[0]).toMatchObject({ status: "cancelled", reason: "noUrl" });
  });

  it("queues oldest first and clears the code from state once resolved", () => {
    const state = apply([ask(), ask({ requestId: "e2", elicitationId: "x2", message: "code AAAA-1111", url: "https://gitlab.com/x" })]);
    expect(state.elicitations.map((item) => item.requestId)).toEqual(["e1", "e2"]);
    expect(records(state).map((item) => item.requestId)).toEqual(["e1", "e2"]);
    expect(JSON.stringify(state)).toContain("WDJB-MJHT");
    const after = apply([{ kind: "elicitationResolved", requestId: "e1" }, { kind: "elicitationResolved", requestId: "e2" }], state);
    expect(after.elicitations).toEqual([]);
    expect(JSON.stringify(after)).not.toMatch(/WDJB-MJHT|AAAA-1111/);
  });
});
