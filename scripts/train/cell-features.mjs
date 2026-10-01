/**
 * One feature row per half-second cell, from the per-frame features that `vocalFeatures`
 * (src/core/sound/vocal-presence.ts) produces. Used for BOTH the synthetic mixes and the owner's
 * real songs, so training and measurement see exactly the same numbers.
 *
 * Per feature (harmonic, centre, bright, motion, level-below-the-song's-loudest): the cell mean and
 * the within-cell spread, plus the mean over the five cells around it (a voice lasts longer than a
 * hit). Plus one flag: stereo. 5×3 + 1 = 16 numbers.
 * v0.12.15 adds the voice cues (src/core/sound/voice-cues.ts), three numbers each: pitch movement, the share
 * of peaks that persisted, flatness, and `mfcc_motion` — how much the cepstral coefficients 2–6 move within
 * ±1 s. A feature file without `cues` (the first real dump) is refused, not padded with zeros.
 */
export const CELL_SEC = 0.5
export const FEATURE_NAMES = [
  ...['harmonic', 'centre', 'bright', 'motion', 'rel_level'].flatMap((k) => [`${k}_mean`, `${k}_std`, `${k}_ctx5`]),
  'stereo',
  ...['fluct', 'consist', 'flat', 'mfcc_motion'].flatMap((k) => [`${k}_mean`, `${k}_std`, `${k}_ctx5`]),
]

export function cellFeatureRows(f, durationSec) {
  const nCells = Math.max(1, Math.floor(durationSec / CELL_SEC))
  const nFrames = f.harmonic.length
  let maxLevel = -Infinity
  for (let t = 0; t < nFrames; t++) maxLevel = Math.max(maxLevel, f.level[t])
  const series = {
    harmonic: f.harmonic,
    centre: f.centre,
    bright: f.bright,
    motion: f.motion,
    rel_level: Array.from(f.level, (v) => v - maxLevel),
  }
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
  series.fluct = f.cues.fluct
  series.consist = f.cues.consist
  series.flat = f.cues.flat
  series.mfcc_motion = mfccMotion
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
    const row = []
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
