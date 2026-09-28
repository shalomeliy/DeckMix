/**
 * v0.9.0 — the owner tags, the app gets measured. Shalom marks which of the
 * four beats is the "1" (and whether a short clip has vocals) on a sample the
 * app picks; those answers are the ground truth v0.9.5's bar detection is
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

/**
 * v0.9.1's marker tags. Schema 2, a separate kind from v0.9.0's `BarTag`:
 * Shalom re-tags every song on the waveform (26/09), and the 4-button answers
 * are kept beside the new ones to compare — the two agreeing is the only
 * measure of his own consistency we have.
 */
export const MARK_SCHEMA = 2
/** How far the waveform shows at once, centred on the marker. */
export const VIEW_BARS = 8
/** "Play from here" starts this many bars before the marker, so the "1" is heard arriving, not starting. */
export const PLAY_LEAD_BARS = 2
/** …and plays this long in all: two of lead-in and six after the marker. */
export const PLAY_BARS = 8
/** Shift + arrow: for a beat line that is itself off the hit. ~1/50 of a beat at 120 BPM. */
export const FINE_STEP_SEC = 0.01

export interface SampleEntry {
  trackId: string
  genre: string
  holdout: boolean
  /** Tie-break only (v0.12.8): the two answers differ in tempo, not just in which beat is the "1" — said on screen. */
  tempoDiffers?: boolean
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

/** The genres v0.9.5's target is set on (Shalom, 28/09: ≥95% in House/Techno/Trance). */
export const FRESH_GENRES = ['House', 'Techno', 'Trance'] as const

/**
 * The fresh round (v0.9.5): every House/Techno/Trance song with no "1" answer
 * yet, by content hash or by the row it was tagged as. The detector was tuned
 * on the 105 already tagged; only songs it never saw can say whether that
 * tuning holds (Shalom asked, 28/09, and added 19 Trance songs for it — the
 * first round had only 9). Not "outside the bar sample": new songs in a genre
 * that had fewer than `BAR_PER_GENRE` fall *into* that sample, and would be
 * missing from this one. Interleaved by genre, same stable order.
 */
export function pickFreshSample(
  tracks: readonly { id: string; genre?: string; contentHash?: string }[],
  answered: ReadonlySet<string>,
): SampleEntry[] {
  const groups = FRESH_GENRES.map(
    (g) =>
      [
        g,
        tracks
          .filter((t) => t.genre === g && !answered.has(t.id) && !(t.contentHash && answered.has(t.contentHash)))
          .map((t) => t.id)
          .sort((a, b) => stableKey(a) - stableKey(b) || a.localeCompare(b)),
      ] as const,
  )
  const out: SampleEntry[] = []
  const most = Math.max(0, ...groups.map(([, ids]) => ids.length))
  for (let i = 0; i < most; i++) {
    for (const [genre, ids] of groups) if (i < ids.length) out.push({ trackId: ids[i], genre, holdout: true })
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

/** The beat of `grid` nearest `sec` — the magnet the marker snaps to. */
export function snapToBeat(sec: number, grid: BeatGrid): number {
  const beatSec = 60 / grid.bpm
  return grid.offsetSec + Math.round((sec - grid.offsetSec) / beatSec) * beatSec
}

/**
 * The grid the marker starts on: "the computer's place" (Shalom, 26/09), so
 * the detector's own. The owner's earlier correction is used only when it
 * changed the tempo — then the detector's beats are not the song's beats at
 * all. A phase-only correction is ignored on purpose: three of v0.9.0's first
 * four answers moved the bar line to a wrong place, and starting on them
 * would carry the mistake into the re-tag.
 */
export function startGrid(detector: BeatGrid | null, shown: BeatGrid | null): BeatGrid | null {
  if (detector && (!shown || Math.abs(detector.bpm - shown.bpm) < 0.05)) return detector
  return shown
}

/** Where the marker starts for a drop spot: the bar line the jump in energy lands on (`dropSpots` returns two bars before it). */
export function startMarkSec(spotSec: number, grid: BeatGrid): number {
  return snapToBeat(spotSec + (2 * BEATS_PER_BAR * 60) / grid.bpm, grid)
}

/** Which beat (0–3) of `grid`'s bar `markSec` falls nearest, and how far off that beat it is — how an answer is scored against a detector. */
export function markBeatOf(markSec: number, grid: BeatGrid): { beat: number; errSec: number } {
  const beatSec = 60 / grid.bpm
  const n = Math.round((markSec - grid.offsetSec) / beatSec)
  return { beat: ((n % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR, errSec: markSec - (grid.offsetSec + n * beatSec) }
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

export type MarkAnswer = 'marked' | 'skip' | 'wrongTempo'

export interface MarkTag {
  schema: number
  contentHash: string
  trackId: string
  name: string
  genre: string
  holdout: boolean
  answer: MarkAnswer
  /** Where Shalom put the "1", in seconds from the start of the track. `null` unless `answer` is 'marked'. */
  markSec: number | null
  bpm: number | null
  /** Where the marker was when the song opened — the computer's guess. */
  startMarkSec: number | null
  /**
   * Whether he moved it at all. With the marker starting on the computer's
   * guess, "right" and "never looked" read the same; this and `answerMs` are
   * what tell them apart afterwards.
   */
  moved: boolean
  /** From the song appearing to the answer. v0.9.0 had 15 answers under 5 s and no way to know if he heard the drop. */
  answerMs: number
  /** Presses of "play from here" before answering. */
  plays: number
  detectorGrid: BeatGrid | null
  /** The grid the marker started on (`startGrid`). */
  shownGrid: BeatGrid | null
  /** The owner's earlier phase correction this answer replaced, if `startGrid` passed over one — kept so it is not lost unseen. */
  replacedCorrection: BeatGrid | null
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

/**
 * The songs whose two answers disagree (v0.12.8): the "1" marked on the
 * waveform (v0.9.1) is not the one picked with v0.9.0's four buttons. On
 * 28/09 that was 26 of 103 — and for 11 of them the waveform answer was the
 * computer's line left where it started, so which answer is right cannot be
 * read off the data. A blind third look settles it. A tempo that differs
 * between the two counts as a disagreement too; a skipped old answer does not
 * (there is nothing to disagree with).
 */
export function disputedSongs(bar: readonly BarTag[], mark: readonly MarkTag[]): SampleEntry[] {
  const old = new Map(bar.map((b) => [b.contentHash, b]))
  const out: SampleEntry[] = []
  for (const m of mark) {
    const o = old.get(m.contentHash)
    if (!o || typeof o.answer !== 'number' || m.answer !== 'marked' || m.markSec == null || m.bpm == null) continue
    const oldGrid = gridWithOneOn(o.shownGrid, o.answer)
    const dBpm = Math.abs(oldGrid.bpm - m.bpm)
    const tempoDiffers = dBpm >= 0.05
    // A tempo a hair apart drifts the old grid by markSec·Δbpm/bpm by the time
    // it reaches the mark — 0.12 s at 300 s (v0.12.8 review). That drift is
    // the same answer measured on two grids, not a disagreement.
    const tolerance = DISPUTE_TOLERANCE_SEC + (m.markSec * dBpm) / m.bpm
    const { beat, errSec } = markBeatOf(m.markSec, oldGrid)
    const same = !tempoDiffers && beat === 0 && Math.abs(errSec) < tolerance
    if (!same) out.push({ trackId: m.trackId, genre: m.genre, holdout: m.holdout, ...(tempoDiffers ? { tempoDiffers } : {}) })
  }
  return out.sort((x, y) => (x.trackId < y.trackId ? -1 : x.trackId > y.trackId ? 1 : 0))
}

/**
 * Where the blind tie-break centres its view and starts playing, in beats
 * from the computer's "1" at the drop: 0–3, fixed per song. Centred on the
 * computer's "1" itself, the window and the first click of the lead-in would
 * point at it — the very pull the tie-break exists to measure (v0.12.8
 * review). Spread evenly over the four beats, the centre says nothing.
 */
export function blindOffsetBeats(trackId: string): number {
  // Salted: the unsalted key already orders the sample, and the offset should not follow that order.
  return stableKey(`blind:${trackId}`) % BEATS_PER_BAR
}

/** `sec` moved the song's fixed 0–3 blind beats (`blindOffsetBeats`), kept inside the song by whole beats. */
export function neutralSec(sec: number, trackId: string, bpm: number, durationSec: number): number {
  const beatSec = 60 / bpm
  let t = sec + blindOffsetBeats(trackId) * beatSec
  while (t > durationSec) t -= beatSec
  return t
}

/** Two "1"s closer than this are the same answer — a beat at 180 BPM is 333 ms, so it can never merge two beats. */
export const DISPUTE_TOLERANCE_SEC = 0.05

/** The file the export dialog writes. Plain JSON, so any later script can read it. */
export function tagsExportText(
  bar: readonly BarTag[],
  mark: readonly MarkTag[],
  vocal: readonly VocalTag[],
  exportedAt: number,
  decide: readonly MarkTag[] = [],
  fresh: readonly MarkTag[] = [],
): string {
  // `bar` keeps its name and shape, so a v0.9.0 script finds its list — as long as it does not insist on schema 1.
  return JSON.stringify({ app: 'DeckMix', kind: 'tags', schema: MARK_SCHEMA, exportedAt, mark, bar, decide, fresh, vocal }, null, 2)
}
