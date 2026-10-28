/** Audio waveform helpers. Decoding uses WebAudio; the downsampling is pure so it can be tested. */

export const WAVEFORM_BARS = 110;
/** Files above this are played but not decoded for a waveform: decoding expands them to raw PCM in memory. */
export const WAVEFORM_MAX_BYTES = 48 * 1024 * 1024;

/**
 * One peak per bar: the largest absolute sample across all channels in that bar's slice, normalised so the
 * loudest bar is 1. Long inputs are sampled with a stride so the cost stays bounded.
 */
export function waveformPeaks(channels: ArrayLike<number>[], bars = WAVEFORM_BARS): number[] {
  const peaks = new Array<number>(bars).fill(0);
  const length = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  if (!length || bars <= 0) return peaks;
  const per = length / bars;
  const stride = Math.max(1, Math.floor(per / 2000));
  for (let bar = 0; bar < bars; bar++) {
    const start = Math.floor(bar * per), end = Math.max(start + 1, Math.floor((bar + 1) * per));
    let peak = 0;
    for (const channel of channels) for (let i = start; i < end && i < channel.length; i += stride) { const value = Math.abs(channel[i]); if (value > peak) peak = value; }
    peaks[bar] = peak;
  }
  const max = Math.max(...peaks);
  return max > 0 ? peaks.map(peak => peak / max) : peaks;
}

export interface DecodedAudio { peaks: number[]; duration: number; sampleRate: number; channels: number }

/** Decodes with an OfflineAudioContext (no audio device is opened). Rejects when WebAudio is missing or decoding fails. */
export async function decodeWaveform(bytes: Uint8Array, bars = WAVEFORM_BARS): Promise<DecodedAudio> {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Offline) throw new Error('WebAudio is not available in this webview.');
  if (bytes.length > WAVEFORM_MAX_BYTES) throw new Error('The waveform is not drawn for files over 48 MiB.');
  const context = new Offline(1, 1, 44100);
  const buffer = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return { peaks: waveformPeaks(channels, bars), duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
}
