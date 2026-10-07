/**
 * Decoding a song without the main thread (v0.9.57) — the half that runs inside the Worker.
 *
 * Why: every `decodeAudioData` freezes the page once while Chromium builds the AudioBuffer on the main thread — measured 07/10 at 50–380 ms
 * per 5-minute MP3, with OfflineAudioContext too — and those freezes are the waveform jumps Shalom saw while the library analysed. A Worker
 * has no `decodeAudioData` at all, so it decodes by itself: MP3 through minimp3 (public domain, CC0) in the 21 KB `minimp3-wasm` build (Apache-2.0), WAV by reading its
 * PCM directly. Other formats (M4A/AAC, FLAC, OGG...) are a named set, not a failure: `OFF_MAIN_FORMATS` below, and the caller sends the
 * rest down the old path.
 *
 * The result is converted to the AudioContext's rate (`core/resample.ts`) so the analysis sees what it always saw.
 */
import { Decoder } from 'minimp3-wasm'
import initDecoderWasm from 'minimp3-wasm/dist/decoder.opt.wasm?init'
import type { PcmData } from '@/core/ports/analyzer'
import { mp3Trim } from '@/core/mp3-gapless'
import { resample } from '@/core/resample'
import { readWavPcm } from '@/core/wav-pcm'
import { repairWav } from '@/core/wav-repair'

/** The formats decoded off the main thread. Everything else goes through `engine.decode`, as before. */
export const OFF_MAIN_FORMATS = ['mp3', 'wav'] as const
export type OffMainFormat = (typeof OFF_MAIN_FORMATS)[number]

let wasm: Promise<WebAssembly.Exports> | null = null

async function decodeMp3(bytes: Uint8Array): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  // `?init` loads the decoder from the app's own bundle — no request leaves the computer, so `privacy-claims.test.ts` (no network calls outside the one lookup) still holds.
  wasm ??= initDecoderWasm({}).then((instance) => instance.exports)
  const decoder = new Decoder(await wasm, bytes)
  // The whole song in one call: the decoder hands back interleaved 16-bit samples in its own memory, copied out here before the next call.
  const r = decoder.decode(decoder.duration + 1)
  if (r.numSamples === 0 || r.numChannels === 0) throw new Error('minimp3 decoded nothing')
  // Lined up with the browser's decoder (`core/mp3-gapless.ts`): without it the beat grid would be stored up to 40 ms late.
  const trim = mp3Trim(bytes)
  const total = r.numSamples / r.numChannels
  const first = Math.min(trim.start, total)
  const frames = Math.max(0, total - first - trim.end)
  if (frames === 0) throw new Error('minimp3: nothing left after the encoder delay')
  const channels = Array.from({ length: r.numChannels }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) for (let c = 0; c < r.numChannels; c++) channels[c][i] = r.pcm[(first + i) * r.numChannels + c] / 32768
  return { channels, sampleRate: r.samplingRate }
}

/** Throws with a reason; the caller falls back to the main-thread decoder and says so. */
export async function decodeOffMain(bytes: Uint8Array, format: OffMainFormat, targetRate: number): Promise<PcmData> {
  const raw = format === 'mp3' ? await decodeMp3(bytes) : readWavPcm(repairWav(bytes) ?? bytes)
  // Every channel as the file has it, like `pcmFromAudioBuffer` passes on what `decodeAudioData` gives: mono stays one channel.
  return { channels: raw.channels.map((c) => resample(c, raw.sampleRate, targetRate)), sampleRate: targetRate }
}
