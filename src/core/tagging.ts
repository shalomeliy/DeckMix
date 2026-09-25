/**
 * v0.9.0 — the owner tags, the app gets measured. Shalom marks which of the
 * four beats is the "1" (and whether a short clip has vocals) on a sample the
 * app picks; those answers are the ground truth v0.9.1's bar detection is
 * measured against. Without them every "the detector got better" is a guess.
 *
 * Pure: which tracks, where in each track to play, and what gets stored.
 */
import { BEATS_PER_BAR, shiftGrid } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

export const TAG_SCHEMA = 1
/** ~24 per genre over 5 genres ≈ 120 — the size ROADMAP.md's v0.9.0 asks for. */
export const BAR_PER_GENRE = 24
/**
 * Sealed as the final test before anything is tuned: tuned on, a score only
 * says the weights learned these songs. 6 × 5 = 30, ROADMAP.md's 25–30.
 */
export const HOLDOUT_PER_GENRE = 6
export const TAG_GENRES = 5
/** 6 × 5 = 30 vocal clips, ROADMAP.md's "~30 לשירה". */
export const VOCAL_PER_GENRE = 6
export const VOCAL_HOLDOUT_PER_GENRE = 2
export const VOCAL_CLIP_SEC = 5
/** Four bars: two of build-up and two after the change, so the "1" is heard landing. */
export const LOOP_BARS = 4

export interface SampleEntry {
  trackId: string
  genre: string
  holdout: boolean
}

/**
 * A stable pseudo-random order: the same library gives the same sample on
 * every open, so a half-finished session picks up where it stopped instead
 * of drawing new songs and leaving the tagged ones stranded outside it.
 */
function stableKey(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The largest genres, each shuffled the same way every time. Tracks with no genre are left out — there is no group to balance them in. */
function genreGroups(tracks: readonly { id: string; genre?: string }[]): [string, string[]][] {
  const byGenre = new Map<string, string[]>()
  for (const t of tracks) {
    if (!t.genre) continue
    const list = byGenre.get(t.genre) ?? []
    list.push(t.id)
    byGenre.set(t.genre, list)
  }
  return [...byGenre.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, TAG_GENRES)
    .map(([g, ids]) => [g, [...ids].sort((a, b) => stableKey(a) - stableKey(b) || a.localeCompare(b))])
}

/** The bar-tagging sample: `BAR_PER_GENRE` per genre, the first `HOLDOUT_PER_GENRE` of each sealed. Interleaved by genre so stopping early still leaves a balanced set. */
export function pickBarSample(tracks: readonly { id: string; genre?: string }[]): SampleEntry[] {
  const groups = genreGroups(tracks).map(([g, ids]) => [g, ids.slice(0, BAR_PER_GENRE)] as const)
  const out: SampleEntry[] = []
  for (let i = 0; i < BAR_PER_GENRE; i++) {
    for (const [genre, ids] of groups) {
      if (i < ids.length) out.push({ trackId: ids[i], genre, holdout: i < HOLDOUT_PER_GENRE })
    }
  }
  return out
}

/** The vocal sample: songs right after the bar holdout in the same order, so the two sealed sets do not overlap. */
export function pickVocalSample(tracks: readonly { id: string; genre?: string }[]): SampleEntry[] {
  const groups = genreGroups(tracks).map(
    ([g, ids]) => [g, ids.slice(HOLDOUT_PER_GENRE, HOLDOUT_PER_GENRE + VOCAL_PER_GENRE)] as const,
  )
  const out: SampleEntry[] = []
  for (let i = 0; i < VOCAL_PER_GENRE; i++) {
    for (const [genre, ids] of groups) {
      if (i < ids.length) out.push({ trackId: ids[i], genre, holdout: i < VOCAL_HOLDOUT_PER_GENRE })
    }
  }
  return out
}

/**
 * Where to play the tagging loop: two bars before the biggest jumps in energy
 * — a drop, or a new part coming in. The "1" is easiest to hear exactly
 * there, so that is the tip on screen, and the loop is built to contain it.
 * `energy` is one value per equal slice of the track. Up to `count` spots, at
 * least 8 bars apart; the start of the track when nothing stands out.
 */
export function dropSpots(energy: ArrayLike<number>, durationSec: number, grid: BeatGrid, count = 3): number[] {
  const barSec = (BEATS_PER_BAR * 60) / grid.bpm
  const n = energy.length
  if (n === 0 || durationSec <= 0) return [grid.offsetSec]
  const perSec = n / durationSec
  const barEnergy: number[] = []
  for (let start = grid.offsetSec; start + barSec <= durationSec; start += barSec) {
    const a = Math.floor(start * perSec)
    const b = Math.max(a + 1, Math.floor((start + barSec) * perSec))
    let sum = 0
    for (let i = a; i < b && i < n; i++) sum += energy[i]
    barEnergy.push(sum / (b - a))
  }
  const scored: { bar: number; rise: number }[] = []
  for (let i = 2; i + 1 < barEnergy.length; i++) {
    const before = (barEnergy[i - 2] + barEnergy[i - 1]) / 2
    const after = (barEnergy[i] + barEnergy[i + 1]) / 2
    scored.push({ bar: i, rise: after - before })
  }
  scored.sort((x, y) => y.rise - x.rise)
  const picked: number[] = []
  for (const s of scored) {
    if (s.rise <= 0 || picked.length >= count) break
    if (picked.every((p) => Math.abs(p - s.bar) >= 8)) picked.push(s.bar)
  }
  if (picked.length === 0) return [grid.offsetSec]
  return picked.map((bar) => grid.offsetSec + (bar - 2) * barSec)
}

/** The grid whose "1" is beat `beatIndex` (0–3) of the one that was played. */
export function gridWithOneOn(grid: BeatGrid, beatIndex: number): BeatGrid {
  return shiftGrid(grid, (beatIndex * 60) / grid.bpm)
}

/** A fixed spot for a track's vocal clip, away from intro and outro, the same every time. */
export function vocalSpotSec(trackId: string, durationSec: number): number {
  const lo = durationSec * 0.15
  const hi = Math.max(lo, durationSec * 0.85 - VOCAL_CLIP_SEC)
  return lo + ((stableKey(trackId) % 1000) / 1000) * (hi - lo)
}

export type BarAnswer = 0 | 1 | 2 | 3 | 'skip' | 'wrongTempo'
export type VocalAnswer = 'yes' | 'no' | 'unsure'

export interface BarTag {
  schema: number
  contentHash: string
  /** The library row it was sampled as — what the counter matches against the current sample. */
  trackId: string
  name: string
  genre: string
  holdout: boolean
  /** The beat of `shownGrid` Shalom heard as the "1", or why there is no answer. */
  answer: BarAnswer
  /** What the detector said, straight from the analysis — the thing being measured. */
  detectorGrid: BeatGrid | null
  /** The grid the loop was played on: the owner's earlier correction if there was one, else the detector's. */
  shownGrid: BeatGrid
  taggedAt: number
}

export interface VocalTag {
  schema: number
  contentHash: string
  trackId: string
  name: string
  genre: string
  holdout: boolean
  atSec: number
  answer: VocalAnswer
  taggedAt: number
}

/** The file the export dialog writes. Plain JSON, so any later script can read it. */
export function tagsExportText(bar: readonly BarTag[], vocal: readonly VocalTag[], exportedAt: number): string {
  return JSON.stringify({ app: 'DeckMix', kind: 'tags', schema: TAG_SCHEMA, exportedAt, bar, vocal }, null, 2)
}
