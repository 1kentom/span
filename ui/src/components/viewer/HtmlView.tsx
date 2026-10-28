import { Show, createMemo } from 'solid-js';
import Icon from '../Icon';
import { sanitizeHtmlForSandbox } from './html-sandbox';

/**
 * HTML preview in an iframe with an empty sandbox (no allow-scripts, no allow-same-origin) and a srcdoc built
 * from the sanitised file. Referenced local files are never loaded; they are listed in the warning.
 */
export function HtmlView(props: { text: string; name: string }) {
  const result = createMemo(() => sanitizeHtmlForSandbox(props.text));
  return <div class="vw-html">
    <div class="vw-html-bar">
      <span class="vw-chip vw-chip-ok"><Icon name="Check" size={11} />Sandboxed: scripts and network blocked</span>
      <Show when={result().missing.length}>
        <span class="vw-chip vw-chip-warn" role="note"><Icon name="Warning2" size={11} />Not in this upload: {result().missing.join(', ')}</span>
      </Show>
    </div>
    <iframe class="vw-html-frame" sandbox="" referrerpolicy="no-referrer" title={`Sandboxed preview of ${props.name}`} srcdoc={result().html} />
  </div>;
}
