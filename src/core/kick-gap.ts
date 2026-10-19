/**
 * The kick-gap meter (v0.9.75, the owner, 19/10): "the basses of the outgoing and incoming songs do not sit on each other any more".
 * Mix Assist locks the two decks by their beat GRIDS (`kick-lock.ts`, `syncPhaseDeltaSec`); whether the kicks you hear sit together is a
 * different question — a grid a few tens of ms off the real kicks passes every grid check and still sounds apart. This reads the audio
 * itself: both decks' low band, the kick onsets in each, and how far apart the nearest pairs are. Pure: the samples come in.
 *
 * Measured on windows both decks were read at the same instant, so whatever the read does to the time axis does it to both.
 */

/** Low band the kick and the bass live in. Three one-pole filters at 150 Hz: steep enough to drop hats, cheap enough to run beside playback. */
const LOW_HZ = 150
/** Envelope rate: 1 kHz, so one sample is 1 ms and the gap reads straight off the index. */
const ENV_HZ = 1000
/** The first part of a window belongs to the filters warming up, not to the music. */
const SKIP_MS = 120
/** A kick's low-band rise must be at least this (envelope units, full scale 1): below it the "kicks" are ripple of a steady tone. */
const MIN_FLUX = 0.005
/** A kick is a flux peak above this share of the window's strongest one. */
const PEAK_SHARE = 0.5
/** Two kicks closer than this are one (a kick's own tail ringing). */
const MIN_APART_MS = 150
/** Fewer matched kick pairs than this over the whole mix and the meter says it could not measure. */
export const MIN_PAIRS = 4

export function lowEnvelope(x: Float32Array, sampleRate: number): Float32Array {
  const k = 1 - Math.exp((-2 * Math.PI * LOW_HZ) / sampleRate)
  const step = sampleRate / ENV_HZ
  const out = new Float32Array(Math.floor(x.length / step))
  let y1 = 0
  let y2 = 0
  let y3 = 0
  let acc = 0
  let cnt = 0
  let oi = 0
  let next = step
  for (let i = 0; i < x.length && oi < out.length; i++) {
    y1 += k * (x[i] - y1)
    y2 += k * (y1 - y2)
    y3 += k * (y2 - y3)
    acc += Math.abs(y3)
    cnt++
    if (i + 1 >= next) {
      out[oi++] = acc / cnt
      acc = 0
      cnt = 0
      next += step
    }
  }
  return out
}

/** Kick onsets in ms from the start of the envelope: the positive rise over 8 ms, peaks above `PEAK_SHARE` of the strongest. */
export function kickOnsetsMs(env: Float32Array): number[] {
  const flux = new Float32Array(env.length)
  let max = 0
  for (let i = SKIP_MS; i < env.length; i++) {
    flux[i] = Math.max(0, env[i] - env[i - 8])
    if (flux[i] > max) max = flux[i]
  }
  if (max < MIN_FLUX) return []
  const out: number[] = []
  let last = -Infinity
  for (let i = SKIP_MS + 1; i < env.length - 1; i++) {
    if (flux[i] > PEAK_SHARE * max && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last > MIN_APART_MS) {
      out.push(i)
      last = i
    }
  }
  return out
}

/**
 * A tap window is under one second (0.74 s at 44.1 kHz), about one and a half kicks, so a single window rarely holds enough to call: it
 * returns its matched differences and the verdict is taken over the whole mix.
 */
export type KickGap = number[]

/**
 * One window: for each incoming kick the nearest outgoing kick within half a beat, as `incoming - outgoing` in ms. Empty when either deck
 * has no kick in it.
 */
export function kickGap(outgoing: Float32Array, incoming: Float32Array, sampleRate: number, beatMs: number): KickGap {
  const a = kickOnsetsMs(lowEnvelope(outgoing, sampleRate))
  const b = kickOnsetsMs(lowEnvelope(incoming, sampleRate))
  if (!a.length || !b.length) return []
  const diffs: number[] = []
  for (const t of b) {
    let best = a[0]
    for (const u of a) if (Math.abs(u - t) < Math.abs(best - t)) best = u
    const d = t - best
    if (Math.abs(d) <= beatMs / 2) diffs.push(d)
  }
  return diffs
}

export interface KickGapSummary {
  /** matched kick pairs, over the whole mix */
  pairs: number
  /** windows read / windows that held at least one pair */
  read: number
  measured: number
  /** median of all the pairs' differences, signed (positive = the incoming kicks land later) */
  medianMs: number
  /** nine in ten pairs were within this many ms of the outgoing kick */
  p90Ms: number
}

/** The whole mix: null when fewer than `MIN_PAIRS` pairs matched — said as such, never as 0. */
export function summarizeGaps(windows: KickGap[]): KickGapSummary | null {
  const all = windows.flat().sort((p, q) => p - q)
  if (all.length < MIN_PAIRS) return null
  const abs = all.map(Math.abs).sort((p, q) => p - q)
  return {
    pairs: all.length,
    read: windows.length,
    measured: windows.filter((w) => w.length > 0).length,
    medianMs: all[Math.floor(all.length / 2)],
    p90Ms: abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.9))],
  }
}

/** Past this many ms the two kicks are heard as two: the notice turns into a warning. */
export const KICK_GAP_WARN_MS = 12
