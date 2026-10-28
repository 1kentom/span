import { For, Show, type JSX } from 'solid-js';
import Icon from '../Icon';

export interface StateAction { label: string; onClick: () => void; primary?: boolean }
export type ViewerStateKind = 'loading' | 'too-large' | 'unsupported' | 'damaged' | 'gone';

/** One card for the edge states of Upload Viewer 1h. Every state says what happened and offers a next step. */
export function ViewerState(props: { kind: ViewerStateKind; title?: string; text: string; actions?: StateAction[]; children?: JSX.Element }) {
  const alert = () => props.kind === 'damaged';
  return <div class={`vw-state vw-state-${props.kind}`} role={alert() ? 'alert' : 'status'} data-state={props.kind}>
    <Show when={props.kind === 'loading'}><span class="vw-spinner" aria-hidden="true" /></Show>
    <Show when={props.kind === 'damaged'}><Icon name="Warning2" size={18} /></Show>
    <Show when={props.kind === 'unsupported' || props.kind === 'gone' || props.kind === 'too-large'}><Icon name="InfoCircle" size={18} /></Show>
    <Show when={props.title}><strong class="vw-state-title">{props.title}</strong></Show>
    <p class="vw-state-text">{props.text}</p>
    {props.children}
    <Show when={props.actions?.length}><div class="vw-state-actions"><For each={props.actions}>{action => <button type="button" class="vw-btn" classList={{ 'vw-btn-primary': action.primary }} onClick={action.onClick}>{action.label}</button>}</For></div></Show>
  </div>;
}
