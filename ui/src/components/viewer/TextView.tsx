import { createMemo } from 'solid-js';
import { lineNumberColumn, splitLines } from '../../lib/viewer';

/**
 * Read-only text with line numbers. One gutter and one code element (not one node per line) so that a
 * 2 MiB preview stays cheap. No syntax highlighting yet: the workspace editor's highlighter is not reused here.
 */
export function TextView(props: { text: string; name: string }) {
  const count = createMemo(() => splitLines(props.text).length);
  return <div class="vw-text" role="region" aria-label={`Text of ${props.name}, ${count()} lines`} tabIndex={0}>
    <pre class="vw-gutter" aria-hidden="true">{lineNumberColumn(count())}</pre>
    <pre class="vw-code"><code>{props.text}</code></pre>
  </div>;
}
