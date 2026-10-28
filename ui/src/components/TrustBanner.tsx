import { Show, createSignal, createUniqueId } from "solid-js";
import Icon from "./Icon";
import * as copy from "../lib/language-intelligence-copy";
import type { BannerView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface TrustBannerProps {
  banner: BannerView;
  onTrust: () => void;
  onDismiss: () => void;
}

/** Offered at the top of the editor when the open folder needs trust before its build tool may run. */
export function TrustBanner(props: TrustBannerProps) {
  const [more, setMore] = createSignal(false);
  const moreId = createUniqueId();
  return <section class="trust-banner" role="region" aria-label="Folder trust" data-restarting={Boolean(props.banner.restarting)}>
    <Show when={props.banner.restarting} fallback={<>
      <div class="trust-banner-text">
        <strong>{props.banner.title}</strong>
        <p>{props.banner.body}</p>
        <Show when={more()}><p id={moreId} class="trust-banner-more">{props.banner.more}</p></Show>
      </div>
      <div class="trust-banner-actions">
        <button type="button" class="button primary" onClick={props.onTrust}>{copy.hubText.trustFolder}</button>
        <button type="button" class="button" onClick={props.onDismiss}>{copy.hubText.notNow}</button>
        <button type="button" class="lsp-link" aria-expanded={more()} aria-controls={more() ? moreId : undefined} onClick={() => setMore(!more())}>{more() ? copy.hubText.hideDetails : copy.hubText.learnMore}<Icon name={more() ? "arrow-up3" : "arrow-down4"} size={12} /></button>
      </div>
    </>}><p class="trust-banner-restart" role="status">{props.banner.restarting}</p></Show>
  </section>;
}

export default TrustBanner;
