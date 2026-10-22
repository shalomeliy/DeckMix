/**
 * v0.9.40 experiment: the owner marks where a song's intro ends and its outro starts, song after song, and the computer's own guess is
 * kept next to each mark so the two can be compared later. Pure: the queue itself lives in `controls.ts`.
 *
 * Stage 0 (22/10, `research/song-structure-v0.9.40/` in the project files) found that his vocal marks do not say where an intro ends
 * (singing starts in bar 0 or long after the drop: 13% agreement) and that a bass-energy rule finds a clear intro in about half the
 * songs. So the guess is recorded but NOT shown while he marks: a visible guess would pull his press towards it, and the comparison
 * would then measure the guess against itself.
 */
import { BEATS_PER_BAR } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

export interface StructureMark {
  schema: 1
  contentHash: string
  trackId: string
  name: string
  genre?: string
  /** Bar line where the full beat starts. null = he said the song has no intro (full beat from the start). */
  introEndSec: number | null
  /** Bar line where the full beat ends and the song thins out for the end. null = he said it has no outro. */
  outroStartSec: number | null
  /** The computer's guess at the moment he marked, same meaning; null = it found none. */
  hint: { introEndSec: number | null; outroStartSec: number | null }
  /** The bar length the marks were snapped with, so a later comparison can speak in bars without the grid. */
  barSec: number
  updatedAt: number
}

/**
 * Only the genres he asked for (22/10: "take Hip Hop and Trance out"). An intro/outro is a dance-music shape; a song with no genre is
 * left out too, because nothing says it belongs to the three.
 */
const STRUCTURE_GENRES = /techno|house|mizrahi|מזרחי/i

/** "Hip House" or "Trance House" would match the three by name; his exclusion of Hip Hop and Trance wins. */
const EXCLUDED_GENRES = /\bhip\b|hip.?hop|\brap\b|trance|היפ|טראנס/i

export function inStructureGenre(genre: string | undefined): boolean {
  return genre != null && STRUCTURE_GENRES.test(genre) && !EXCLUDED_GENRES.test(genre)
}

export interface StructureQueueTrack {
  id: string
  contentHash?: string
  genre?: string
}

/**
 * The songs to mark: one of the three genres, a "1" he already checked (the marks snap to his bar lines, and a wrong "1" would put
 * every mark a beat off), and not marked yet. Library order.
 */
export function structureQueueOrder<T extends StructureQueueTrack>(tracks: readonly T[], ownerChecked: ReadonlySet<string>, marked: ReadonlySet<string>): T[] {
  return tracks.filter(
    (t) => t.contentHash != null && ownerChecked.has(t.contentHash) && !marked.has(t.contentHash) && inStructureGenre(t.genre),
  )
}

/** How many marked songs the comparison needs (the pass rule below). */
export const STRUCTURE_TARGET = 20

export function barSecOf(grid: BeatGrid): number {
  return (60 / grid.bpm) * BEATS_PER_BAR
}

/**
 * A press lands on the bar line nearest to it. Intros and outros change on a bar line, and a press comes 100-200 ms after what was
 * heard: half a bar is ~1 s at dance tempos, far more than that delay, so the nearest line is the one he meant.
 */
export function snapToBar(sec: number, grid: BeatGrid): number {
  const bar = barSecOf(grid)
  return Math.max(0, grid.offsetSec + Math.round((sec - grid.offsetSec) / bar) * bar)
}

/** A bar's bass is "full" at this share of the song's loud level (90th percentile of bars). Same rule stage 0 measured. */
const FULL_SHARE = 0.6
/** The full stretch must hold this many bars, so one kick hit in the intro does not count as the drop. */
const FULL_BARS = 4

/**
 * The computer's guess, from the low band of `bands` (interleaved low/mid/high per bucket, `platform/analyzer-js/analyze.ts`):
 * intro end = the first bar that opens FULL_BARS bars of full bass, with every bar before it below that; outro start = the same from
 * the end. null when the song has no such quiet stretch (full from the first bar, or to the last).
 */
