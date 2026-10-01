/**
 * One training mix: our own instrumental (arrange.ts) plus, when vocal clips are supplied, phrases
 * cut from them and laid over it — with the vocal label read off the vocal stem itself, so it is
 * right by construction (research §8.2: "perfect vocal on/off labels").
 *
 * Labels use the app's own timeline cells (vocal-timeline.ts): 1 = a voice clearly there,
 * 0 = clearly none, 2 = in between ("unsure"). Training must IGNORE the 2s rather than call them 0:
 * the owner's definition counts only a prominent voice, and a half-second where the voice is
 * 12–20 dB under the mix is neither.
 */
import { renderInstrumental, type Instrumental, type Stereo } from '@/core/sound/synth/arrange'
import { createRng, chance, dbToGain, uniform, type Rng } from '@/core/sound/synth/rng'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC } from '@/core/sound/vocal-timeline'

export interface VocalClip {
  id: string
  /** Mono. A stereo source is summed to mono before it gets here. */
  samples: Float32Array
  sampleRate: number
}

export interface MixOptions {
  sampleRate?: number
  bars?: number
  bpm?: number
}

export interface Mix {
  seed: number
  sampleRate: number
  bpm: number
  key: string
  mixture: Stereo
  stems: { drums: Stereo; bass: Stereo; other: Stereo; vocals: Stereo }
  /** One label per VOCAL_CELL_SEC cell. */
  labels: Uint8Array
  /** Ids of the vocal clips that were placed — the manifest turns these into the credit file. */
  vocalIds: string[]
}

/** A voice this far (dB) under the mix or quieter reads as "none"; this close or louder, as "vocal". */
const VOCAL_DB = -9
const NONE_DB = -20
/** Below this vocal level (dBFS RMS per cell) there is nothing to call a voice, whatever the mix does. */
const VOCAL_FLOOR = Math.pow(10, -50 / 20)
const PEAK = 0.9
const FADE_SEC = 0.02

export function makeMix(seed: number, clips: readonly VocalClip[], opts: MixOptions = {}): Mix {
  const sr = opts.sampleRate ?? 44100
  const inst = renderInstrumental(seed, { sampleRate: sr, bars: opts.bars ?? 48, bpm: opts.bpm })
  const len = inst.drums[0].length
  // A separate stream from the arrangement's, so adding or removing vocals never changes the music.
  const r = createRng(seed ^ 0x9e3779b9)
  const vocals: Stereo = [new Float32Array(len), new Float32Array(len)]
  const vocalIds: string[] = []
  if (clips.length) placeVocals(r, clips, inst, vocals, sr, vocalIds)

  const stems = { drums: inst.drums, bass: inst.bass, other: inst.other, vocals }
  const mixture: Stereo = [new Float32Array(len), new Float32Array(len)]
  let peak = 0
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < len; i++) {
      const v = inst.drums[c][i] + inst.bass[c][i] + inst.other[c][i] + vocals[c][i]
      mixture[c][i] = v
      peak = Math.max(peak, Math.abs(v))
    }
  }
  // One gain for the mixture AND every stem, so the stems still sum to the mixture exactly.
  const g = peak > 0 ? PEAK / peak : 1
  for (const s of [mixture, ...Object.values(stems)]) for (const ch of s) for (let i = 0; i < len; i++) ch[i] *= g

  return { seed, sampleRate: sr, bpm: inst.bpm, key: inst.key, mixture, stems, labels: labelCells(inst, vocals, sr), vocalIds }
}

function placeVocals(r: Rng, clips: readonly VocalClip[], inst: Instrumental, out: Stereo, sr: number, ids: string[]): void {
  const len = out[0].length
  const bar = ((60 / inst.bpm) * 4) * sr
  let t = Math.round(bar * 4) // the intro stays free of voice, like most dance tracks
  while (t < len - sr * 3) {
    if (chance(r, 0.75)) {
      const clip = clips[Math.floor(r() * clips.length)]
      const phrase = resample(clip, sr)
      const want = Math.floor(uniform(r, 3, 9) * sr)
      const take = Math.min(want, phrase.length, len - t)
      const from = Math.floor(r() * Math.max(1, phrase.length - take))
      const seg = phrase.subarray(from, from + take)
      // Level against what the instrumental is doing in this window, not against full scale.
      const gain = dbToGain(uniform(r, -8, 1)) * (rms(instWindow(inst, t, take)) / (rms(seg) + 1e-9))
      const p = uniform(r, -0.12, 0.12)
      const gl = Math.cos(((p + 1) * Math.PI) / 4)
      const gr = Math.sin(((p + 1) * Math.PI) / 4)
      const fade = Math.floor(FADE_SEC * sr)
      for (let i = 0; i < take; i++) {
        const f = Math.min(1, i / fade, (take - i) / fade) * gain * seg[i]
        out[0][t + i] += f * gl
        out[1][t + i] += f * gr
      }
      if (!ids.includes(clip.id)) ids.push(clip.id)
      t += take
    }
    t += Math.floor(uniform(r, 2, 8) * sr)
    t = Math.round(Math.round(t / (bar / 4)) * (bar / 4)) // phrases start on a beat, on a whole sample
  }
}

function instWindow(inst: Instrumental, at: number, n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    w[i] = inst.drums[0][at + i] + inst.bass[0][at + i] + inst.other[0][at + i]
  }
  return w
}

function labelCells(inst: Instrumental, vocals: Stereo, sr: number): Uint8Array {
  const cell = Math.floor(VOCAL_CELL_SEC * sr)
  const n = Math.floor(vocals[0].length / cell)
  const labels = new Uint8Array(n)
  for (let k = 0; k < n; k++) {
    const a = k * cell
    let v = 0
    let m = 0
    for (let i = a; i < a + cell; i++) {
      v += (vocals[0][i] + vocals[1][i]) ** 2
      m += (inst.drums[0][i] + inst.bass[0][i] + inst.other[0][i] + inst.drums[1][i] + inst.bass[1][i] + inst.other[1][i]) ** 2
    }
    const vr = Math.sqrt(v / cell / 2)
    const ir = Math.sqrt(m / cell / 2)
    // The instrumental's own level was scaled by the same gain as the vocals, so the ratio is unchanged.
    const ratioDb = 20 * Math.log10((vr + 1e-12) / (ir + 1e-12))
    labels[k] = vr < VOCAL_FLOOR ? CELL_NONE : ratioDb >= VOCAL_DB ? CELL_VOCAL : ratioDb <= NONE_DB ? CELL_NONE : CELL_UNSURE
  }
  return labels
}

const rms = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}

/** Linear interpolation — enough for a clip that is about to be mixed under music, not for mastering. */
function resample(c: VocalClip, sr: number): Float32Array {
  if (c.sampleRate === sr) return c.samples
  const n = Math.floor((c.samples.length * sr) / c.sampleRate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * c.sampleRate) / sr
    const i0 = Math.floor(x)
    const f = x - i0
    out[i] = c.samples[i0] * (1 - f) + (c.samples[Math.min(i0 + 1, c.samples.length - 1)] ?? 0) * f
  }
  return out
}
