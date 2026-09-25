/**
 * Beat detection's sample-touching half (onset envelope → `core/beatgrid.ts`).
 * Its own file because it takes plain `PcmData` and nothing from the DOM, so
 * the tests — which run without DOM types — can reach it; `analyze.ts` next to
 * it also converts `AudioBuffer`s (25/09, v0.8.33).
 */
import { estimateBeatGrid, type BeatGridEstimate } from '@/core/beatgrid'
import type { PcmData } from '@/core/ports/analyzer'

/** Rare path: files with more than two channels. */
function mixAt(chans: Float32Array[], i: number, invCh: number): number {
  let v = 0
  for (let c = 0; c < chans.length; c++) v += chans[c][i]
  return v * invCh
}

/** Target envelope rate — ~5ms frames. The real rate is returned, not this. */
const FRAMES_PER_SEC = 200

/**
 * Onset envelope for beat detection: low-pass to isolate kick energy, then the
 * frame-to-frame rise (a plain low-pass alone flags every strong *sound*, not
 * just its *attack*). This is the only part of beat detection that has to
 * touch decoded samples, so it stays here; everything from here on — scoring
 * candidate tempos, finding phase, quantizing to the result — is pure and
 * lives in `core/beatgrid.ts` so it can be unit tested without any.
 */
export function buildOnsetEnvelope(pcm: PcmData): { onsets: Float32Array; framesPerSec: number } {
  const sr = pcm.sampleRate
  // channels averaged inline: flattening to a full-length mono copy first cost
  // 63MB on a 6-minute stereo track, for an envelope we throw away immediately
  const chans = pcm.channels
  const nch = chans.length
  const invCh = 1 / nch
  const len = chans[0].length
  const ch0 = chans[0]
  const ch1 = nch > 1 ? chans[1] : ch0
  const stereo = nch === 2
  const multi = nch > 2

  // one-pole low-pass ~200Hz to isolate kick energy
  const dt = 1 / sr
  const rc = 1 / (2 * Math.PI * 200)
  const alpha = dt / (rc + dt)
  let lp = 0
  const env: number[] = []
  const frame = Math.floor(sr / FRAMES_PER_SEC)
  let acc = 0
  let n = 0
  for (let i = 0; i < len; i++) {
    const v = multi ? mixAt(chans, i, invCh) : stereo ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]
    lp += alpha * (v - lp)
    acc += lp * lp
    if (++n === frame) {
      env.push(Math.sqrt(acc / frame))
      acc = 0
      n = 0
    }
  }

  // difference envelope (onsets only)
  const onsets = new Float32Array(env.length)
  for (let i = 1; i < env.length; i++) {
    const d = env[i] - env[i - 1]
    onsets[i] = d > 0 ? d : 0
  }
  // The rate a whole-sample frame actually gives, never the target: at
  // 44.1kHz a frame is 220 samples, 200.45 a second, and reporting 200 made
  // every tempo 0.23% slow (a 128 tag read 127.72). 48kHz divides evenly,
  // which is why the owner's machine never showed it.
  // tests/platform/beat-envelope-rate.test.ts.
  return { onsets, framesPerSec: sr / frame }
}

/**
 * Beat grid estimate: bpm, phase, and whether either looks like a real
 * periodicity rather than a guess (see `core/beatgrid.ts`'s `CONFIDENCE_RATIO`
 * doc comment). `null` only when the track is too short to say anything at
 * all — a low-confidence result still comes back with a grid, so the caller
 * has something to show and quantize against while marking it unconfirmed.
 */
export function detectBeatGrid(
  pcm: PcmData,
  opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null },
): BeatGridEstimate | null {
  const { onsets, framesPerSec } = buildOnsetEnvelope(pcm)
  return estimateBeatGrid(onsets, framesPerSec, opts)
}
