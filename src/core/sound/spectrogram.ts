/**
 * A picture of one short clip for the person tagging it (v0.9.11): time across, pitch up (log-spaced, so an octave is the
 * same height everywhere), brightness = how loud. It exists because the waveform's colour cannot show a voice: green there
 * is just "mid frequencies", which snares, claps and synth leads fill too. What a singing or rapping voice does look like
 * is a stack of horizontal stripes (its harmonics) that bend and wobble; drums are short vertical smears.
 *
 * Display only — nothing here feeds the vocal classifier, so changing it cannot move the 85%.
 *
 * Brightness is relative to the clip's OWN loud level (a high percentile, not the maximum): a single click or kick in the
 * clip must not turn every quiet voice in it to black, and a quiet rip must not look empty. The same sound at half the
 * volume therefore draws the same picture.
 */
import { createFft } from '@/core/sound/fft'

export const SPEC_FRAME = 2048
/** ~25 ms between columns at 44.1 kHz — fine enough to see a vibrato bend, ~200 columns for 5 s. */
const HOP_SEC = 0.025
export const SPEC_ROWS = 64
export const SPEC_MIN_HZ = 100
export const SPEC_MAX_HZ = 4000
/** Below this peak the clip is silence; drawing it would show noise as if it were content. Same figure as vocal-presence. */
const SILENT_PEAK = 1e-3
/** How far below the clip's loud level (dB) is still drawn; darker than that is black. */
const RANGE_DB = 55
/** The loud level is this fraction of the way up the sorted cells — high enough to ignore one click, low enough to be a real peak. */
const LOUD_PERCENTILE = 0.97
/**
 * Voices carry far less energy at 3 kHz than drums do at 100 Hz; a flat picture is all low-end. This tilts the picture up by
 * this much per octave so the harmonics of a voice are visible. Display gain, like the waveform's normalisation.
 */
const TILT_DB_PER_OCTAVE = 3

export type SpectrogramState = 'ok' | 'silent' | 'too-short'

export interface Spectrogram {
  state: SpectrogramState
  cols: number
  rows: number
  /** `cols × rows` brightness 0..255, column-major: `data[col * rows + row]`, row 0 = the lowest pitch. Empty unless state is 'ok'. */
  data: Uint8Array
  hopSec: number
}

const empty = (state: SpectrogramState): Spectrogram => ({ state, cols: 0, rows: SPEC_ROWS, data: new Uint8Array(0), hopSec: HOP_SEC })

/** The centre pitch of a row, for the axis. */
export function spectrogramRowHz(row: number): number {
  return SPEC_MIN_HZ * Math.pow(SPEC_MAX_HZ / SPEC_MIN_HZ, row / (SPEC_ROWS - 1))
}

export function clipSpectrogram(samples: Float32Array, sampleRate: number): Spectrogram {
  if (!(sampleRate > 0) || samples.length < SPEC_FRAME) return empty('too-short')
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (!(peak > SILENT_PEAK)) return empty('silent')

  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC))
  const cols = Math.floor((samples.length - SPEC_FRAME) / hop) + 1
  const fft = createFft(SPEC_FRAME)
  const hann = new Float64Array(SPEC_FRAME)
  for (let i = 0; i < SPEC_FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEC_FRAME)
  const re = new Float64Array(SPEC_FRAME)
  const im = new Float64Array(SPEC_FRAME)
  const binHz = sampleRate / SPEC_FRAME
  const nyquistBin = SPEC_FRAME / 2 - 1
  // Where each row reads the spectrum: a fractional bin, interpolated, because at the low end the rows are closer together
  // than the bins are wide (100 Hz → 6 Hz between rows, 21 Hz per bin) and picking the nearest bin would draw staircases.
  const rowBin = Float64Array.from({ length: SPEC_ROWS }, (_, r) => Math.min(nyquistBin - 1, spectrogramRowHz(r) / binHz))
  const rowTilt = Float64Array.from({ length: SPEC_ROWS }, (_, r) => TILT_DB_PER_OCTAVE * Math.log2(spectrogramRowHz(r) / SPEC_MIN_HZ))

  const db = new Float32Array(cols * SPEC_ROWS)
  for (let c = 0; c < cols; c++) {
    const start = c * hop
    for (let i = 0; i < SPEC_FRAME; i++) {
      re[i] = hann[i] * samples[start + i]
      im[i] = 0
    }
    fft.forward(re, im)
    for (let r = 0; r < SPEC_ROWS; r++) {
      const k = Math.floor(rowBin[r])
      const f = rowBin[r] - k
      const m0 = Math.hypot(re[k], im[k])
      const m1 = Math.hypot(re[k + 1], im[k + 1])
      db[c * SPEC_ROWS + r] = 20 * Math.log10(m0 * (1 - f) + m1 * f + 1e-9) + rowTilt[r]
    }
  }

  const sorted = Float32Array.from(db).sort()
  const loud = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * LOUD_PERCENTILE))]
  const data = new Uint8Array(db.length)
  for (let i = 0; i < db.length; i++) data[i] = Math.round(255 * Math.min(1, Math.max(0, (db[i] - (loud - RANGE_DB)) / RANGE_DB)))
  return { state: 'ok', cols, rows: SPEC_ROWS, data, hopSec: HOP_SEC }
}
