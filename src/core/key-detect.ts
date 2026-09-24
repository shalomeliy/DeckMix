/**
 * Musical key from the audio itself (v0.8.27), written from scratch.
 *
 * Until now the Key column came only from tags, so a file nobody tagged — 11
 * of Shalom's 358, 9 of them Korolova m4a/mp4 in Techno — had no key at all and
 * harmonic matching silently skipped it. This is the textbook method, built
 * from published data, not from anyone's code:
 *
 *   1. mono, decimated to ~11 kHz (nothing above ~2 kHz is used);
 *   2. Hann-windowed FFT frames → a 12-bin chroma (energy per pitch class);
 *   3. correlate the summed chroma with a major and a minor key profile,
 *      rotated to all 12 tonics — 24 candidates;
 *   4. confidence = how far the winner is ahead of the runner-up.
 *
 * Profiles (the owner's decision, 24/09): **minor is learned from the keys
 * already written in his own files** (`scripts/fit-key-profiles.mjs`); major
 * keeps the probe-tone ratings Krumhansl & Kessler published in 1982
 * (Psychological Review 89), because his library had only 14 major tracks —
 * too few to learn from. No code or trained model from any program is used,
 * only the statistics of answers already sitting in his tags. Measured with
 * this exact code on 348 tagged tracks, 5-fold held out: 71.0% exact, 85.3%
 * exact-or-neighbour; the published profiles alone scored 50.9%.
 *
 * Pure: takes samples, returns a key. No AudioContext, no DOM.
 */

/**
 * Average chroma of the 334 minor-tagged tracks in the owner's library, tonic
 * first, each track normalised to sum 1 (24/09). Regenerate with
 * `node scripts/measure-key-detect.mjs && node scripts/fit-key-profiles.mjs`
 * after any change to `chroma` — a profile fitted on a different chroma is a
 * silent mismatch that scores nothing like its recorded number.
 */
export const LIBRARY_MINOR = [0.114, 0.0699, 0.0889, 0.0893, 0.0727, 0.0854, 0.0697, 0.1101, 0.0758, 0.0703, 0.0829, 0.071]

/** Krumhansl-Kessler 1982, tonic first. */
export const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]

/** Target rate after decimation. Chroma only reads up to MAX_HZ, so ~11 kHz is plenty. */
const TARGET_RATE = 11025
/** 8192 at ~11 kHz ≈ 1.35 Hz per bin — enough to split semitones down at A1 (55 Hz, ~3.3 Hz apart). */
export const FFT_SIZE = 8192
const MIN_HZ = 55
const MAX_HZ = 2000
/** Frames quieter than this (mean magnitude per bin) are silence or a fade — their chroma is noise. */
const SILENT_FRAME = 1e-4
/** How close to a note's centre a bin must sit to count for it (see `chroma`). */
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
 * Summed chroma of the whole track. Each frame is normalised to sum 1 before it
 * is added, so a loud drop does not outvote a long quiet verse in the same key —
 * every non-silent stretch of the track gets one equal vote.
 *
 * Two choices here were measured on the owner's library (348 tagged tracks,
 * `scripts/measure-key-detect.mjs`, 24/09), not assumed:
 * - **Only bins within a quarter-semitone of a note count.** A bin half-way
 *   between two notes is smeared energy — a drum, a sweep, a detuned pad — and
 *   rounding it to the nearest note votes for a key it says nothing about.
 *   Linear magnitude, every bin: 57% exact. Centre bins only: 70%.
 * - **Magnitude, not log.** Log-compressed chroma scored ~11%: compression
 *   pushes every pitch class toward "how many FFT bins land on it", which is
 *   geometry, not music.
 */
export function chroma(channels: Float32Array[], sampleRate: number): Float64Array {
  const { x, rate } = monoDecimated(channels, sampleRate)
  const binHz = rate / FFT_SIZE
  const lo = Math.ceil(MIN_HZ / binHz)
  const hi = Math.min(FFT_SIZE / 2 - 1, Math.floor(MAX_HZ / binHz))
  // -1 = off-centre bin, ignored
  const pcOf = new Int8Array(hi + 1).fill(-1)
  for (let b = lo; b <= hi; b++) {
    const midi = 69 + 12 * Math.log2((b * binHz) / 440)
    if (Math.abs(midi - Math.round(midi)) < CENTRE_SEMITONES) pcOf[b] = ((Math.round(midi) % 12) + 12) % 12
  }
  const hann = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))

  const total = new Float64Array(12)
  const frame = new Float64Array(12)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  for (let start = 0; start + FFT_SIZE <= x.length; start += FFT_SIZE / 2) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = x[start + i] * hann[i]
      im[i] = 0
    }
    fft(re, im)
    frame.fill(0)
    let sum = 0
    let all = 0
    for (let b = lo; b <= hi; b++) {
      const mag = Math.hypot(re[b], im[b])
      all += mag
      if (pcOf[b] < 0) continue
      frame[pcOf[b]] += mag
      sum += mag
    }
    if (all / (hi - lo + 1) < SILENT_FRAME || sum === 0) continue
    for (let p = 0; p < 12; p++) total[p] += frame[p] / sum
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

/** 24-way profile match. `null` when the chroma is flat (silence, noise) — no key, said as such. */
export function keyFromChroma(c: ArrayLike<number>): DetectedKey | null {
  const scores: { tonic: number; minor: boolean; score: number }[] = []
  for (let tonic = 0; tonic < 12; tonic++) {
    scores.push({ tonic, minor: false, score: pearson(c, KK_MAJOR, tonic) })
    scores.push({ tonic, minor: true, score: pearson(c, LIBRARY_MINOR, tonic) })
  }
  scores.sort((p, q) => q.score - p.score)
  if (scores[0].score === 0) return null
  return { ...scores[0], margin: scores[0].score - scores[1].score }
}

export function detectKey(channels: Float32Array[], sampleRate: number): DetectedKey | null {
  if (!channels.length || channels[0].length < FFT_SIZE) return null
  return keyFromChroma(chroma(channels, sampleRate))
}

// pitch class (C=0) → Camelot number; the same wheel `platform/source-fsaccess/tags.ts` normalises tags with
const MAJOR_PC = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
const MINOR_PC = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]

/** `8A`-style code, the form tags are compared in. */
export function camelotOf(k: Pick<DetectedKey, 'tonic' | 'minor'>): string {
  return `${(k.minor ? MINOR_PC : MAJOR_PC)[k.tonic]}${k.minor ? 'A' : 'B'}`
}
