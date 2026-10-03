/**
 * v0.9.0 — the owner tags, the app gets measured. Shalom marks which of the
 * four beats is the "1" (and whether a short clip has vocals) on a sample the
 * app picks; those answers are the ground truth v0.9.5's bar detection is
 * measured against. Without them every "the detector got better" is a guess.
 *
 * Pure: which tracks, where in each track to play, and what gets stored.
 */
import { BEATS_PER_BAR, shiftGrid } from '@/core/beatgrid'
import { CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC } from '@/core/sound/vocal-timeline'
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
 * Three clips per song (v0.9.10 spec, 01/10). One 5-second clip per song said
 * nothing about the rest of the track: a song with vocals only at the end
 * would match or miss on a single moment while the strip claims the whole
 * song. 30 songs × 3 = 90 quick answers.
 */
export const VOCAL_CLIPS_PER_SONG = 3
/**
 * Schema 2: `clipIndex` was added. No schema-1 vocal tag was ever exported (0 of 0), so nothing needs migrating.
 * Schema 3 (v0.12.15): optional `pick`. A tag without it is a first-round clip at a fixed spot, i.e. `random`.
 */
export const VOCAL_SCHEMA = 3

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

/** The genres v0.9.5's target is set on (Shalom, 28/09: ≥95% in House/Techno/Trance) — first in the round's order. */
export const FRESH_GENRES = ['House', 'Techno', 'Trance'] as const
/** A song with no genre still goes in the round, under this name — left out, it would be a silent gap. */
export const NO_GENRE = 'ללא ז׳אנר'

/**
 * The fresh round (v0.9.5): every song with no "1" answer yet, by content
 * hash or by the row it was tagged as. The detector was tuned on the 105
 * tagged first; only songs it never saw can say whether that tuning holds.
 * First House/Techno/Trance (Shalom added 19 Trance songs for it, 28/09), then
 * — Shalom, 01/10: "keep giving me the songs I have not checked" — every other
 * genre, then songs with none. Not "outside the bar sample": new songs in a
 * genre that had fewer than `BAR_PER_GENRE` fall *into* that sample, and would
 * be missing from this one. Interleaved by genre, same stable order.
 */
