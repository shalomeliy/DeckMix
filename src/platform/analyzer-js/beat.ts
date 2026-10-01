/**
 * Beat detection's sample-touching half (onset envelope → `core/beatgrid.ts`).
 * Its own file because it takes plain `PcmData` and nothing from the DOM, so
 * the tests — which run without DOM types — can reach it; `analyze.ts` next to
 * it also converts `AudioBuffer`s (25/09, v0.8.33).
 */
import { estimateBeatGrid, type BeatGridEstimate } from '@/core/beatgrid'
import { TEMPO_TIE_MARGIN, estimateTempo, multiBandOnset } from '@/core/tempo-estimate'
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
export function buildOnsetEnvelope(pcm: PcmData): {
  onsets: Float32Array
  framesPerSec: number
  /** RMS per frame below 150Hz, 150–600Hz, 600Hz–3kHz, above 3kHz — for the blind tempo (`core/tempo-estimate.ts`). */
  bands: Float32Array[]
} {
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
  const frame = Math.floor(sr / FRAMES_PER_SEC)
  const frames = Math.floor(len / frame)
  // Float64, as the old number[] was: rounding each frame to 32 bits before
  // the difference below moved tagged tracks' refine by a 0.01 BPM step (v0.8.34 review).
  const env = new Float64Array(frames)
  const bands = [0, 1, 2, 3].map(() => new Float32Array(frames))
  // One-pole splits, the same cheap kind the waveform colour uses: they only have
  // to say *when* a band gets louder, not what is in it.
  const onePole = (hz: number) => dt / (1 / (2 * Math.PI * hz) + dt)
  const a1 = onePole(150)
  const a2 = onePole(600)
  const a3 = onePole(3000)
  let l1 = 0
  let l2 = 0
  let l3 = 0
  let acc = 0
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let n = 0
  let f = 0
  for (let i = 0; i < frames * frame; i++) {
    const v = multi ? mixAt(chans, i, invCh) : stereo ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]
    lp += alpha * (v - lp)
    acc += lp * lp
    l1 += a1 * (v - l1)
    l2 += a2 * (v - l2)
    l3 += a3 * (v - l3)
    b0 += l1 * l1
    b1 += (l2 - l1) * (l2 - l1)
    b2 += (l3 - l2) * (l3 - l2)
    b3 += (v - l3) * (v - l3)
    if (++n === frame) {
      env[f] = Math.sqrt(acc / frame)
      bands[0][f] = Math.sqrt(b0 / frame)
      bands[1][f] = Math.sqrt(b1 / frame)
      bands[2][f] = Math.sqrt(b2 / frame)
      bands[3][f] = Math.sqrt(b3 / frame)
      acc = b0 = b1 = b2 = b3 = 0
      n = 0
      f++
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
  return { onsets, framesPerSec: sr / frame, bands }
}

/**
 * `buildOnsetEnvelope`'s lowest band alone (v0.9.5) — the kick envelope
 * `core/downbeat.ts` reads to find the "1". Its own pass because it runs at
 * every deck load, cached analysis or not: the full envelope cost ~190 ms on a
 * 5-minute track, and the cached waveform's own low band (one split at 200 Hz,
 * not 150) measured worse — 50/61 unseen songs against 53/61 from this one.
 * tests/platform/kick-envelope.test.ts pins it equal to `bands[0]`.
 */
export function kickEnvelope(pcm: PcmData): { low: Float32Array; framesPerSec: number } {
  const sr = pcm.sampleRate
  const chans = pcm.channels
  const nch = chans.length
  const invCh = 1 / nch
  const ch0 = chans[0]
  const ch1 = nch > 1 ? chans[1] : ch0
  const frame = Math.floor(sr / FRAMES_PER_SEC)
  const frames = Math.floor(ch0.length / frame)
  const low = new Float32Array(frames)
  const dt = 1 / sr
  const a1 = dt / (1 / (2 * Math.PI * 150) + dt)
  let l1 = 0
  for (let f = 0, i = 0; f < frames; f++) {
    let b0 = 0
    for (let n = 0; n < frame; n++, i++) {
      const v = nch > 2 ? mixAt(chans, i, invCh) : nch === 2 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]
      l1 += a1 * (v - l1)
      b0 += l1 * l1
    }
    low[f] = Math.sqrt(b0 / frame)
  }
  return { low, framesPerSec: sr / frame }
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
  const { onsets, framesPerSec, bands } = buildOnsetEnvelope(pcm)
  if (opts?.hintBpm != null && opts.hintBpm > 0) return estimateBeatGrid(onsets, framesPerSec, opts)
  // No tag: the tempo comes from the four-band estimator, then goes down the
  // exact path a tag does — the grid's fine BPM and phase are still found on
  // the kick envelope, which is what the owner's grids were tuned against.
  const tempo = estimateTempo(multiBandOnset(bands), framesPerSec, opts)
  if (tempo == null) return estimateBeatGrid(onsets, framesPerSec, opts)
  const grid = estimateBeatGrid(onsets, framesPerSec, { ...opts, hintBpm: tempo.bpm, hintWindow: 0.005 })
  // The tag path only asks whether the *phase* is clear — for a tag the tempo
  // is given. Here it was guessed, so a tie with an unrelated tempo is also
  // "unconfirmed". Without this every blind grid read confident, wrong ones
  // included (v0.8.34 review: 348 of 348). Shalom chose tie-only over flagging
  // every untagged track (25/09).
  return grid && { ...grid, confident: grid.confident && tempo.margin >= TEMPO_TIE_MARGIN }
}
