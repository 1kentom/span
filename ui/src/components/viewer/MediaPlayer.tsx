import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { PLAYBACK_SPEEDS, SEEK_SECONDS, formatDuration } from '../../lib/viewer';
import Icon from '../Icon';
import { AudioView } from './AudioView';
import { createMediaControls } from './media-controls';

export interface MediaPlayerProps {
  kind: 'audio' | 'video';
  bytes: Uint8Array;
  mime: string;
  name: string;
  onDuration?: (seconds: number) => void;
  onVideoSize?: (width: number, height: number) => void;
  onDamaged: (message: string) => void;
}

/**
 * Video player with custom controls over a native video element: play and pause, seek with the buffered
 * range, 10 second skips, speed, loop, volume and mute, and full screen on the player. Audio is delegated to
 * AudioView. Never autoplays. Codec support depends on the platform webview.
 */
export function MediaPlayer(props: MediaPlayerProps) {
  return <Show when={props.kind === 'video'} fallback={<AudioView bytes={props.bytes} mime={props.mime} name={props.name} onDuration={props.onDuration} onDamaged={props.onDamaged} />}>
    <VideoPlayer {...props} />
  </Show>;
}

function VideoPlayer(props: MediaPlayerProps) {
  let root!: HTMLDivElement;
  const media = createMediaControls(() => ({ bytes: props.bytes, mime: props.mime }));
  const [fullscreen, setFullscreen] = createSignal(false);
  onMount(() => {
    const sync = () => setFullscreen(document.fullscreenElement === root);
    document.addEventListener('fullscreenchange', sync);
    onCleanup(() => document.removeEventListener('fullscreenchange', sync));
  });
  const toggleFullscreen = () => {
    if (document.fullscreenElement === root) void document.exitFullscreen?.();
    else Promise.resolve(root.requestFullscreen?.()).catch(() => undefined);
  };
  const cycleSpeed = () => { const at = PLAYBACK_SPEEDS.indexOf(media.rate() as typeof PLAYBACK_SPEEDS[number]); media.setRate(PLAYBACK_SPEEDS[(at + 1) % PLAYBACK_SPEEDS.length]); };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === 'f' || event.key === 'F') && !event.metaKey && !event.ctrlKey && !event.altKey && !(event.target as HTMLElement).closest('input')) { event.preventDefault(); toggleFullscreen(); return; }
    media.onKeyDown(event);
  };
  const played = () => media.duration() ? Math.min(100, media.time() / media.duration() * 100) : 0;
  return <div ref={root} class="vw-player vw-player-video" role="group" aria-label="Video player" tabIndex={0} onKeyDown={onKeyDown}>
    <div class="vw-video-stage">
      <video ref={media.bind} class="vw-video" src={media.src()} preload="metadata" playsinline aria-label={props.name} onClick={media.toggle}
        {...media.events({
          onDuration: props.onDuration, onDamaged: props.onDamaged, message: 'The webview could not decode this file. It may be damaged, or its codec may not be supported on this platform.',
          onLoaded: element => { const video = element as HTMLVideoElement; if (video.videoWidth) props.onVideoSize?.(video.videoWidth, video.videoHeight); },
        })} />
      <Show when={media.paused()}><span class="vw-video-overlay" aria-hidden="true" onClick={media.toggle}><Icon name="u-play" size={22} /></span></Show>
    </div>
    <Show when={media.problem()}><p class="vw-note vw-note-error" role="alert">{media.problem()}</p></Show>
    <div class="vw-video-bar">
      <button type="button" class="vw-btn vw-btn-icon" aria-label={media.paused() ? 'Play' : 'Pause'} title="Play or pause (Space)" onClick={media.toggle}><Icon name={media.paused() ? 'u-play' : 'Pause'} size={14} /></button>
      <button type="button" class="vw-btn vw-btn-icon" aria-label={`Back ${SEEK_SECONDS} seconds`} title={`Back ${SEEK_SECONDS} seconds (Left arrow)`} onClick={() => media.seekBy(-SEEK_SECONDS)}><Icon name="Back10" size={15} /></button>
      <button type="button" class="vw-btn vw-btn-icon" aria-label={`Forward ${SEEK_SECONDS} seconds`} title={`Forward ${SEEK_SECONDS} seconds (Right arrow)`} onClick={() => media.seekBy(SEEK_SECONDS)}><Icon name="Fwd10" size={15} /></button>
      <span class="vw-time" role="timer" aria-label="Elapsed time">{formatDuration(media.time())} / {formatDuration(media.duration())}</span>
      <div class="vw-seek-wrap">
        <div class="vw-seek-track" aria-hidden="true">
          <For each={media.buffered()}>{([start, end]) => <span class="vw-seek-buffered" style={{ left: `${start * 100}%`, width: `${Math.max(0, end - start) * 100}%` }} />}</For>
          <span class="vw-seek-played" style={{ width: `${played()}%` }} />
        </div>
        <input class="vw-seek" type="range" min="0" max={media.duration() || 0} step="0.1" value={Math.min(media.time(), media.duration() || 0)} disabled={!media.duration()} aria-label="Seek"
          aria-valuetext={`${formatDuration(media.time())} of ${formatDuration(media.duration())}`} onInput={event => media.seekTo(Number(event.currentTarget.value))} />
      </div>
      <button type="button" class="vw-chip-btn" aria-label={`Playback speed ${media.rate()} times, change`} title="Playback speed" onClick={cycleSpeed}>{media.rate()}×</button>
      <button type="button" class="vw-btn vw-btn-icon" aria-label="Loop" aria-pressed={media.loop()} title="Loop" onClick={() => media.setLoop(!media.loop())}><Icon name="Repeat" size={13} /></button>
      <span class="vw-volume-wrap">
        <button type="button" class="vw-btn vw-btn-icon" aria-label={media.muted() ? 'Unmute' : 'Mute'} title="Mute (M)" onClick={() => media.setMuted(!media.muted())}><Icon name={media.muted() ? 'VolumeMute' : 'Volume'} size={14} /></button>
        <input class="vw-volume" type="range" min="0" max="1" step="0.05" value={media.muted() ? 0 : media.volume()} aria-label="Volume" data-keys="native" onInput={event => { media.setMuted(false); media.setVolume(Number(event.currentTarget.value)); }} />
      </span>
      <button type="button" class="vw-btn vw-btn-icon" aria-label={fullscreen() ? 'Exit full screen' : 'Full screen'} aria-pressed={fullscreen()} title="Full screen (F)" onClick={toggleFullscreen}><Icon name="Maximize4" size={12} /></button>
    </div>
  </div>;
}
