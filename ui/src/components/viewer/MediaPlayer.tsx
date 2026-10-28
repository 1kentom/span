import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import Icon from '../Icon';
import { PLAYBACK_SPEEDS, SEEK_SECONDS, clampVolume, formatDuration, mediaKeyAction, seekTarget } from '../../lib/viewer';

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
 * Custom controls over a native audio or video element. The source is a Blob object URL that is
 * revoked on cleanup. Never autoplays. Codec support depends on the platform webview.
 */
export function MediaPlayer(props: MediaPlayerProps) {
  let media!: HTMLMediaElement;
  const [src, setSrc] = createSignal('');
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [paused, setPaused] = createSignal(true);
  const [rate, setRate] = createSignal(1);
  const [loop, setLoop] = createSignal(false);
  const [volume, setVolume] = createSignal(1);
  const [muted, setMuted] = createSignal(false);
  const [problem, setProblem] = createSignal('');

  createEffect(() => {
    const url = URL.createObjectURL(new Blob([props.bytes as BlobPart], { type: props.mime }));
    setSrc(url); setTime(0); setDuration(0); setPaused(true); setProblem('');
    onCleanup(() => URL.revokeObjectURL(url));
  });
  createEffect(() => { if (media) { media.playbackRate = rate(); media.loop = loop(); media.volume = volume(); media.muted = muted(); } });

  const toggle = () => {
    if (!media) return;
    if (!media.paused) { media.pause(); return; }
    setProblem('');
    // Rejections (autoplay policy, unsupported codec) are shown, never swallowed.
    Promise.resolve(media.play()).catch(cause => setProblem(`Playback could not start: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const seekBy = (delta: number) => { if (media) media.currentTime = seekTarget(media.currentTime || 0, delta, media.duration); };
  const volumeBy = (delta: number) => { setMuted(false); setVolume(clampVolume(volume() + delta)); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-keys="native"]')) return;
    const action = mediaKeyAction(event.key);
    if (!action) return;
    // Space on a focused button or select keeps its native meaning.
    if (action.type === 'toggle' && target.closest('button,select')) return;
    event.preventDefault();
    if (action.type === 'toggle') toggle();
    else if (action.type === 'seek') seekBy(action.delta);
    else if (action.type === 'volume') volumeBy(action.delta);
    else setMuted(!muted());
  };
  const events = {
    onLoadedMetadata: () => {
      setDuration(Number.isFinite(media.duration) ? media.duration : 0);
      props.onDuration?.(media.duration);
      const video = media as HTMLVideoElement;
      if (props.kind === 'video' && video.videoWidth) props.onVideoSize?.(video.videoWidth, video.videoHeight);
    },
    onDurationChange: () => setDuration(Number.isFinite(media.duration) ? media.duration : 0),
    onTimeUpdate: () => setTime(media.currentTime),
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onEnded: () => setPaused(true),
    onError: () => props.onDamaged('The webview could not decode this file. It may be damaged, or its codec may not be supported on this platform.'),
  };
  const mediaElement = () => props.kind === 'video'
    ? <video ref={media as HTMLVideoElement} class="vw-video" src={src()} preload="metadata" playsinline aria-label={props.name} onClick={toggle} {...events} />
    : <audio ref={media as HTMLAudioElement} src={src()} preload="metadata" aria-label={props.name} {...events} />;

  return <div class="vw-player" classList={{ 'vw-player-video': props.kind === 'video' }} role="group" aria-label={`${props.kind === 'video' ? 'Video' : 'Audio'} player`} tabIndex={0} onKeyDown={onKeyDown}>
    <Show when={props.kind === 'video'} fallback={<><div class="vw-audio-card"><strong>{props.name}</strong></div>{mediaElement()}</>}>
      <div class="vw-video-stage">{mediaElement()}</div>
    </Show>
    <Show when={problem()}><p class="vw-note vw-note-error" role="alert">{problem()}</p></Show>
    <div class="vw-controls">
      <input class="vw-seek" type="range" min="0" max={duration() || 0} step="0.1" value={Math.min(time(), duration() || 0)} disabled={!duration()} aria-label="Seek"
        aria-valuetext={`${formatDuration(time())} of ${formatDuration(duration())}`} onInput={event => { media.currentTime = Number(event.currentTarget.value); setTime(media.currentTime); }} />
      <div class="vw-control-row">
        <button type="button" class="vw-btn" aria-label={`Back ${SEEK_SECONDS} seconds`} title={`Back ${SEEK_SECONDS} seconds (Left arrow)`} onClick={() => seekBy(-SEEK_SECONDS)}>−{SEEK_SECONDS} s</button>
        <button type="button" class="vw-btn vw-btn-primary vw-play" aria-label={paused() ? 'Play' : 'Pause'} title="Play or pause (Space)" onClick={toggle}>
          <Show when={paused()} fallback="Pause"><Icon name="u-play" size={12} />Play</Show>
        </button>
        <button type="button" class="vw-btn" aria-label={`Forward ${SEEK_SECONDS} seconds`} title={`Forward ${SEEK_SECONDS} seconds (Right arrow)`} onClick={() => seekBy(SEEK_SECONDS)}>+{SEEK_SECONDS} s</button>
        <span class="vw-time" role="timer" aria-label="Elapsed time">{formatDuration(time())} / {formatDuration(duration())}</span>
        <div class="vw-group" role="group" aria-label="Playback speed">
          <For each={PLAYBACK_SPEEDS}>{speed => <button type="button" class="vw-btn" aria-pressed={rate() === speed} aria-label={`Speed ${speed} times`} onClick={() => setRate(speed)}>{speed}×</button>}</For>
        </div>
        <button type="button" class="vw-btn" aria-pressed={loop()} onClick={() => setLoop(!loop())}>Loop</button>
        <button type="button" class="vw-btn" aria-pressed={muted()} title="Mute (M)" onClick={() => setMuted(!muted())}>{muted() ? 'Unmute' : 'Mute'}</button>
        <input class="vw-volume" type="range" min="0" max="1" step="0.05" value={muted() ? 0 : volume()} aria-label="Volume" data-keys="native" onInput={event => { setMuted(false); setVolume(Number(event.currentTarget.value)); }} />
      </div>
    </div>
  </div>;
}
