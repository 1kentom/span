// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { WarningNote } from "./Banners";
import { mount } from "./test-utils";

const title = "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.";
const description = "user (/home/dev/.codex/config.toml): mcp_servers.serverA.type is ignored. user (/home/dev/.codex/config.toml): mcp_servers.serverB.type is ignored.";
const buttons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(".sb-config-file")];

describe("config file button on a warning", () => {
  it("offers one button for the Codex config file, with the short path as tooltip", () => {
    const host = mount(() => <WarningNote title={title} description={description} onCopyPath={() => undefined} />);
    const found = buttons(host);
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toContain("Copy path");
    expect(found[0].title).toBe("Copy ~/.codex/config.toml");
    expect(found[0].getAttribute("aria-label")).toBe("Copy path of config.toml");
  });
  it("offers nothing when the warning names no file", () => {
    const host = mount(() => <WarningNote title="Rate limit is close." description="Slow down." onCopyPath={() => undefined} />);
    expect(buttons(host)).toHaveLength(0);
  });
  it("offers nothing without a handler", () => {
    const host = mount(() => <WarningNote title={title} description={description} />);
    expect(buttons(host)).toHaveLength(0);
  });
  it("finds a path inside a markdown code span", () => {
    const host = mount(() => <WarningNote title="Bad setting." description="See `/home/dev/.codex/config.toml` for details." onCopyPath={() => undefined} />);
    expect(buttons(host)).toHaveLength(1);
  });
  it("passes the full path to the handler on click and confirms", () => {
    const copy = vi.fn();
    const host = mount(() => <WarningNote title={title} description={description} onCopyPath={copy} />);
    buttons(host)[0].click();
    expect(copy).toHaveBeenCalledWith("/home/dev/.codex/config.toml");
    expect(buttons(host)[0].textContent).toContain("Copied");
  });
});
