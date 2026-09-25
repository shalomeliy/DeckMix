/**
 * Musical key from the audio itself (v0.8.27), written from scratch; v0.8.30
 * splits it into three frequency bands.
 *
 * Until v0.8.27 the Key column came only from tags, so a file nobody tagged —
 * 11 of Shalom's 358, 9 of them Korolova m4a/mp4 in Techno — had no key at all
 * and harmonic matching silently skipped it. This is the textbook method, built
 * from published data, not from anyone's code:
 *
 *   1. mono, decimated to ~11 kHz (nothing above 1 kHz is used);
 *   2. Hann-windowed FFT frames → a 12-bin chroma (energy per pitch class),
 *      one per frequency band (`BANDS`);
 *   3. correlate each band's chroma with that band's major and minor key
 *      profile, rotated to all 12 tonics, and add the bands up by weight — 24
 *      candidates;
 *   4. confidence = how far the winner is ahead of the runner-up.
 *
 * Profiles (the owner's decision, 24/09): **minor is learned from the keys
 * already written in his own files**, one profile per band
 * (`scripts/fit-key-profiles.mjs`); major keeps the probe-tone ratings
 * Krumhansl & Kessler published in 1982 (Psychological Review 89) in every
 * band, because his library had only 14 major tracks — too few to learn from.
 * No code or trained model from any program is used, only the statistics of
 * answers already sitting in his tags.
 *
 * Pure: takes samples, returns a key. No AudioContext, no DOM.
 */

/** Krumhansl-Kessler 1982, tonic first. */
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]

/**
 * The bands, their weights, and each band's minor profile (average chroma of
 * the minor-tagged tracks in the owner's library, tonic first).
 *
 * Why bands (v0.8.30, `scripts/experiment-key-bands.mjs`, 24/09): one chroma
 * for 55–2000 Hz lets whatever is loudest decide — in this music the kick,
 * the bass and the overtones of a lead, which point at different keys. Each
 * band alone scored 62% (bass), 41%, 65% and 48% (1–2 kHz); together, with the
 * weights picked inside each fold by an inner cross-validation so the number
 * never saw the tracks it scored, 76.7% exact / 90.8% exact-or-neighbour
 * (one chroma: 71.0% / 85.3%). Measured again with this exact code and these
 * profiles (`fit-key-profiles.mjs`, 5-fold held out): 77.0% / 91.1%. The weights came out the same in four folds of
 * five: bass and 500–1000 Hz count fully, 220–500 half, 1–2 kHz not at all —
 * it is mostly overtones, which vote for the fifth above the real key.
 *
 * Regenerate the profiles with `node scripts/measure-key-detect.mjs &&
 * node scripts/fit-key-profiles.mjs` after any change to `bandChroma` — a
 * profile fitted on a different chroma is a silent mismatch that scores
 * nothing like its recorded number.
 */
export const BANDS: readonly { loHz: number; hiHz: number; weight: number; minor: readonly number[] }[] = [
  { loHz: 55, hiHz: 220, weight: 1, minor: [0.1282, 0.076, 0.0745, 0.0808, 0.0739, 0.0812, 0.0706, 0.0999, 0.0829, 0.0722, 0.0816, 0.0784] },
  { loHz: 220, hiHz: 500, weight: 0.5, minor: [0.1161, 0.0695, 0.0934, 0.0984, 0.0695, 0.0881, 0.0721, 0.1166, 0.0759, 0.0595, 0.077, 0.0638] },
  { loHz: 500, hiHz: 1000, weight: 1, minor: [0.1164, 0.0661, 0.0956, 0.095, 0.0678, 0.0872, 0.0639, 0.1181, 0.0729, 0.0666, 0.0849, 0.0655] },
]

/** Target rate after decimation. Chroma only reads up to the top band, so ~11 kHz is plenty. */
const TARGET_RATE = 11025
/** 8192 at ~11 kHz ≈ 1.35 Hz per bin — enough to split semitones down at A1 (55 Hz, ~3.3 Hz apart). */
export const FFT_SIZE = 8192
/** ~12s of frames: one vote per stretch of the track, so a long intro or breakdown weighs what its length says, no more. */
const SEGMENT_SEC = 12
/** Frames quieter than this (mean magnitude per bin) are silence or a fade — their chroma is noise. */
const SILENT_FRAME = 1e-4
/** How close to a note's centre a bin must sit to count for it (see `bandChroma`). */
const CENTRE_SEMITONES = 0.25