export function pickFreshSample(
  tracks: readonly { id: string; genre?: string; contentHash?: string }[],
  answered: ReadonlySet<string>,
): SampleEntry[] {
  const open = tracks.filter((t) => !answered.has(t.id) && !(t.contentHash && answered.has(t.contentHash)))
  const others = [...new Set(open.map((t) => t.genre).filter((g): g is string => !!g && !(FRESH_GENRES as readonly string[]).includes(g)))].sort()
  const order = [...FRESH_GENRES, ...others, NO_GENRE]
  const groups = order.map(
    (g) =>
      [
        g,
        open
          .filter((t) => (t.genre ?? NO_GENRE) === g)
          .map((t) => t.id)
          .sort((a, b) => stableKey(a) - stableKey(b) || a.localeCompare(b)),
      ] as const,
  )
  const out: SampleEntry[] = []
  // Dance first, whole: the target was set there, and a half-done round should
  // have measured those before the rest.
  for (const dance of [true, false]) {
    const part = groups.filter(([g]) => (FRESH_GENRES as readonly string[]).includes(g) === dance)
    const most = Math.max(0, ...part.map(([, ids]) => ids.length))
    for (let i = 0; i < most; i++) {
      for (const [genre, ids] of part) if (i < ids.length) out.push({ trackId: ids[i], genre, holdout: true })
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
 * The second vocal round (v0.12.15, Shalom 01/10: first ~100 more songs, then raised to 300 for accuracy). Songs from
 * position 12 on in each genre's stable order: 0–5 are the sealed bar test,
 * 6–7 the sealed vocal test, 8–11 the first round's other songs — so nothing
 * here can touch a sealed song, and nothing repeats. Never `holdout`: these
 * answers are for training; the final measure stays on the sealed 30 clips.
 */
export const VOCAL2_TOTAL = 300
export function pickVocalRound2Sample(tracks: readonly { id: string; genre?: string }[]): SampleEntry[] {
  const from = HOLDOUT_PER_GENRE + VOCAL_PER_GENRE
  const groups = genreGroups(tracks).map(([g, ids]) => [g, ids.slice(from)] as const)
  const out: SampleEntry[] = []
  // Round-robin by genre until `VOCAL2_TOTAL`: a small genre (the dance ones, where the detector is weakest) is taken whole
  // and early, the big ones fill the rest, and stopping at any point still leaves every genre represented.
  const rounds = Math.max(0, ...groups.map(([, ids]) => ids.length))
  for (let i = 0; i < rounds && out.length < VOCAL2_TOTAL; i++) {
    for (const [genre, ids] of groups) if (i < ids.length && out.length < VOCAL2_TOTAL) out.push({ trackId: ids[i], genre, holdout: false })
  }
  return out
}

/** How a clip was chosen — stored with its answer, because "suspect" clips are enriched in vocals and must never be read as a fair sample. */
export type VocalPick = 'suspect' | 'random'

/**
 * Up to `count` clip starts where the current detector thinks there is singing:
 * the 5-second windows with the most vocal cells (an unsure cell counts half),
 * inside the middle 70% of the song, none overlapping another or an `avoid`
 * start. A window with no vocal or unsure cell at all is not a suspect, so
 * fewer than `count` may come back — the caller says so and falls back.
 */
export function suspectClipSpots(cells: ArrayLike<number>, durationSec: number, count: number, avoid: readonly number[] = []): number[] {
  const win = Math.round(VOCAL_CLIP_SEC / VOCAL_CELL_SEC)
  const firstCell = Math.ceil((durationSec * 0.15) / VOCAL_CELL_SEC)
  const lastCell = Math.floor((durationSec * 0.85) / VOCAL_CELL_SEC) - win
  const scored: { cell: number; score: number }[] = []
  for (let c = firstCell; c <= lastCell && c + win <= cells.length; c++) {
    let score = 0
    for (let i = c; i < c + win; i++) score += cells[i] === CELL_VOCAL ? 2 : cells[i] === CELL_UNSURE ? 1 : 0
    if (score > 0) scored.push({ cell: c, score })
  }
  scored.sort((a, b) => b.score - a.score || a.cell - b.cell)
  const out: number[] = []
  for (const { cell } of scored) {
    if (out.length >= count) break
    const at = cell * VOCAL_CELL_SEC
    if ([...out, ...avoid].some((o) => Math.abs(o - at) < VOCAL_CLIP_SEC)) continue
    out.push(at)
  }
  return out
}

/**
 * The three clips of a second-round song: about half suspect, half random —
 * one song gets two suspects, the next one, alternating by a stable key so the
 * mix is the same every open. A suspect slot the detector cannot fill (no
 * timeline, nothing singing-like) becomes the random spot and is recorded as
 * `random`: the label says how the clip was really chosen.
 */
export function vocalRound2Clips(trackId: string, durationSec: number, cells: ArrayLike<number> | null): { atSec: number[]; pick: VocalPick[] } {
  const random = vocalSpotsSec(trackId, durationSec)
  const wanted: VocalPick[] = stableKey(`pick:${trackId}`) % 2 ? ['suspect', 'suspect', 'random'] : ['suspect', 'random', 'random']
  const randomSlots = wanted.flatMap((w, i) => (w === 'random' ? [random[i]] : []))
  const suspects = cells ? suspectClipSpots(cells, durationSec, wanted.filter((w) => w === 'suspect').length, randomSlots) : []
  let next = 0
  const atSec: number[] = []
  const pick: VocalPick[] = []
  wanted.forEach((w, i) => {
    if (w === 'suspect' && next < suspects.length) {
      atSec.push(suspects[next++])
      pick.push('suspect')
    } else {
      atSec.push(random[i])
      pick.push('random')
    }
  })
  return { atSec, pick }
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

/**
 * Where the three vocal clips of a track start: one in each third of the
 * middle 70% of the song (away from intro and outro), at a fixed place the
 * same every time. Each clip stays inside its own third, so the three never
 * overlap on a normal-length song.
 */
export function vocalSpotsSec(trackId: string, durationSec: number): number[] {
  const lo = durationSec * 0.15
  const seg = (durationSec * 0.7) / VOCAL_CLIPS_PER_SONG
  const room = Math.max(0, seg - VOCAL_CLIP_SEC)
  return Array.from({ length: VOCAL_CLIPS_PER_SONG }, (_, i) => lo + i * seg + ((stableKey(`${trackId}:${i}`) % 1000) / 1000) * room)
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
  /** Which of the song's `VOCAL_CLIPS_PER_SONG` clips this answer is for (0-based). */
  clipIndex: number
  atSec: number
  /** How the clip was chosen; absent = the first round's fixed spots (`random`). Suspect clips are biased — training only, never the final measure. */
  pick?: VocalPick
  answer: VocalAnswer
  taggedAt: number
}

/**
 * The blind re-check (v0.9.11): clips the owner already answered, asked again with nothing shown, to find labels that were
 * hard calls. Its own record kind and storage prefix — the new answer sits beside the old one, never over it; the two are
 * compared, and the sealed final test is never re-asked (an answer changed there would be tuning on the test).
 */
export const VOCAL_REVIEW_SCHEMA = 1
/** The genres the classifier is weakest on (66–76% against a 63–64% guess, n=38/55 — 03/10): all their clips are re-asked first. */
export const REVIEW_DANCE_GENRES = ['House', 'Techno'] as const
/** A few clips from the rest, for the owner's own consistency — the ceiling no classifier can beat. Trance is left out: "no vocals" is a rule there, not a judgement. */
export const REVIEW_CONSISTENCY_CLIPS = 20

export type ReviewGroup = 'dance' | 'consistency'

export interface ReviewClip {
  trackId: string
  genre: string
  contentHash: string
  /** The clip's number in the first pass — the key of the stored answer, so the two passes line up. */
  clipIndex: number
  atSec: number
  previousAnswer: VocalAnswer
  group: ReviewGroup
}

export interface VocalReviewTag {
  schema: number
  contentHash: string
  trackId: string
  name: string
  genre: string
  clipIndex: number
  atSec: number
  group: ReviewGroup
  /** What the owner said the first time. Recorded here so the comparison survives even if the first record is later edited. */
  previousAnswer: VocalAnswer
  answer: VocalAnswer
  taggedAt: number
}

export interface ReviewPlan {
  /** One entry per song, the dance genres first, so a song is decoded once for all its clips. Never `holdout`: sealed songs are not in here. */
  entries: SampleEntry[]
  clipsByTrack: Map<string, ReviewClip[]>
  /** Clips left out because their song is no longer in the library — named on screen, not dropped. */
  missing: number
}

export function pickVocalReview(tags: readonly VocalTag[], libraryIds: ReadonlySet<string>): ReviewPlan {
  const dance: ReviewClip[] = []
  const rest: ReviewClip[] = []
  let missing = 0
  for (const t of tags) {
    if (t.holdout) continue // sealed: never asked again
    const isDance = (REVIEW_DANCE_GENRES as readonly string[]).includes(t.genre)
    if (!isDance && t.genre === 'Trance') continue
    const clip: ReviewClip = {
      trackId: t.trackId,
      genre: t.genre,
      contentHash: t.contentHash,
      clipIndex: t.clipIndex ?? 0,
      atSec: t.atSec,
      previousAnswer: t.answer,
      group: isDance ? 'dance' : 'consistency',
    }
    ;(isDance ? dance : rest).push(clip)
  }
  const byKey = (a: ReviewClip, b: ReviewClip) =>
    stableKey(`${a.contentHash}:${a.clipIndex}`) - stableKey(`${b.contentHash}:${b.clipIndex}`) || `${a.trackId}${a.clipIndex}`.localeCompare(`${b.trackId}${b.clipIndex}`)
  const chosen = [...dance.sort(byKey), ...rest.sort(byKey).slice(0, REVIEW_CONSISTENCY_CLIPS)]
  const clipsByTrack = new Map<string, ReviewClip[]>()
  const order: string[] = []
  for (const c of chosen) {
    if (!libraryIds.has(c.trackId)) {
      missing++
      continue
    }
    if (!clipsByTrack.has(c.trackId)) {
      clipsByTrack.set(c.trackId, [])
      order.push(c.trackId)
    }
    clipsByTrack.get(c.trackId)!.push(c)
  }
  for (const list of clipsByTrack.values()) list.sort((a, b) => a.clipIndex - b.clipIndex)
  const entries = order.map((trackId) => ({ trackId, genre: clipsByTrack.get(trackId)![0].genre, holdout: false }))
  return { entries, clipsByTrack, missing }
}

/** Keys (content hash and library path) of the songs whose every planned clip has a re-check answer. */
export function reviewSongsDone(plan: ReviewPlan, answered: readonly { contentHash: string; clipIndex: number }[]): Set<string> {
  const have = new Set(answered.map((t) => `${t.contentHash}:${t.clipIndex}`))
  const done = new Set<string>()
  for (const [trackId, clips] of plan.clipsByTrack) {
    if (clips.every((c) => have.has(`${c.contentHash}:${c.clipIndex}`))) {
      done.add(trackId)
      done.add(clips[0].contentHash)
    }
  }
  return done
}

/** How many re-check answers differ from the first pass, per group — shown only after the list is finished, so no single clip is read against its old answer. */
export function reviewSummary(tags: readonly VocalReviewTag[]): Record<ReviewGroup, { answered: number; differ: number; unsure: number }> {
  const out = { dance: { answered: 0, differ: 0, unsure: 0 }, consistency: { answered: 0, differ: 0, unsure: 0 } }
  for (const t of tags) {
    out[t.group].answered++
    if (t.answer !== t.previousAnswer) out[t.group].differ++
    if (t.answer === 'unsure') out[t.group].unsure++
  }
  return out
}

/** Clips already answered for a song, by content hash — a record with no `clipIndex` counts as clip 0. */
export function vocalClipsAnswered(tags: readonly { contentHash: string; clipIndex?: number }[], contentHash: string): Set<number> {
  const out = new Set<number>()
  for (const t of tags) if (t.contentHash === contentHash) out.add(t.clipIndex ?? 0)
  return out
}

/** The first clip of a song with no answer yet, or `VOCAL_CLIPS_PER_SONG` when all are answered. */
export function firstUnansweredClip(answered: ReadonlySet<number>): number {
  for (let i = 0; i < VOCAL_CLIPS_PER_SONG; i++) if (!answered.has(i)) return i
  return VOCAL_CLIPS_PER_SONG
}

/** Keys (content hash and library path) of the songs whose every clip is answered — what the screen counts as done. */
export function vocalSongsDone(tags: readonly { contentHash: string; trackId: string; clipIndex?: number }[]): Set<string> {
  const byHash = new Map<string, { trackId: string; clips: Set<number> }>()
  for (const t of tags) {
    const e = byHash.get(t.contentHash) ?? { trackId: t.trackId, clips: new Set<number>() }
    e.clips.add(t.clipIndex ?? 0)
    byHash.set(t.contentHash, e)
  }
  const done = new Set<string>()
  for (const [hash, e] of byHash) if (firstUnansweredClip(e.clips) === VOCAL_CLIPS_PER_SONG) done.add(hash).add(e.trackId)
  return done
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
  vocalReview: readonly VocalReviewTag[] = [],
): string {
  // `bar` keeps its name and shape, so a v0.9.0 script finds its list — as long as it does not insist on schema 1.
  return JSON.stringify({ app: 'DeckMix', kind: 'tags', schema: MARK_SCHEMA, exportedAt, mark, bar, decide, fresh, vocal, vocalReview }, null, 2)
}
