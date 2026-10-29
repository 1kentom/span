import { Show, createMemo } from "solid-js";
import type { GitLineInfo } from "../../stores/git-line-info";
import type { GitDecorations } from "../../stores/git-decorations";
import { gitLineHunks, gitOriginalLine } from "../../lib/git-decorations";
import { gitCommitDate } from "../../lib/git-format";
import { Icon } from "../Icon";
import "../../styles/git-line-status.css";

export function GitLineStatus(props: {
  info: GitLineInfo;
  decorations: GitDecorations;
  path?: string;
  line: number;
  text?: string;
  onBlame?: (path: string) => void;
  onHistory: (path: string) => void;
}) {
  // Cursor motion reuses the exact text mapping instead of diffing the file again.
  const mapping = createMemo(() => {
    const baseline = props.path && props.decorations.baseline(props.path);
    return baseline && !baseline.binary && !baseline.truncated && baseline.headText != null && props.text !== undefined
      ? gitLineHunks(baseline.headText, props.text) : undefined;
  });
  const attribution = createMemo(() => {
    const blame = props.path ? props.info.blame(props.path) : undefined;
    const hunks = mapping();
    if (!blame || !hunks) return;
    const original = gitOriginalLine(hunks, props.line);
    return original === undefined ? { label: "Uncommitted changes", detail: "This line has changed since HEAD." }
      : (() => { const line = blame.lines.find(entry => entry.line === original); return line ? {
        label: line.author,
        detail: `${line.author} · ${gitCommitDate(line.timestamp).detail}\n${line.summary}\n${line.commitId.slice(0, 8)}. Open file blame and commit details.`,
      } : undefined; })();
  });
  return <Show when={attribution()}>{value => <button class="git-line-status" title={value().detail} aria-label={`Git authorship: ${value().label}. Open file blame`} onClick={() => props.path && (props.onBlame ?? props.onHistory)(props.path!)}><Icon name="Hierarchy" size={12} /><span>{value().label}</span></button>}</Show>;
}