export interface DetectedKey {
  /** 0 = C … 11 = B */
  tonic: number
  minor: boolean
  /** Pearson correlation of the winner, −1..1. */
  score: number
  /** winner − runner-up correlation. Small = the audio doesn't pick a key. */
  margin: number
}

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** Average all channels, then average blocks of `factor` samples — a crude low-pass plus decimation. */
function monoDecimated(channels: Float32Array[], sampleRate: number): { x: Float32Array; rate: number } {
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE))
  const len = Math.floor(channels[0].length / factor)
  const x = new Float32Array(len)
  const scale = 1 / (factor * channels.length)
  for (let i = 0; i < len; i++) {
    let s = 0
    const base = i * factor
    for (const ch of channels) for (let k = 0; k < factor; k++) s += ch[base + k]
    x[i] = s * scale
  }
  return { x, rate: sampleRate / factor }
}

/**
 * One 12-bin chroma per band (`BANDS`), each summing to 1.
 *
 * Every FFT frame is normalised per band before it is added, and every ~12s
 * segment again before it joins the total, so a loud drop does not outvote a
 * long quiet verse in the same key — each stretch of the track gets one vote.
 *
 * Measured on the owner's library (348 tagged tracks, 24/09), not assumed:
 * - **Only bins within a quarter-semitone of a note count.** A bin half-way
 *   between two notes is smeared energy — a drum, a sweep, a detuned pad — and
 *   rounding it to the nearest note votes for a key it says nothing about.
 *   Linear magnitude, every bin: 57% exact. Centre bins only: 70%. Narrower
 *   (±15 cents) or wider (±35) both scored lower.
 * - **Magnitude, not log.** Log-compressed chroma scored ~11%: compression
 *   pushes every pitch class toward "how many FFT bins land on it", which is
 *   geometry, not music.
 * - **No per-track tuning estimate** (tried v0.8.30): 8 points *worse* —
 *   below ~200 Hz one FFT bin is wider than the tuning error being measured.
 */
export function bandChroma(channels: Float32Array[], sampleRate: number): Float64Array[] {
  const { x, rate } = monoDecimated(channels, sampleRate)
  const binHz = rate / FFT_SIZE
  const lo = Math.ceil(BANDS[0].loHz / binHz)
  const hi = Math.min(FFT_SIZE / 2 - 1, Math.floor(BANDS[BANDS.length - 1].hiHz / binHz))
  const nb = BANDS.length
  // per bin: its pitch class (-1 = off-centre, ignored) and its band
  const pcOf = new Int8Array(hi + 1).fill(-1)
  const bandOf = new Int8Array(hi + 1)
  for (let b = lo; b <= hi; b++) {
    const hz = b * binHz
    const midi = 69 + 12 * Math.log2(hz / 440)
    if (Math.abs(midi - Math.round(midi)) < CENTRE_SEMITONES) pcOf[b] = ((Math.round(midi) % 12) + 12) % 12
    let k = 0
    while (k < nb - 1 && hz >= BANDS[k].hiHz) k++
    bandOf[b] = k
  }
  const hann = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))

  const hop = FFT_SIZE / 2
  const framesPerSegment = Math.max(1, Math.round((SEGMENT_SEC * rate) / hop))
  const total = Array.from({ length: nb }, () => new Float64Array(12))
  const segment = Array.from({ length: nb }, () => new Float64Array(12))
  const frame = Array.from({ length: nb }, () => new Float64Array(12))
  const frameSum = new Float64Array(nb)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const addSegment = () => {
    for (let k = 0; k < nb; k++) {
      const s = segment[k].reduce((a, v) => a + v, 0)
      if (s > 0) for (let p = 0; p < 12; p++) total[k][p] += segment[k][p] / s
      segment[k].fill(0)
    }
  }
  let inSegment = 0
  for (let start = 0; start + FFT_SIZE <= x.length; start += hop) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = x[start + i] * hann[i]
      im[i] = 0
    }
    fft(re, im)
    for (const f of frame) f.fill(0)
    frameSum.fill(0)
    let all = 0
    for (let b = lo; b <= hi; b++) {
      const mag = Math.hypot(re[b], im[b])
      all += mag
      if (pcOf[b] < 0) continue
      frame[bandOf[b]][pcOf[b]] += mag
      frameSum[bandOf[b]] += mag
    }
    if (all / (hi - lo + 1) >= SILENT_FRAME) {
      for (let k = 0; k < nb; k++) {
        if (frameSum[k] > 0) for (let p = 0; p < 12; p++) segment[k][p] += frame[k][p] / frameSum[k]
      }
    }
    if (++inSegment === framesPerSegment) {
      addSegment()
      inSegment = 0
    }
  }
  // a short tail still counts; a few stray frames do not get a whole segment's vote
  if (inSegment > framesPerSegment / 3) addSegment()
  for (const t of total) {
    const s = t.reduce((a, v) => a + v, 0)
    if (s > 0) for (let p = 0; p < 12; p++) t[p] /= s
  }
  return total
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, rot: number): number {
  let ma = 0
  let mb = 0
  for (let i = 0; i < 12; i++) {
    ma += a[(i + rot) % 12]
    mb += b[i]
  }
  ma /= 12
  mb /= 12
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da < 1e-12 || db === 0 ? 0 : num / Math.sqrt(da * db)
}

