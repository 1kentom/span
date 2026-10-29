import { Index, createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import {
  highlightFence,
  parseMarkdown,
  renderMarkdownBlock,
  type MarkdownBlock,
} from "./MarkdownPreview";
import { createStreamReveal } from "../lib/create-stream-reveal";
import { createIncrementalParser, offsetLines } from "../lib/incremental-markdown";
import "../styles/markdown.css";
import "../styles/stream-reveal.css";

/** How long newly shown text fades in. Keep in step with --stream-reveal-fade in stream-reveal.css. */
const FADE_MS = 160;

type AgentMarkdownProps = {
  text: string;
  workspaceRoot: string;
  /** Streaming text is revealed at a steady pace, parsed at most once per animation frame, and only its tail. */
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
};

type Fresh = { from: number; to: number; start: number };

/** Text nodes outside code blocks, in document order. Highlighting rewrites code blocks, so they never fade. */
function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

const textLength = (nodes: Text[]) => nodes.reduce((sum, node) => sum + node.data.length, 0);

/**
 * Wraps text added since the last render in fading spans. A range keeps fading across re-renders: its span is rebuilt
 * with a negative delay, so the animation resumes where it was instead of restarting or popping to full opacity.
 */
function fadeFresh(host: HTMLElement, fresh: Fresh[], previous: number, now: number): { length: number; fresh: Fresh[] } {
  const nodes = textNodes(host);
  const length = textLength(nodes);
  let live = length < previous ? [] : fresh.filter((range) => now - range.start < FADE_MS && range.to <= length);
  if (length > previous) live = [...live, { from: previous, to: length, start: now }];
  let offset = 0;
  for (const node of nodes) {
    const from = offset;
    offset += node.data.length;
    // Walk ranges from the end of the node so earlier split offsets stay valid.
    const hits = live.filter((range) => range.to > from && range.from < offset).reverse();
    let tail: Text = node;
    for (const range of hits) {
      const start = Math.max(range.from, from) - from;
      const end = Math.min(range.to, offset) - from;
      if (end < tail.data.length) tail.splitText(end);
      const piece = start > 0 ? tail.splitText(start) : tail;
      const span = document.createElement("span");
      span.className = "stream-fresh";
      span.style.animationDelay = `${-Math.round(now - range.start)}ms`;
      piece.replaceWith(span);
      span.append(piece);
    }
  }
  return { length, fresh: live };
}

function Block(props: { block: MarkdownBlock; context: { documentPath: string; workspaceRoot: string }; animate: Accessor<boolean> }) {
  let host!: HTMLDivElement;
  let previous = 0;
  let fresh: Fresh[] = [];
  const html = createMemo(() => renderMarkdownBlock(props.block, props.context));
  createEffect(() => {
    // Set the markup by hand so fading spans are added before the browser paints the new text.
    host.innerHTML = html();
    if (untrack(props.animate)) ({ length: previous, fresh } = fadeFresh(host, fresh, previous, performance.now()));
    else {
      previous = textLength(textNodes(host));
      fresh = [];
    }
    queueMicrotask(() => {
      for (const code of host.querySelectorAll<HTMLElement>("code[data-language]"))
        void highlightFence(code).catch(() => {
          /* Plain code stays readable if a language chunk cannot load. */
        });
    });
  });
  return <div ref={host} class="markdown-block" />;
}

/** Chat-sized markdown for agent output. Reuses the editor preview parser and its link policy. */
export function AgentMarkdown(props: AgentMarkdownProps) {
  const [blocks, setBlocks] = createSignal<MarkdownBlock[]>([]);
  const context = createMemo(() => ({
    documentPath: `${props.workspaceRoot}/.span-agent.md`,
    workspaceRoot: props.workspaceRoot,
    agentPaths: true,
  }));
  // The feed keeps the full text; only the paced prefix is parsed and drawn, once per animation frame at most.
  const reveal = createStreamReveal(() => props.text, () => Boolean(props.streaming));
  const parse = createIncrementalParser((source, line) => offsetLines(parseMarkdown(source), line));
  let rendered: string | undefined;
  createEffect(() => {
    const source = reveal.shown();
    if (source === rendered) return;
    rendered = source;
    const previous = new Map<string, MarkdownBlock[]>();
    for (const block of untrack(blocks)) {
      const group = previous.get(block.key);
      if (group) group.push(block);
      else previous.set(block.key, [block]);
    }
    setBlocks(parse(source).map((block) => previous.get(block.key)?.shift() ?? block));
  });
  function click(event: MouseEvent) {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("a")
        : null;
    if (!target) return;
    if (target.dataset.markdownFile) {
      event.preventDefault();
      props.onOpenFile?.(target.dataset.markdownFile);
    } else if (target.dataset.markdownExternal) {
      event.preventDefault();
      props.onOpenExternal?.(target.dataset.markdownExternal);
    } else if (target.hasAttribute("data-markdown-anchor") || target.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
    }
  }
  return (
    <div class="markdown-body agent-markdown" classList={{ "stream-revealing": reveal.revealing() }} onClick={click}>
      <Index each={blocks()}>{(block) => <Block block={block()} context={context()} animate={reveal.animate} />}</Index>
    </div>
  );
}
