/**
 * One feature row per half-second cell, from the per-frame features `vocalFeatures` (vocal-presence.ts) produces (v0.9.11 move
 * into `core/`; it lived in scripts/train/ as a .mjs since v0.12.15). It is the ONE definition used for training the vocal
 * classifier, for measuring it, and — now — for running it in the app: a trained model is only meaningful on rows built exactly
 * the way its training rows were, and two copies of this maths is how that stops being true.
 *
 * Per feature (harmonic, centre, bright, motion, level-below-the-song's-loudest): the cell mean and the within-cell spread, plus
 * the mean over the five cells around it (a voice lasts longer than a hit). Plus one flag: stereo. Then the voice cues
 * (voice-cues.ts): pitch movement, the share of peaks that persisted, flatness, and `mfcc_motion` — how much the cepstral
 * coefficients 2–6 move within ±1 s. 5×3 + 1 + 4×3 = 28 numbers.
 *
 * No imports on purpose: scripts/train/ runs this file straight under Node.
 */
export const CELL_SEC = 0.5
export const FEATURE_NAMES: readonly string[] = [
  ...['harmonic', 'centre', 'bright', 'motion', 'rel_level'].flatMap((k) => [`${k}_mean`, `${k}_std`, `${k}_ctx5`]),
  'stereo',
  ...['fluct', 'consist', 'flat', 'mfcc_motion'].flatMap((k) => [`${k}_mean`, `${k}_std`, `${k}_ctx5`]),
]

export interface CellFeatureInput {
  frameSec: number
  stereo: boolean
  harmonic: ArrayLike<number>
  centre: ArrayLike<number>
  bright: ArrayLike<number>
  motion: ArrayLike<number>
  level: ArrayLike<number>
  /** `mfcc` is frames × coefficients, row-major. A file without `cues` is refused, not padded with zeros. */
  cues?: { mfcc: ArrayLike<number>; fluct: ArrayLike<number>; consist: ArrayLike<number>; flat: ArrayLike<number> }
}

export function cellFeatureRows(f: CellFeatureInput, durationSec: number): number[][] {
  const nCells = Math.max(1, Math.floor(durationSec / CELL_SEC))
  const nFrames = f.harmonic.length
  let maxLevel = -Infinity
  for (let t = 0; t < nFrames; t++) maxLevel = Math.max(maxLevel, f.level[t])
  if (!f.cues) throw new Error('features have no `cues` — dump them again with the current dump script')
  const MC = f.cues.mfcc.length / nFrames
  const mfccMotion = new Float32Array(nFrames)
  for (let t = 0; t < nFrames; t++) {
    const a = Math.max(0, t - 11)
    const b = Math.min(nFrames - 1, t + 11)
    let tot = 0
    for (let c = 0; c < MC; c++) {
      let m = 0
      for (let u = a; u <= b; u++) m += f.cues.mfcc[u * MC + c]
      m /= b - a + 1
      let v = 0
      for (let u = a; u <= b; u++) v += (f.cues.mfcc[u * MC + c] - m) ** 2
      tot += Math.sqrt(v / (b - a + 1))
    }
    mfccMotion[t] = tot / MC
  }
  const series: Record<string, ArrayLike<number>> = {
    harmonic: f.harmonic,
    centre: f.centre,
    bright: f.bright,
    motion: f.motion,
    rel_level: Array.from(f.level, (v) => v - maxLevel),
    fluct: f.cues.fluct,
    consist: f.cues.consist,
    flat: f.cues.flat,
    mfcc_motion: mfccMotion,
  }
  const names = Object.keys(series)
  const mean = names.map(() => new Float64Array(nCells))
  const std = names.map(() => new Float64Array(nCells))
  for (let c = 0; c < nCells; c++) {
    const t0 = Math.min(nFrames - 1, Math.floor((c * CELL_SEC) / f.frameSec))
    const t1 = Math.min(nFrames, Math.max(t0 + 1, Math.floor(((c + 1) * CELL_SEC) / f.frameSec)))
    names.forEach((k, i) => {
      let s = 0
      let s2 = 0
      for (let t = t0; t < t1; t++) {
        s += series[k][t]
        s2 += series[k][t] ** 2
      }
      const m = s / (t1 - t0)
      mean[i][c] = m
      std[i][c] = Math.sqrt(Math.max(0, s2 / (t1 - t0) - m * m))
    })
  }
  const stereo = f.stereo ? 1 : 0
  return Array.from({ length: nCells }, (_, c) => {
    const row: number[] = []
    names.forEach((_, i) => {
      if (i === 5) row.push(stereo) // keeps the first 16 columns exactly as before
      let ctx = 0
      let n = 0
      for (let d = -2; d <= 2; d++) {
        const j = c + d
        if (j >= 0 && j < nCells) {
          ctx += mean[i][j]
          n++
        }
      }
      row.push(mean[i][c], std[i][c], ctx / n)
    })
    // A non-finite number would travel as JSON null and reach the trainer as NaN; stop here, where the cause is.
    if (row.some((v) => !Number.isFinite(v))) throw new Error(`non-finite feature in cell ${c}`)
    return row.map((v) => Math.round(v * 1e5) / 1e5)
  })
}
