import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Icon } from "../Icon";
import type { AgentController } from "../../lib/agent-controller";
import { countText, findMatches, firstVisible, registerFeedFind, stepIndex } from "../../lib/feed-find";

/** Re-search this long after the feed last changed while the bar is open (streaming changes it every frame). */
const REFRESH_MS = 150;

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = (): HighlightRegistry | undefined => (typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: HighlightRegistry }).highlights : undefined);
const HighlightClass = (): (new (...ranges: Range[]) => unknown) | undefined => (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const modifier = (event: KeyboardEvent) => event.metaKey || event.ctrlKey;

/**
 * Find in thread and message navigation for one agent panel. Find (Cmd+F or Ctrl+F, routed here by the app while focus
 * is in the panel) opens a bar over the feed: matches are highlighted with the CSS Custom Highlight API, Enter and
 * Shift+Enter step through them, Escape closes. Cmd+Up and Cmd+Down (Ctrl outside macOS) jump between your messages.
 */
export function FeedFind(props: { agent: AgentController; scope: () => HTMLElement | undefined; feed: () => HTMLElement | undefined }) {
  const a = props.agent;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [ranges, setRanges] = createSignal<Range[]>([]);
  const [active, setActive] = createSignal(-1);
  let input: HTMLInputElement | undefined;

  const paint = () => {
    const registry = highlights();
    const Highlight = HighlightClass();
    if (!registry || !Highlight) return;
    const list = ranges();
    const current = list[active()];
    if (!open() || !list.length) {
      registry.delete("feed-find");
      registry.delete("feed-find-active");
      return;
    }
    registry.set("feed-find", new Highlight(...list.filter((range) => range !== current)));
    if (current) registry.set("feed-find-active", new Highlight(current));
    else registry.delete("feed-find-active");
  };
  const reveal = () => {
    const range = ranges()[active()];
    if (range) a.follow.reveal(range);
  };
  /** Searches again. A new query starts at the first match in view; a refresh after the feed changed keeps the place. */
  const search = (fresh: boolean) => {
    const feed = props.feed();
    const list = feed && open() ? findMatches(feed, query()) : [];
    setRanges(list);
    const scroller = a.scrollers.content;
    if (fresh) setActive(list.length ? firstVisible(list, scroller?.getBoundingClientRect().top ?? 0) : -1);
    else setActive(list.length ? Math.min(Math.max(active(), 0), list.length - 1) : -1);
    paint();
    if (fresh) reveal();
  };
  const step = (back = false) => {
    if (!ranges().length) return;
    setActive(stepIndex(active(), ranges().length, back));
    paint();
    reveal();
  };
  const show = () => {
    setOpen(true);
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
    if (query()) search(true);
  };
  const close = () => {
    setOpen(false);
    setRanges([]);
    setActive(-1);
    paint();
    a.scrollers.content?.focus({ preventScroll: true });
  };

  createEffect(on(query, () => open() && search(true), { defer: true }));
  // Streaming changes the feed every frame: refresh the matches once it has been quiet for a moment.
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(a.feed, () => {
    if (!open() || !query()) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      search(false);
    }, REFRESH_MS);
  }, { defer: true }));
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
    highlights()?.delete("feed-find");
    highlights()?.delete("feed-find-active");
  });

  /** Your previous or next message relative to the view top. */
  const jumpMessage = (back: boolean) => {
    const feed = props.feed();
    const scroller = a.scrollers.content;
    if (!feed || !scroller) return false;
    const top = scroller.getBoundingClientRect().top + 16;
    const messages = [...feed.querySelectorAll<HTMLElement>(".agent-message.user")];
    const target = back ? messages.filter((message) => message.getBoundingClientRect().top < top - 4).at(-1) : messages.find((message) => message.getBoundingClientRect().top > top + 4);
    if (!target) return false;
    a.follow.reveal(target, "start");
    return true;
  };

  createEffect(() => {
    const scope = props.scope();
    if (!scope) return;
    const unregister = registerFeedFind(scope, show);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !modifier(event) || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest(".cm-editor")) return;
      // The app routes Find here when focus is in the panel; typing in the composer reaches this listener instead.
      if (event.key.toLowerCase() === "f" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        show();
        return;
      }
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !typing(target) && jumpMessage(event.key === "ArrowUp")) event.preventDefault();
    };
    scope.addEventListener("keydown", keydown);
    onCleanup(() => {
      unregister();
      scope.removeEventListener("keydown", keydown);
    });
  });

  const keys = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <Show when={open()}>
      <div class="agent-find" role="search" aria-label="Find in thread" data-find-skip>
        <Icon name="SearchNormal1" size={13} />
        <input ref={input} class="agent-find-input" type="text" placeholder="Find in thread" aria-label="Find in thread" spellcheck={false} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={keys} />
        <span class="agent-find-count" aria-live="polite">{query() ? countText(active(), ranges().length) : ""}</span>
        <button type="button" class="sb-icon-btn" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!ranges().length} onClick={() => step(true)}>
          <Icon name="arrow-up3" size={12} />
        </button>
        <button type="button" class="sb-icon-btn" aria-label="Next match" title="Next match (Enter)" disabled={!ranges().length} onClick={() => step()}>
          <Icon name="arrow-down4" size={12} />
        </button>
        <button type="button" class="sb-icon-btn" aria-label="Close find" title="Close (Escape)" onClick={close}>
          <Icon name="Close" size={12} />
        </button>
      </div>
    </Show>
  );
}
