import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import type { UploadExtras } from '../../lib/uploads-api';
import { PLAYBACK_SPEEDS, SEEK_SECONDS, formatDuration } from '../../lib/viewer';
import { FileIcon } from '../FileIcon';
import Icon from '../Icon';
import { createMediaControls } from './media-controls';
import { WAVEFORM_BARS, decodeWaveform, type DecodedAudio } from './waveform';

export interface AudioViewProps {
  bytes: Uint8Array; mime: string; name: string;
  /** Transcript and chapters render only when the api provides them. */
  extras?: UploadExtras;
  onDuration?: (seconds: number) => void;
  onMeta?: (parts: string[]) => void;
  onDamaged: (message: string) => void;
}

const codecLabel = (mime: string) => ({ 'audio/mpeg': 'MP3', 'audio/mp4': 'AAC', 'audio/aac': 'AAC', 'audio/wav': 'WAV', 'audio/ogg': 'Ogg', 'audio/flac': 'FLAC', 'audio/webm': 'WebM' } as Record<string, string>)[mime] ?? (mime || 'Audio');

/** Audio player with a decoded waveform drawn on a canvas, click or drag to seek, and keyboard control. */
export function AudioView(props: AudioViewProps) {
  const media = createMediaControls(() => ({ bytes: props.bytes, mime: props.mime }));
  const [decoded, setDecoded] = createSignal<DecodedAudio | null>(null);
  const [waveNote, setWaveNote] = createSignal('');
  const [width, setWidth] = createSignal(0);
  let canvas: HTMLCanvasElement | undefined;
  let wave!: HTMLDivElement;

  // decodeAudioData resamples to the context rate, so the decoded sample rate is not the file's: it is not shown.
  createEffect(on(() => props.bytes, bytes => {
    let cancelled = false;
    setDecoded(null); setWaveNote('');
    decodeWaveform(bytes).then(result => { if (cancelled) return; setDecoded(result); props.onMeta?.([`${codecLabel(props.mime)} · ${result.channels === 1 ? 'mono' : result.channels === 2 ? 'stereo' : `${result.channels} channels`}`]); })
      .catch(cause => { if (!cancelled) setWaveNote(`Waveform unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); });
    onCleanup(() => { cancelled = true; });
  }));
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? 0));
    queueMicrotask(() => wave && observer.observe(wave));
    onCleanup(() => observer.disconnect());
  }

  const fraction = createMemo(() => media.duration() ? Math.min(1, media.time() / media.duration()) : 0);
  // Draw the bars with colours read from the theme tokens, so the canvas follows Dark, Light and Purple.
  createEffect(() => {
    const result = decoded(), played = fraction(), w = width() || canvas?.clientWidth || 0;
    if (!canvas || !result || !w) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ratio = window.devicePixelRatio || 1, h = canvas.clientHeight || 96;
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
    const style = getComputedStyle(canvas);
    const playedColour = style.getPropertyValue('--vw-wave-played').trim(), restColour = style.getPropertyValue('--vw-wave-rest').trim();
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, w, h);
    const gap = 2, bar = Math.max(1, (w - gap * (result.peaks.length - 1)) / result.peaks.length);
    result.peaks.forEach((peak, i) => {
      const height = Math.max(3, peak * h);
      context.fillStyle = (i + 0.5) / result.peaks.length <= played ? playedColour : restColour;
      context.beginPath();
      if (context.roundRect) context.roundRect(i * (bar + gap), (h - height) / 2, bar, height, Math.min(2, bar / 2));
      else context.rect(i * (bar + gap), (h - height) / 2, bar, height);
      context.fill();
    });
  });

  const seekFromPointer = (event: PointerEvent) => {
    const bounds = wave.getBoundingClientRect();
    if (!bounds.width || !media.duration()) return;
    media.seekTo(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)) * media.duration());
  };
  const onWaveKey = (event: KeyboardEvent) => {
    if (event.key === 'Home') { event.preventDefault(); media.seekTo(0); }
    else if (event.key === 'End') { event.preventDefault(); media.seekTo(media.duration()); }
  };
  const transcript = () => props.extras?.transcript ?? [];
  const chapters = () => props.extras?.chapters ?? [];
  const currentLine = createMemo(() => transcript().reduce((at, line, i) => media.time() >= line.at ? i : at, 0));

  return <div class="vw-player vw-audio" role="group" aria-label="Audio player" tabIndex={0} onKeyDown={media.onKeyDown}>
    <audio ref={media.bind} src={media.src()} preload="metadata" aria-label={props.name}
      {...media.events({ onDuration: props.onDuration, onDamaged: props.onDamaged, message: 'The webview could not decode this file. It may be damaged, or its codec may not be supported on this platform.' })} />
    <div class="vw-audio-inner">
      <div class="vw-audio-head">
        <span class="vw-audio-tile"><FileIcon path={props.name} /></span>
        <span class="vw-audio-id"><strong>{props.name}</strong><span class="vw-dim">{decoded() ? `${codecLabel(props.mime)} · ${formatDuration(decoded()!.duration)}` : codecLabel(props.mime)}</span></span>
      </div>
      <div class="vw-wave-card">
        <div ref={wave} class="vw-wave" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(media.duration())} aria-valuenow={Math.round(media.time())}
          aria-valuetext={`${formatDuration(media.time())} of ${formatDuration(media.duration())}`} onKeyDown={onWaveKey}
          onPointerDown={event => { if (event.button !== 0) return; wave.setPointerCapture?.(event.pointerId); seekFromPointer(event); }}
          onPointerMove={event => { if (wave.hasPointerCapture?.(event.pointerId)) seekFromPointer(event); }}>
          <Show when={decoded()} fallback={<div class="vw-wave-flat" aria-hidden="true"><For each={Array.from({ length: WAVEFORM_BARS })}>{() => <span />}</For></div>}>
            <canvas ref={canvas} class="vw-wave-canvas" aria-hidden="true" />
          </Show>
          <span class="vw-playhead" aria-hidden="true" style={{ left: `${fraction() * 100}%` }} />
          <For each={chapters()}>{chapter => <span class="vw-wave-mark" title={chapter.label} style={{ left: `${media.duration() ? chapter.at / media.duration() * 100 : 0}%` }} />}</For>
        </div>
        <div class="vw-wave-times"><span class="vw-time">{formatDuration(media.time())} / {formatDuration(media.duration())}</span><span>−{formatDuration(Math.max(0, media.duration() - media.time()))}</span></div>
        <Show when={waveNote()}><p class="vw-wave-note" role="note">{waveNote()}</p></Show>
      </div>
      <Show when={media.problem()}><p class="vw-note vw-note-error" role="alert">{media.problem()}</p></Show>
      <div class="vw-audio-controls">
        <button type="button" class="vw-round" aria-label={`Back ${SEEK_SECONDS} seconds`} title={`Back ${SEEK_SECONDS} seconds (Left arrow or J)`} onClick={() => media.seekBy(-SEEK_SECONDS)}><Icon name="Back10" size={20} /></button>
        <button type="button" class="vw-round vw-round-primary" aria-label={media.paused() ? 'Play' : 'Pause'} title="Play or pause (Space)" onClick={media.toggle}><Icon name={media.paused() ? 'u-play' : 'Pause'} size={18} /></button>
        <button type="button" class="vw-round" aria-label={`Forward ${SEEK_SECONDS} seconds`} title={`Forward ${SEEK_SECONDS} seconds (Right arrow or L)`} onClick={() => media.seekBy(SEEK_SECONDS)}><Icon name="Fwd10" size={20} /></button>
        <span class="vw-spacer" />
        <div class="vw-segment" role="group" aria-label="Playback speed">
          <For each={PLAYBACK_SPEEDS}>{speed => <button type="button" class="vw-segment-btn" aria-pressed={media.rate() === speed} aria-label={`Speed ${speed} times`} onClick={() => media.setRate(speed)}>{speed}×</button>}</For>
        </div>
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Loop" aria-pressed={media.loop()} title="Loop" onClick={() => media.setLoop(!media.loop())}><Icon name="Repeat" size={14} /></button>
        <span class="vw-volume-wrap">
          <button type="button" class="vw-btn vw-btn-icon" aria-label={media.muted() ? 'Unmute' : 'Mute'} title="Mute (M)" onClick={() => media.setMuted(!media.muted())}><Icon name={media.muted() ? 'VolumeMute' : 'Volume'} size={15} /></button>
          <input class="vw-volume" type="range" min="0" max="1" step="0.05" value={media.muted() ? 0 : media.volume()} aria-label="Volume" data-keys="native" onInput={event => { media.setMuted(false); media.setVolume(Number(event.currentTarget.value)); }} />
        </span>
      </div>
      <Show when={transcript().length}>
        <div class="vw-transcript">
          <div class="vw-transcript-head"><span>Transcript</span><Show when={transcript()[0]?.source}><span class="vw-dim">from {transcript()[0].source}</span></Show><span class="vw-spacer" /><span class="vw-dim">Select a line to jump</span></div>
          <For each={transcript()}>{(line, i) => <button type="button" class="vw-transcript-line" aria-current={currentLine() === i() ? 'true' : undefined} onClick={() => media.seekTo(line.at)}>
            <span class="vw-transcript-at">{formatDuration(line.at)}</span><span><Show when={line.speaker}><strong>{line.speaker}</strong> </Show>{line.text}</span>
          </button>}</For>
        </div>
      </Show>
    </div>
  </div>;
}