export function structureHint(bands: Float32Array, durationSec: number, grid: BeatGrid): { introEndSec: number | null; outroStartSec: number | null } {
  const buckets = Math.floor(bands.length / 3)
  const bar = barSecOf(grid)
  if (buckets === 0 || durationSec <= 0 || !(bar > 0)) return { introEndSec: null, outroStartSec: null }
  const secPerBucket = durationSec / buckets
  const starts: number[] = []
  const levels: number[] = []
  for (let s = grid.offsetSec; s + bar <= durationSec; s += bar) {
    const a = Math.floor(s / secPerBucket)
    const b = Math.min(buckets, Math.floor((s + bar) / secPerBucket))
    let sum = 0
    for (let i = a; i < b; i++) sum += bands[i * 3]
    starts.push(s)
    levels.push(b > a ? sum / (b - a) : 0)
  }
  const n = levels.length
  if (n < FULL_BARS * 3) return { introEndSec: null, outroStartSec: null }
  const loud = [...levels].sort((x, y) => x - y)[Math.floor(n * 0.9)]
  if (!(loud > 0)) return { introEndSec: null, outroStartSec: null }
  const limit = loud * FULL_SHARE
  // The first bar itself must be full too: a 4-bar average alone fires one bar early (one quiet bar plus three full ones clears it),
  // which is the off-by-one that put stage 0's intros at 15/17/31 bars instead of 16/32.
  const fullFrom = (i: number) => {
    if (levels[i] < limit) return false
    let sum = 0
    for (let k = i; k < i + FULL_BARS; k++) sum += levels[k]
    return sum / FULL_BARS >= limit
  }
  let intro: number | null = null
  for (let i = 0; i + FULL_BARS <= n; i++) {
    if (!fullFrom(i)) continue
    if (i >= 2 && levels.slice(0, i).every((v) => v < limit)) intro = starts[i]
    break
  }
  let outro: number | null = null
  for (let i = n; i - FULL_BARS >= 0; i--) {
    if (!fullFrom(i - FULL_BARS) || levels[i - 1] < limit) continue
    if (i <= n - 2 && levels.slice(i).every((v) => v < limit)) outro = starts[i]
    break
  }
  return { introEndSec: intro, outroStartSec: outro }
}

export interface StructureScore {
  /** Songs with a mark on that side (an answer of "no intro" counts: the guess can be right or wrong about it too). */
  answered: number
  /** The guess within one bar of his mark, or both saying "none". */
  hit: number
}

/** The pass rule set on 22/10: the guess is right on 70% of what he marked, intro and outro together. */
export const STRUCTURE_PASS_SHARE = 0.7

export function scoreStructure(marks: readonly StructureMark[]): { intro: StructureScore; outro: StructureScore; passed: boolean | null } {
  const side = (pick: (m: StructureMark) => [number | null, number | null]): StructureScore => {
    let hit = 0
    for (const m of marks) {
      const [own, guess] = pick(m)
      if (own == null ? guess == null : guess != null && Math.abs(own - guess) <= m.barSec * 1.01) hit++
    }
    return { answered: marks.length, hit }
  }
  const intro = side((m) => [m.introEndSec, m.hint.introEndSec])
  const outro = side((m) => [m.outroStartSec, m.hint.outroStartSec])
  const total = intro.answered + outro.answered
  return { intro, outro, passed: marks.length < STRUCTURE_TARGET ? null : (intro.hit + outro.hit) / total >= STRUCTURE_PASS_SHARE }
}

export function structureMarksExportText(marks: readonly StructureMark[], now: number): string {
  return JSON.stringify({ app: 'DeckMix', kind: 'structure-marks', schema: 1, exportedAt: now, score: scoreStructure(marks), marks }, null, 2)
}
