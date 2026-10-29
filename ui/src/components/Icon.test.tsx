// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";
import { mount } from "./agent/test-utils";

describe("Icon", () => {
  it("turns the more dots a quarter turn everywhere and leaves other icons alone", () => {
    const dots = mount(() => <Icon name="3DotsMore" size={14} />).querySelector<HTMLElement>(".icon")!;
    expect(dots.style.transform).toBe("rotate(90deg)");
    const other = mount(() => <Icon name="Copy" size={14} />).querySelector<HTMLElement>(".icon")!;
    expect(other.style.transform).toBe("");
  });
  it("lets a caller's own transform win", () => {
    const icon = mount(() => <Icon name="3DotsMore" style={{ transform: "none" }} />).querySelector<HTMLElement>(".icon")!;
    expect(icon.style.transform).toBe("none");
  });
});