/**
 * 24-way profile match over the bands, weighted and scaled back to −1..1.
 * `null` when every band is flat (silence, noise) — no key, said as such.
 */
export function keyFromBands(bands: readonly ArrayLike<number>[]): DetectedKey | null {
  const wsum = BANDS.reduce((a, b) => a + b.weight, 0)
  const scores: { tonic: number; minor: boolean; score: number }[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      let score = 0
      BANDS.forEach((band, k) => {
        score += band.weight * pearson(bands[k], minor ? band.minor : KK_MAJOR, tonic)
      })
      scores.push({ tonic, minor, score: score / wsum })
    }
  }
  scores.sort((p, q) => q.score - p.score)
  if (scores[0].score === 0) return null
  return { ...scores[0], margin: scores[0].score - scores[1].score }
}

export function detectKey(channels: Float32Array[], sampleRate: number): DetectedKey | null {
  if (!channels.length || channels[0].length < FFT_SIZE) return null
  return keyFromBands(bandChroma(channels, sampleRate))
}

// pitch class (C=0) → Camelot number; the same wheel `platform/source-fsaccess/tags.ts` normalises tags with
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

/** `8A`-style code, the form tags are compared in. */
export function camelotOf(k: Pick<DetectedKey, 'tonic' | 'minor'>): string {
  return `${(k.minor ? MINOR_PC : MAJOR_PC)[k.tonic]}${k.minor ? 'A' : 'B'}`
}

// Camelot number 1..12 → display spelling; the same spellings `parseKey` in tags.ts normalises a tag to,
// so a detected key and a tagged one never read differently for the same key
const NAME_MAJOR = ['B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E']
const NAME_MINOR = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'Dbm']

/** `Am`-style spelling for the Key column. */
export function keyNameOf(k: Pick<DetectedKey, 'tonic' | 'minor'>): string {
  return (k.minor ? NAME_MINOR : NAME_MAJOR)[(k.minor ? MINOR_PC : MAJOR_PC)[k.tonic] - 1]
}

/**
 * Below this lead over the runner-up the audio does not really pick one key.
 * Measured on the owner's 348 tagged tracks with the three-band detector
 * (v0.8.30, `fit-key-profiles.mjs`): at or above it, 88% of them, 82% exact;
 * below it, 39% exact. Such a key is still shown —
 * hiding it would be a silent skip — but marked uncertain.
 */
export const UNCERTAIN_MARGIN = 0.03

/**
 * The fields a detected key puts on a `Track` (v0.8.27). Only ever applied to
 * a track with no key tag: a tag is the owner's own data and always wins —
 * see `mergeTagPatch` and `fillDetectedKey`.
 */
export function detectedKeyFields(k: DetectedKey): { key: string; camelot: string; keySource: 'detected'; keyUncertain: boolean } {
  return { key: keyNameOf(k), camelot: camelotOf(k), keySource: 'detected', keyUncertain: k.margin < UNCERTAIN_MARGIN }
}
