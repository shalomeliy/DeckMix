/**
 * The trained vocal classifier, run in the app (v0.9.11). A logistic regression over the 28 cell features of cell-features.ts plus
 * one 0/1 column per genre (which IS a per-genre threshold, learned only from training songs), with its weights frozen in a small
 * JSON file of our own — no code or weights from anyone else. Training: scripts/train/export-vocal-model.py. Pure: no DOM, no audio.
 *
 * It answers "how voice-like is this half second", per cell. What the app does with that — the timeline, "unsure" in the middle,
 * Trance = none as a RULE rather than a measurement — is decided by the caller, not here.
 */
import { FEATURE_NAMES } from '@/core/sound/cell-features'

export const VOCAL_MODEL_SCHEMA = 1

export interface VocalModel {
  schema: number
  /** Must equal cell-features.ts FEATURE_NAMES: a model is only meaningful on rows built the way its training rows were. */
  featureNames: string[]
  /** One extra input column per genre, in this order. A genre not listed gets all zeros — no offset — and is reported. */
  genres: string[]
  mean: number[]
  scale: number[]
  coef: number[]
  intercept: number
  provenance: Record<string, string | number>
  /**
   * Per-genre models learned from the owner's OWN hand marks in that genre (04/10, his request: "make the Techno analysis follow my marks"),
   * from src/core/sound/vocal-genre-models.json. Absent = the frozen model alone, exactly as before.
   */
  genreModels?: Record<string, GenreModel>
}

/**
 * A logistic regression over the 28 cell features only (no genre columns: it is one genre), fitted on his marked songs of that genre
 * (scripts/train/fit-genre-marks.py). Its log-odds are averaged with the frozen model's — `blend` of the frozen one — and `shift` is added,
 * chosen so the strip's thresholds land where his marks do. Averaging, not replacing: measured on his 42 Techno songs, the genre model
 * alone lost on 12 of them, the average on 6.
 */
export interface GenreModel {
  mean: number[]
  scale: number[]
  coef: number[]
  intercept: number
  blend: number
  shift: number
  provenance: Record<string, string | number>
}

const isNumbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))

function parseGenreModels(x: unknown): Record<string, GenreModel> {
  const g = x as { schema?: unknown; featureNames?: unknown; models?: Record<string, Partial<GenreModel>> } | null
  if (!g || typeof g !== 'object' || g.schema !== VOCAL_MODEL_SCHEMA) throw new Error('vocal genre models: not a schema-1 file')
  if (!Array.isArray(g.featureNames) || g.featureNames.join('|') !== FEATURE_NAMES.join('|')) {
    throw new Error('vocal genre models: trained on different features than this build computes — refit them')
  }
  const nf = FEATURE_NAMES.length
  const out: Record<string, GenreModel> = {}
  for (const [genre, m] of Object.entries(g.models ?? {})) {
    if (!isNumbers(m.mean, nf) || !isNumbers(m.scale, nf) || !isNumbers(m.coef, nf)) throw new Error(`vocal genre model ${genre}: mean/scale/coef must be ${nf} finite numbers each`)
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    if (!num(m.intercept) || !num(m.shift) || !num(m.blend) || m.blend! < 0 || m.blend! > 1) throw new Error(`vocal genre model ${genre}: intercept/shift/blend missing or out of range`)
    out[genre] = { mean: m.mean, scale: m.scale, coef: m.coef, intercept: m.intercept!, blend: m.blend!, shift: m.shift!, provenance: m.provenance ?? {} }
  }
  return out
}

/**
 * Reads a model file (and optionally the genre-models file), refusing anything that would silently produce wrong numbers. Throws with the
 * reason: a broken genre file fails loudly rather than quietly falling back to the frozen model.
 */
export function parseVocalModel(x: unknown, genreModels?: unknown): VocalModel {
  const m = x as Partial<VocalModel> | null
  if (!m || typeof m !== 'object') throw new Error('vocal model: not an object')
  if (m.schema !== VOCAL_MODEL_SCHEMA) throw new Error(`vocal model: schema ${String(m.schema)} is not ${VOCAL_MODEL_SCHEMA}`)
  if (!Array.isArray(m.featureNames) || m.featureNames.join('|') !== FEATURE_NAMES.join('|')) {
    throw new Error('vocal model: it was trained on different features than this build computes — retrain it')
  }
  if (!Array.isArray(m.genres) || !m.genres.every((g) => typeof g === 'string')) throw new Error('vocal model: genres missing')
  const n = FEATURE_NAMES.length + m.genres.length
  if (!isNumbers(m.mean, n) || !isNumbers(m.scale, n) || !isNumbers(m.coef, n)) throw new Error(`vocal model: mean/scale/coef must be ${n} finite numbers each`)
  if (typeof m.intercept !== 'number' || !Number.isFinite(m.intercept)) throw new Error('vocal model: intercept missing')
  const base = { schema: m.schema, featureNames: m.featureNames, genres: m.genres, mean: m.mean, scale: m.scale, coef: m.coef, intercept: m.intercept, provenance: m.provenance ?? {} }
  return genreModels === undefined ? base : { ...base, genreModels: parseGenreModels(genreModels) }
}

export interface CellProbabilities {
  /** Probability of voice per cell, 0–1. */
  probs: Float32Array
  /** False when the genre is not one the model was trained with: the probabilities are still computed, without a genre offset, and the caller must say so. */
  genreKnown: boolean
  /** True when this genre's model from his own marks was used on top of the frozen one. */
  fromOwnerMarks: boolean
}

export function cellProbabilities(rows: readonly (readonly number[])[], genre: string, model: VocalModel): CellProbabilities {
  const nf = FEATURE_NAMES.length
  const gi = model.genres.indexOf(genre)
  const gm = model.genreModels?.[genre]
  const probs = new Float32Array(rows.length)
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].length !== nf) throw new Error(`vocal model: a row has ${rows[r].length} features, expected ${nf}`)
    let z = model.intercept
    for (let j = 0; j < model.coef.length; j++) {
      const raw = j < nf ? rows[r][j] : j - nf === gi ? 1 : 0
      // sklearn's StandardScaler leaves a constant column unscaled rather than dividing by 0.
      z += (model.coef[j] * (raw - model.mean[j])) / (model.scale[j] || 1)
    }
    if (gm) {
      let zg = gm.intercept
      for (let j = 0; j < nf; j++) zg += (gm.coef[j] * (rows[r][j] - gm.mean[j])) / (gm.scale[j] || 1)
      z = gm.blend * z + (1 - gm.blend) * zg + gm.shift
    }
    probs[r] = 1 / (1 + Math.exp(-z))
  }
  return { probs, genreKnown: gi >= 0, fromOwnerMarks: !!gm }
}

/** Mean probability over the cells `[from, to)` — how a clip was scored in the measurements. */
export function meanProbability(probs: ArrayLike<number>, from: number, to: number): number {
  const a = Math.max(0, from)
  const b = Math.min(probs.length, to)
  if (b <= a) return NaN
  let s = 0
  for (let i = a; i < b; i++) s += probs[i]
  return s / (b - a)
}
