import { For, Show, createMemo } from 'solid-js';
import { splitLines } from '../../lib/viewer';
import { HIGHLIGHT_MAX_CHARS, HIGHLIGHT_MAX_LINES, tokenizeLines, type SourceLanguage } from './highlight';
import { TextView } from './TextView';

/** Read-only, line-numbered source with light highlighting. Falls back to TextView for large files. */
export function CodeView(props: { text: string; name: string; language: SourceLanguage }) {
  const lines = createMemo(() => splitLines(props.text));
  const small = () => props.text.length <= HIGHLIGHT_MAX_CHARS && lines().length <= HIGHLIGHT_MAX_LINES;
  const tokens = createMemo(() => small() ? tokenizeLines(props.language, lines()) : []);
  return <Show when={small()} fallback={<TextView text={props.text} name={props.name} />}>
    <div class="vw-text" role="region" aria-label={`Source of ${props.name}, ${lines().length} lines`} tabIndex={0}>
      <pre class="vw-gutter" aria-hidden="true">{lines().map((_, i) => i + 1).join('\n')}</pre>
      <pre class="vw-code"><code><For each={tokens()}>{line => <>{line.map(token => token.c ? <span class={`vw-tok-${token.c}`}>{token.t}</span> : token.t)}{'\n'}</>}</For></code></pre>
    </div>
  </Show>;
}
