import { Show } from "solid-js";

/** Marks the matched text of a result line. */
export function MatchedText(props: { text: string; start?: number; end?: number }) {
  const start = () => Math.max(0, Math.min(props.text.length, props.start ?? 0));
  const end = () => Math.max(start(), Math.min(props.text.length, props.end ?? start()));
  return <><span>{props.text.slice(0, start())}</span><Show when={end() > start()}><mark>{props.text.slice(start(), end())}</mark></Show><span>{props.text.slice(end())}</span></>;
}

