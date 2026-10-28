import { Index, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  highlightFence,
  parseMarkdown,
  renderMarkdownBlock,
  type MarkdownBlock,
} from "./MarkdownPreview";
import "../styles/markdown.css";

type AgentMarkdownProps = {
  text: string;
  workspaceRoot: string;
  /** Streaming text is re-parsed at most every 60 ms. */
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
};

function Block(props: { block: MarkdownBlock; context: { documentPath: string; workspaceRoot: string } }) {
  let host!: HTMLDivElement;
  const html = createMemo(() => renderMarkdownBlock(props.block, props.context));
  createEffect(() => {
    html();
    queueMicrotask(() => {
      for (const code of host.querySelectorAll<HTMLElement>("code[data-language]"))
        void highlightFence(code).catch(() => {
          /* Plain code stays readable if a language chunk cannot load. */
        });
    });
  });
  return <div ref={host} class="markdown-block" innerHTML={html()} />;
}

/** Chat-sized markdown for agent output. Reuses the editor preview parser and its link policy. */
export function AgentMarkdown(props: AgentMarkdownProps) {
  const [blocks, setBlocks] = createSignal<MarkdownBlock[]>([]);
  const context = createMemo(() => ({
    documentPath: `${props.workspaceRoot}/.span-agent.md`,
    workspaceRoot: props.workspaceRoot,
  }));
  let timer: number | undefined;
  let rendered: string | undefined;
  const update = (source: string) => {
    timer = undefined;
    rendered = source;
    const previous = new Map<string, MarkdownBlock[]>();
    for (const block of blocks()) {
      const group = previous.get(block.key);
      if (group) group.push(block);
      else previous.set(block.key, [block]);
    }
    setBlocks(
      parseMarkdown(source).map((block) => previous.get(block.key)?.shift() ?? block),
    );
  };
  createEffect(() => {
    const source = props.text;
    if (source === rendered) return;
    if (!props.streaming || rendered === undefined) update(source);
    else if (timer === undefined) timer = window.setTimeout(() => update(props.text), 60);
  });
  onCleanup(() => {
    if (timer !== undefined) window.clearTimeout(timer);
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
    <div class="markdown-body agent-markdown" onClick={click}>
      <Index each={blocks()}>{(block) => <Block block={block()} context={context()} />}</Index>
    </div>
  );
}
