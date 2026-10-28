// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ErrorCard, OfflineBar, StopCard, Notice, ContextBanner } from "./Banners";
import { UsageRing } from "./UsageRing";
import { mount, text } from "./test-utils";

describe("ErrorCard", () => {
  it("uses alert for errors, status for warnings, and runs actions", () => {
    const retry = vi.fn();
    const host = mount(() => (
      <ErrorCard level="error" title="Agent exited" text="Process ended" code="E_EXIT" log={["line one", "line two"]}
        countdown={{ remaining: 3, total: 10 }} actions={[{ label: "Retry", primary: true, onAct: retry }, { label: "Open log", onAct: () => {} }]} />
    ));
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    expect(text(host.querySelector(".sb-countdown"))).toContain("Retrying in 3s");
    expect(host.querySelector<HTMLElement>(".drain")!.style.transform).toBe("scaleX(0.3)");
    expect(host.querySelectorAll(".sb-logbox div")).toHaveLength(2);
    expect(host.querySelector(".sb-btn.primary")!.textContent).toBe("Retry");
    host.querySelector<HTMLButtonElement>(".sb-btn.primary")!.click();
    expect(retry).toHaveBeenCalledOnce();
    const warn = mount(() => <ErrorCard level="warn" title="Slow" actions={[]} />);
    expect(warn.querySelector("[role=status]")).not.toBeNull();
    expect(warn.querySelector(".sb-logbox")).toBeNull();
  });
});

describe("OfflineBar, StopCard, Notice", () => {
  it("retries from the offline bar", () => {
    const retry = vi.fn();
    const host = mount(() => <OfflineBar text="Reconnecting" onRetry={retry} />);
    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(retry).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("You're offline");
  });
  it("continues from a stop card", () => {
    const onContinue = vi.fn();
    const host = mount(() => <StopCard title="Reached the token limit" code="max_tokens" text="Stopped early." onContinue={onContinue} secondary={{ label: "Start over", onAct: () => {} }} />);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Continue", "Start over"]);
    host.querySelector<HTMLButtonElement>("button")!.click();
    expect(onContinue).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("max_tokens");
  });
  it("labels the notice divider", () => {
    const host = mount(() => <Notice text="Session resumed" />);
    expect(host.querySelector("[role=separator]")!.getAttribute("aria-label")).toBe("Session resumed");
  });
});

describe("ContextBanner and UsageRing", () => {
  it("offers Compact now only when the agent can compact", () => {
    const compact = vi.fn();
    const without = mount(() => <ContextBanner used={90} size={100} onCompact={compact} />);
    expect(without.textContent).not.toContain("Compact now");
    expect(without.textContent).toContain("Context 90% full");
    const withIt = mount(() => <ContextBanner used={90} size={100} canCompact onCompact={compact} />);
    withIt.querySelector<HTMLButtonElement>(".sb-btn.primary")!.click();
    expect(compact).toHaveBeenCalledOnce();
    expect(withIt.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("90");
  });
  it("turns the ring to the warning colour above 85 percent and reports cost", () => {
    const low = mount(() => <UsageRing used={85} size={100} />);
    expect(low.querySelector(".sb-ring")!.classList.contains("warn")).toBe(false);
    const high = mount(() => <UsageRing used={86} size={100} cost={{ amount: 0.5, currency: "USD" }} />);
    const ring = high.querySelector(".sb-ring")!;
    expect(ring.classList.contains("warn")).toBe(true);
    expect(ring.getAttribute("aria-label")).toContain("86 of 100");
    expect(ring.getAttribute("aria-label")).toContain("Cost");
    expect(text(ring)).toContain("86%");
  });
  it("clamps nonsense sizes", () => {
    const host = mount(() => <UsageRing used={5} size={0} />);
    expect(text(host.querySelector(".sb-ring"))).toContain("0%");
  });
});
