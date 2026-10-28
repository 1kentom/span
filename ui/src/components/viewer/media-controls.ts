import { createEffect, createSignal, onCleanup } from 'solid-js';
import { clampVolume, mediaKeyAction, seekTarget } from '../../lib/viewer';

/**
 * State and actions shared by the audio and video players. The source is a Blob object URL, revoked on
 * cleanup and whenever the bytes change. Nothing autoplays; a rejected play() is reported, never swallowed.
 */
export function createMediaControls(source: () => { bytes: Uint8Array; mime: string }) {
  let media: HTMLMediaElement | undefined;
  const [src, setSrc] = createSignal('');
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [paused, setPaused] = createSignal(true);
  const [rate, setRate] = createSignal(1);
  const [loop, setLoop] = createSignal(false);
  const [volume, setVolume] = createSignal(1);
  const [muted, setMuted] = createSignal(false);
  const [problem, setProblem] = createSignal('');
  const [buffered, setBuffered] = createSignal<[number, number][]>([]);

  createEffect(() => {
    const { bytes, mime } = source();
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setSrc(url); setTime(0); setDuration(0); setPaused(true); setProblem(''); setBuffered([]);
    onCleanup(() => URL.revokeObjectURL(url));
  });
  createEffect(() => { const r = rate(), l = loop(), v = volume(), m = muted(); if (media) { media.playbackRate = r; media.loop = l; media.volume = v; media.muted = m; } });

  const toggle = () => {
    if (!media) return;
    if (!media.paused) { media.pause(); return; }
    setProblem('');
    Promise.resolve(media.play()).catch(cause => setProblem(`Playback could not start: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const seekTo = (seconds: number) => { if (!media) return; media.currentTime = seekTarget(seconds, 0, media.duration); setTime(media.currentTime); };
  const seekBy = (delta: number) => { if (media) { media.currentTime = seekTarget(media.currentTime || 0, delta, media.duration); setTime(media.currentTime); } };
  const volumeBy = (delta: number) => { setMuted(false); setVolume(clampVolume(volume() + delta)); };
  const finite = (value: number) => Number.isFinite(value) ? value : 0;
  const readBuffered = () => {
    if (!media || !media.duration || !Number.isFinite(media.duration)) return;
    const ranges: [number, number][] = [];
    for (let i = 0; i < (media.buffered?.length ?? 0); i++) ranges.push([media.buffered.start(i) / media.duration, media.buffered.end(i) / media.duration]);
    setBuffered(ranges);
  };

  /** Space, K, arrows, J, L and M. Space on a focused button or select keeps its native meaning. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-keys="native"]') || target.closest('input[type="text"]')) return;
    const action = mediaKeyAction(event.key);
    if (!action) return;
    if (action.type === 'toggle' && target.closest('button,select')) return;
    event.preventDefault();
    if (action.type === 'toggle') toggle();
    else if (action.type === 'seek') seekBy(action.delta);
    else if (action.type === 'volume') volumeBy(action.delta);
    else setMuted(!muted());
  };

  const bind = (element: HTMLMediaElement) => { media = element; };
  const events = (handlers: { onDuration?: (seconds: number) => void; onLoaded?: (element: HTMLMediaElement) => void; onDamaged: (message: string) => void; message: string }) => ({
    onLoadedMetadata: () => { if (!media) return; setDuration(finite(media.duration)); handlers.onDuration?.(media.duration); handlers.onLoaded?.(media); readBuffered(); },
    onDurationChange: () => media && setDuration(finite(media.duration)),
    onTimeUpdate: () => media && setTime(media.currentTime),
    onProgress: readBuffered,
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onEnded: () => setPaused(true),
    onError: () => handlers.onDamaged(handlers.message),
  });

  return { src, time, duration, paused, rate, setRate, loop, setLoop, volume, setVolume, muted, setMuted, problem, buffered, toggle, seekTo, seekBy, onKeyDown, bind, events, element: () => media };
}
