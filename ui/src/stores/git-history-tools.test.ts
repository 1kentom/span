import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { commands, GitContext, GitHistoryToolsPage_Serialize as GitHistoryToolsPage } from "../bindings";
import { createGitHistoryTools } from "./git-history-tools";
const context: GitContext = { enabled: true, workspaceRoot: "/work", unavailableReason: null, repository: { id: "repo", root: "/work", workspacePrefix: "", head: "head", branch: "main", detached: false, unborn: false } };
const page = (heads = ["snapshot"]): GitHistoryToolsPage => ({ heads, refs: [{ name: "refs/heads/main", commitId: "snapshot" }], commits: [], nextSkip: 50 });
function backend() {
  return { gitHistoryTools: vi.fn<typeof commands.gitHistoryTools>().mockResolvedValue(page()), gitReflogPage: vi.fn<typeof commands.gitReflogPage>().mockResolvedValue({ entries: [], nextSkip: null }), gitRevisionContent: vi.fn<typeof commands.gitRevisionContent>(), gitRevisionDiff: vi.fn<typeof commands.gitRevisionDiff>(), gitLineHistory: vi.fn<typeof commands.gitLineHistory>().mockResolvedValue({ repositoryId: "repo", anchor: "resolved", commits: [], nextSkip: 50 }) };
}
describe("advanced history requests", () => {
  it("sends structured filters and reuses captured heads and reference decorations across pages", async () => {
    await new Promise<void>((resolve, reject) => createRoot(dispose => { void (async () => {
      const transport = backend(), model = createGitHistoryTools({ context: () => context, transport });
      await model.search({ author: "Ada", message: "fix", path: "src/file.ts" });
      expect(transport.gitHistoryTools.mock.calls[0][1]).toEqual({ heads: [], skip: 0, limit: 50, author: "Ada", message: "fix", path: "src/file.ts" });
      transport.gitHistoryTools.mockResolvedValue({ ...page(["new-head"]), refs: [], nextSkip: null });
      await model.search({}, true);
      expect(transport.gitHistoryTools.mock.calls[1][1]).toEqual({ heads: ["snapshot"], skip: 50, limit: 50, author: "Ada", message: "fix", path: "src/file.ts" });
      expect(model.history()?.refs).toHaveLength(1);
      dispose(); resolve();
    })().catch(reject); }));
  });
  it("ignores superseded filter requests and repository changes but accepts refreshed context objects", async () => {
    await new Promise<void>((resolve, reject) => createRoot(dispose => { void (async () => {
      const [ctx, setContext] = createSignal(context), transport = backend();
      let finish!: (page: GitHistoryToolsPage) => void;
      transport.gitHistoryTools.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const model = createGitHistoryTools({ context: ctx, transport });
      const old = model.search({ message: "old" }); await model.search({ message: "new" }); finish(page(["old"])); await old;
      expect(model.history()?.heads).toEqual(["snapshot"]);
      setContext({ ...context, repository: { ...context.repository!, head: "moved" } }); await model.search({}, true);
      expect(transport.gitHistoryTools.mock.calls[2][1].heads).toEqual(["snapshot"]);
      transport.gitHistoryTools.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = model.search(); setContext({ ...context, workspaceRoot: "/other" }); finish(page(["stale"])); await pending;
      expect(model.history()).toBeUndefined(); dispose(); resolve();
    })().catch(reject); }));
  });
  it("validates numeric ranges and binds pagination to the submitted path, range and resolved revision", async () => {
    await new Promise<void>((resolve, reject) => createRoot(dispose => { void (async () => {
      const transport = backend(), model = createGitHistoryTools({ context: () => context, transport });
      await model.lineHistory("HEAD", "file", 0, 3); expect(transport.gitLineHistory).not.toHaveBeenCalled();
      await model.lineHistory("HEAD", "file", 2, 7);
      await model.lineHistory("different", "other", 1, 999, true);
      expect(transport.gitLineHistory.mock.calls[1]).toEqual([context, "resolved", "file", 2, 7, 50, 50]);
      dispose(); resolve();
    })().catch(reject); }));
  });
});
