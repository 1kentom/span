import { Show } from "solid-js";
import { Icon } from "../Icon";

export interface FollowPillProps {
  following: boolean;
  onToggle: () => void;
}

/** Header toggle for following the agent in the editor. Off is an icon button, on is a "Following" pill. */
export function FollowPill(props: FollowPillProps) {
  return (
    <button type="button" class="sb-follow" classList={{ on: props.following }} aria-pressed={props.following}
      aria-label="Follow the agent in the editor" title={props.following ? "Following the agent in the editor" : "Follow the agent in the editor"}
      onClick={props.onToggle}>
      <Icon name="Gps" size={props.following ? 13 : 15} />
      <Show when={props.following}><span>Following</span></Show>
    </button>
  );
}
