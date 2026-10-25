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
  /** Which guess `hint` is: absent = the first rule (failed 25/10, 6 of 44), 2 = the phrase-line rule (`structureHintV2`). */
  hintVersion?: 2
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
  const open = tracks.filter(
    (t) => t.contentHash != null && ownerChecked.has(t.contentHash) && !marked.has(t.contentHash) && inStructureGenre(t.genre),
  )
  // Techno and Mizrahi first (25/10): the first round, in library order, was all House, so the second rule is tested on genres the
  // first round never saw instead of on more of the songs it was shaped from.
  const fresh = open.filter((t) => !/house/i.test(t.genre ?? ''))
  return [...fresh, ...open.filter((t) => /house/i.test(t.genre ?? ''))]
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

/** Bars where an intro may end, counted from the first bar line: 18 of his 21 intro marks (25/10) sat on 8, 16 or 24. */
const INTRO_LINES = [8, 16, 24, 32]
/** A change smaller than this (louder after / before, or the reverse for an outro) is not one; the guess says "none" instead. */
const MIN_CHANGE = 1.15
/** Bars compared on each side of a candidate line. */
const SIDE_BARS = 4

/**
 * The second guess (25/10), shaped by what the first one got wrong on his 22 House songs:
 * - the first watched the bass, so it put the intro where the bass comes in (often bar 8) while his intro ends at the drop (often 16);
 *   and his outro starts while the bass still runs (the beat stays for mixing). So this one watches mid + high, where the vocals,
 *   leads and drop live, not the low band.
 * - his marks sit on phrase lines, so only phrase lines are candidates: intro end on bar 8/16/24/32, outro start on a line 8 bars apart
 *   4 bars apart (only 9 of his 22 outro marks sat on an 8-bar line, 17 on a 4-bar one), in the last 45% of the song and at least 8 bars
 *   before its end.
 * Each side takes the line with the biggest change across it, or null below MIN_CHANGE.
 */
export function structureHintV2(bands: Float32Array, durationSec: number, grid: BeatGrid): { introEndSec: number | null; outroStartSec: number | null } {
  const none = { introEndSec: null, outroStartSec: null }
  const buckets = Math.floor(bands.length / 3)
  const bar = barSecOf(grid)
  if (buckets === 0 || durationSec <= 0 || !(bar > 0)) return none
  const secPerBucket = durationSec / buckets
  const starts: number[] = []
  const levels: number[] = []
  for (let s = grid.offsetSec; s + bar <= durationSec; s += bar) {
    const a = Math.floor(s / secPerBucket)
    const b = Math.min(buckets, Math.floor((s + bar) / secPerBucket))
    let sum = 0
    for (let i = a; i < b; i++) sum += bands[i * 3 + 1] + bands[i * 3 + 2]
    starts.push(s)
    levels.push(b > a ? sum / (b - a) : 0)
  }
  const n = levels.length
  const mean = (from: number, to: number) => {
    let sum = 0
    for (let k = from; k < to; k++) sum += levels[k]
    return sum / Math.max(1, to - from)
  }
  /** How much louder after the line than before it (> 1 = rise). */
  const ratio = (line: number) => {
    const before = mean(line - SIDE_BARS, line)
    const after = mean(line, line + SIDE_BARS)
    return before > 0 ? after / before : after > 0 ? Infinity : 1
  }
  let intro: number | null = null
  let best = MIN_CHANGE
  for (const line of INTRO_LINES) {
    if (line + SIDE_BARS > n) break
    const r = ratio(line)
    if (r >= best) {
      best = r
      intro = line
    }
  }
  let outro: number | null = null
  let fall = MIN_CHANGE
  for (let line = (intro ?? 0) + 4; line + 8 <= n; line += 4) {
    if (starts[line] < durationSec * 0.55) continue
    const r = ratio(line)
    const f = r > 0 ? 1 / r : Infinity
    if (f >= fall) {
      fall = f
      outro = line
    }
  }
  return { introEndSec: intro == null ? null : starts[intro], outroStartSec: outro == null ? null : starts[outro] }
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

/** The marks made under the current guess: only these decide the second round, the first round's marks carry the old guess. */
export function currentRoundMarks(marks: readonly StructureMark[]): StructureMark[] {
  return marks.filter((m) => m.hintVersion === 2)
}

export function structureMarksExportText(marks: readonly StructureMark[], now: number): string {
  const first = marks.filter((m) => m.hintVersion == null)
  return JSON.stringify(
    { app: 'DeckMix', kind: 'structure-marks', schema: 1, exportedAt: now, score: scoreStructure(currentRoundMarks(marks)), firstRoundScore: scoreStructure(first), marks },
    null,
    2,
  )
}
