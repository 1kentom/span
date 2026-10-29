import { describe, expect, it } from "vitest";
import { hasCostTiers, modelCost } from "./model-cost";

const m = (value: string, name = value) => ({ value, name });

describe("modelCost", () => {
  it("marks explicit free models and Big Pickle as free", () => {
    expect(modelCost(m("opencode/beam-free", "opencode/Beam Free"))).toBe("free");
    expect(modelCost(m("opencode/big-pickle", "opencode/Big Pickle"))).toBe("free");
    expect(modelCost(m("opencode-go/iceman-contributor-free"))).toBe("free");
  });
  it("calls OpenCode Go a subscription and other hosted models paid", () => {
    expect(modelCost(m("opencode-go/glm-5"))).toBe("subscription");
    expect(modelCost(m("opencode/claude-opus-5-5"))).toBe("paid");
    expect(modelCost(m("anthropic/claude-haiku-5-5"))).toBe("paid");
  });
  it("does not match free inside another word", () => {
    expect(modelCost(m("x/carefree-pro"))).toBe("paid");
  });
  it("gives no tier to models without a provider prefix", () => {
    expect(modelCost(m("default", "Default (recommended)"))).toBeUndefined();
    expect(modelCost(m("gpt-5.6-luna", "GPT 5.6 Luna"))).toBeUndefined();
  });
  it("only has tiers worth filtering when free and non-free models mix", () => {
    expect(hasCostTiers([m("a/x-free"), m("a/y")])).toBe(true);
    expect(hasCostTiers([m("a/x"), m("a/y")])).toBe(false);
    expect(hasCostTiers([m("a"), m("b")])).toBe(false);
  });
});
