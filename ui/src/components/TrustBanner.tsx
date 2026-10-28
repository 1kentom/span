import { Show } from "solid-js";
import * as copy from "../lib/language-intelligence-copy";
import type { BannerView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface TrustBannerProps {
  banner: BannerView;
  onTrust: () => void;
  onDismiss: () => void;
}

/**
 * A small card over the top right of the editor, never in the layout flow, so showing it moves nothing.
 * The long explanation is the tooltip of the trust line in the panel footer.
 */
export function TrustBanner(props: TrustBannerProps) {
  return <section class="trust-banner" role="region" aria-label="Folder trust" data-restarting={Boolean(props.banner.restarting)}>
    <Show when={props.banner.restarting} fallback={<>
      <p class="trust-banner-text">{props.banner.title}</p>
      <button type="button" class="close-button trust-banner-close" aria-label={copy.hubText.closeTrust} onClick={props.onDismiss}>×</button>
      <div class="trust-banner-actions">
        <button type="button" class="hub-text-button" onClick={props.onDismiss}>{copy.hubText.notNow}</button>
        <button type="button" class="button primary" onClick={props.onTrust}>{copy.hubText.trustFolder}</button>
      </div>
    </>}><p class="trust-banner-text" role="status">{props.banner.restarting}</p></Show>
  </section>;
}

export default TrustBanner;
