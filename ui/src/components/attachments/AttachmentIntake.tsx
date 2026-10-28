import { For, Show } from 'solid-js';
import Icon from '../Icon';
import type { Intake } from './intake';
import '../../styles/attachments.css';

/** Accessible list of refusals. Never silent: each rejected item is named with its reason. */
export function AttachmentNotices(props: { intake: Intake }) {
  return <Show when={props.intake.notices().length}>
    <div class="att-notices" role="alert">
      <ul><For each={props.intake.notices()}>{message => <li>{message}</li>}</For></ul>
      <button type="button" class="att-notice-dismiss" aria-label="Dismiss attachment messages" onClick={() => props.intake.dismissNotices()}><Icon name="CloseCircle" size={12} /></button>
    </div>
  </Show>;
}
