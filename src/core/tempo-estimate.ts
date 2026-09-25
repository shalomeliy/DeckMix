/**
 * Blind tempo: the BPM of a track whose file carries no BPM tag (v0.8.34).
 *
 * Why this exists: the single-band autocorrelation `core/beatgrid.ts` used on
 * its own was right for 56.6% of the owner's 348 tagged tracks when told to
 * ignore the tag (scripts/measure-bpm-blind.mjs). It mostly heard a *related*
 * pulse — 105 as 139.68 is 4/3, a dembow's kick pattern — and marked it
 * confident, which is how "Heal My Mind" read 175 on 25/09. Each piece below
 * was measured on the same 348 tracks (scripts/experiment-tempo.mjs). The
 * constants were set once, not searched over — but each step was kept because
 * it scored better on those same tracks, and there is no held-out set, so the
 * numbers are in-sample:
 *
 *   single low band (the app before)      56.6%
 *   onsets from four bands                 76.7%   hats/snares carry the beat a sparse kick leaves out
 *   + scoring 2× and 4× the beat           92.0%   a real beat repeats at the bar; 4/3 of it doesn't line up there
 *   + beat comb + a prior centred on 120   96.8%   hits stack on one phase at the true period and smear at a wrong one
 *
 * Written from first principles, not from any other product's code.
 * Only the tempo is decided here. The grid's exact BPM and phase are still
 * found by `estimateBeatGrid` around this answer, the same path a tag takes.
 */

/** Log-compressed rise per band, each band scaled to unit mean so no one band dominates by level. */
export function multiBandOnset(bands: Float32Array[]): Float32Array {
  const n = bands[0].length
  const out = new Float32Array(n)
  const o = new Float32Array(n)
  for (const env of bands) {
    let sum = 0
    for (let i = 1; i < n; i++) {
      const d = Math.log1p(1000 * env[i]) - Math.log1p(1000 * env[i - 1])
      o[i] = d > 0 ? d : 0
      sum += o[i]
    }
    if (sum === 0) continue
    const scale = n / sum
    for (let i = 0; i < n; i++) out[i] += o[i] * scale
  }
  return localPeaks(out)
}

/** Onsets above a ~0.5s moving average — a sustained loud passage stops reading as a stream of beats. */
function localPeaks(o: Float32Array): Float32Array {
  const w = 50
  const out = new Float32Array(o.length)
  let acc = 0
  for (let i = 0; i < o.length; i++) {
    acc += o[i]
    if (i >= 2 * w) acc -= o[i - 2 * w]
    const c = i - w
    if (c >= 0) out[c] = Math.max(0, o[c] - acc / (2 * w + 1))
  }
  return out
}

function acfTable(o: Float32Array, maxLag: number): Float64Array {
  const t = new Float64Array(maxLag + 2)
  for (let l = 1; l <= maxLag + 1 && l < o.length; l++) {
    let s = 0
    for (let i = l; i < o.length; i++) s += o[i] * o[i - l]
    t[l] = s / (o.length - l)
  }
  return t
}

function acfAt(t: Float64Array, lag: number): number {
  const l0 = Math.floor(lag)
  const fr = lag - l0
  return t[l0] * (1 - fr) + t[l0 + 1] * fr
}

/** Share of all onset energy that lands on the strongest beat phase, plus half of what lands on the "and". */
function combScore(o: Float32Array, periodFrames: number): number {
  const nb = Math.max(8, Math.round(periodFrames))
  const bins = new Float64Array(nb)
  let total = 0
  for (let i = 0; i < o.length; i++) {
    if (!o[i]) continue
    const ph = (i / periodFrames) % 1
    bins[Math.floor(ph * nb) % nb] += o[i]
    total += o[i]
  }
  if (total === 0) return 0
  let best = 0
  let bestB = 0
  for (let b = 0; b < nb; b++) {
    const v = bins[(b + nb - 1) % nb] + bins[b] + bins[(b + 1) % nb]
    if (v > best) {
      best = v
      bestB = b
    }
  }
  const h = (bestB + Math.round(nb / 2)) % nb
  const half = bins[(h + nb - 1) % nb] + bins[h] + bins[(h + 1) % nb]
  return (best + 0.5 * half) / total
}

/**
 * Below this `margin`, an unrelated tempo scored within 5% of the winner: a tie,
 * and the grid is shown unconfirmed. It does NOT catch the wrong guesses that
 * remain — on the 348 tracks their margins (1.16, 1.88, 2.27) sat inside the
 * right ones' spread (5th percentile 1.25), so no threshold separates them.
 * What it catches is a genuine coin toss, 2 of 337 right answers.
 */
export const TEMPO_TIE_MARGIN = 1.05

const MULTIPLES = [1, 2, 4]
const COMB_WEIGHT = 4
const PRIOR_CENTRE_BPM = 120
const PRIOR_SIGMA_OCTAVES = 1

export interface TempoEstimate {
  bpm: number
  /**
   * The winner's score over the best candidate that is not the same pulse
   * (not within 3% of it, half of it, or double it). Near 1 means another,
   * unrelated tempo scored about as well — the guess is a coin toss. Octave
   * mistakes (85 heard as 170) can't show here: they *are* the same pulse.
   */
  margin: number
}

/** The tempo, or `null` when the onset function holds nothing to count (silence, too short). */
export function estimateTempo(
  onsets: Float32Array,
  framesPerSec: number,
  opts?: { minBpm?: number; maxBpm?: number },
): TempoEstimate | null {
  const min = opts?.minBpm ?? 70
  const max = opts?.maxBpm ?? 185
  const maxLag = Math.ceil((60 / min) * framesPerSec * MULTIPLES[MULTIPLES.length - 1]) + 1
  if (onsets.length < maxLag * 2) return null
  const table = acfTable(onsets, maxLag)
  const scored: { bpm: number; s: number }[] = []
  let best = 0
  let bpmBest: number | null = null
  for (let bpm = min; bpm <= max; bpm += 0.25) {
    const lag = (60 / bpm) * framesPerSec
    let s = 0
    MULTIPLES.forEach((k, j) => (s += acfAt(table, lag * k) / (j + 1)))
    s *= 1 + COMB_WEIGHT * combScore(onsets, lag)
    s *= Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTRE_BPM) / PRIOR_SIGMA_OCTAVES) ** 2)
    scored.push({ bpm, s })
    if (s > best) {
      best = s
      bpmBest = bpm
    }
  }
  if (bpmBest == null) return null
  const winner = bpmBest
  const samePulse = (bpm: number) => [1, 0.5, 2].some((k) => Math.abs(bpm / (winner * k) - 1) < 0.03)
  let rival = 0
  for (const c of scored) if (!samePulse(c.bpm) && c.s > rival) rival = c.s
  return { bpm: winner, margin: rival > 0 ? best / rival : Infinity }
}
