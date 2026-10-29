import { For, Show, type JSX } from 'solid-js';
import { materialIconUrl } from '../../lib/file-icons';
import Icon from '../Icon';

/** Decorative file-type icon from the app's Material icon set, drawn as backgrounds so it is never mistaken for a preview image. */
export function TypeIcon(props: { path: string }) {
  return <span class="vw-type-icon" aria-hidden="true">
    <span class="vw-type-icon-dark" style={{ 'background-image': `url('${materialIconUrl(props.path)}')` }} />
    <span class="vw-type-icon-light" style={{ 'background-image': `url('${materialIconUrl(props.path, { light: true })}')` }} />
  </span>;
}

export interface StateAction { label: string; onClick: () => void; primary?: boolean }
export type ViewerStateKind = 'loading' | 'too-large' | 'unsupported' | 'damaged' | 'gone';

/** One card for the edge states of Upload Viewer 1h. Every state says what happened and offers a next step. */
export function ViewerState(props: { kind: ViewerStateKind; title?: string; text: string; actions?: StateAction[]; icon?: JSX.Element; children?: JSX.Element }) {
  const alert = () => props.kind === 'damaged';
  return <div class={`vw-state vw-state-${props.kind}`} role={alert() ? 'alert' : 'status'} data-state={props.kind}>
    <Show when={props.kind === 'loading'}><span class="vw-shimmer" aria-hidden="true"><span /><span /></span></Show>
    <Show when={props.icon} fallback={<>
      <Show when={props.kind === 'damaged'}><Icon name="Warning2" size={18} /></Show>
      <Show when={props.kind === 'unsupported' || props.kind === 'gone' || props.kind === 'too-large'}><Icon name="InfoCircle" size={18} /></Show>
    </>}>{props.icon}</Show>
    <Show when={props.title}><strong class="vw-state-title">{props.title}</strong></Show>
    <p class="vw-state-text">{props.text}</p>
    {props.children}
    <Show when={props.actions?.length}><div class="vw-state-actions"><For each={props.actions}>{action => <button type="button" class="vw-btn" classList={{ 'vw-btn-primary': action.primary, 'vw-btn-outline': !action.primary }} onClick={action.onClick}>{action.label}</button>}</For></div></Show>
  </div>;
}
