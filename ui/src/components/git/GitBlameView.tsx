import { For, Show } from "solid-js";
import type { GitLineInfo } from "../../stores/git-line-info";
import type { GitDecorations } from "../../stores/git-decorations";
import { createGitFileBlame } from "../../stores/git-file-blame";
import { gitCommitDate } from "../../lib/git-format";
import { Icon } from "../Icon";
import "../../styles/git-context.css";

export function GitBlameView(props: {
  info: GitLineInfo; decorations: GitDecorations; path: string; text?: string;
  onCommit: (commitId: string, path: string) => void;
  onHistory: (path: string) => void; onClose: () => void;
}) {
  const model = createGitFileBlame({ path: () => props.path, text: () => props.text, blame: () => props.info.blame(props.path), baseline: () => props.decorations.baseline(props.path) });
  return <section class="git-file-blame" aria-label={`File blame for ${props.path}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } }}>
    <header><strong>File blame</strong><span class="git-blame-path">{props.path}</span>
      <button type="button" aria-pressed={model.heatmap()} onClick={model.toggleHeatmap}>Age heatmap</button>
      <button type="button" onClick={() => props.onHistory(props.path)}>File history</button>
      <button type="button" aria-label="Close file blame" onClick={props.onClose}>×</button>
    </header>
    <Show when={model.heatmap()}><p class="git-blame-legend">Age: recent (under 30 days), months (under 180 days), older. Uncommitted lines have no age.</p></Show>
    <Show when={model.available()} fallback={<p role="status">{props.info.error() || "Blame unavailable. Exact HEAD text and file attribution are required. Large, binary, untracked or conflicted files may be unavailable."}</p>}>
      <div class="git-blame-scroll"><table><caption class="sr-only">Current buffer mapped to HEAD. Select a commit to review its changes.</caption><thead><tr><th scope="col">Line</th><th scope="col">Last commit</th><th scope="col">Code</th></tr></thead><tbody>
        <For each={model.rows()}>{row => <tr data-age={model.heatmap() && row.attribution ? model.age(row.attribution.timestamp) : undefined}>
          <th scope="row">{row.line}</th><td><Show when={row.attribution} fallback={<span>{row.changed ? "Uncommitted changes" : "Attribution unavailable"}</span>}>{entry => <button type="button" title={`${entry().author} <${entry().authorEmail}>\n${gitCommitDate(entry().timestamp).detail}\n${entry().summary}`} aria-label={`Review commit ${entry().commitId.slice(0, 8)} for line ${row.line}`} onClick={() => props.onCommit(entry().commitId, props.path)}><strong>{entry().author}</strong><span>{entry().commitId.slice(0, 8)} · {entry().summary}</span><time>{gitCommitDate(entry().timestamp).detail}</time></button>}</Show></td>
          <td><code>{row.text || " "}</code></td>
        </tr>}</For>
      </tbody></table></div>
      <footer><button type="button" aria-label="Previous blame page" disabled={model.page() === 0} onClick={model.previous}><Icon name="arrow-left4" size={14} /></button><span aria-live="polite">Page {model.page() + 1} of {model.pages()} · {model.total()} lines</span><button type="button" aria-label="Next blame page" disabled={model.page() + 1 >= model.pages()} onClick={model.next}><Icon name="arrow-right4" size={14} /></button></footer>
    </Show>
  </section>;
}
