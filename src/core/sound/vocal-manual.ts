/**
 * The owner's own vocal marks (v0.9.10b, 03/10): he presses "vocal started" and "vocal ended" while the song plays, as many times as the song needs.
 * His ears beat the model, so his marks win — but only in the way he chose: what he did NOT colour stays empty once he says the song is finished,
 * and until then his marks are drawn over the model's guess. Pure: no storage, no clock.
 *
 * `regions` is the list in the order he made them, NOT a merged set, so "undo last" undoes what he last did even when it overlapped an older mark.
 * Overlaps are merged only when a timeline is built.
 */
import { BEATS_PER_BAR, nextBarLineSec } from '@/core/beatgrid'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'
import type { BeatGrid } from '@/core/types'

export interface VocalRegion {
  fromSec: number
  toSec: number
  /**
   * `voice` (the default, and what every mark saved before 03/10 is) paints the stretch as "there is a voice"; `none` paints it as "there is NO voice" —
   * the owner's black (03/10: "it paints purple but cannot paint black"), for the places where the computer's guess says voice and he knows it is not.
   * Marks are applied in the order he made them, the later one on top.
   */
  kind?: 'voice' | 'none'
}

export interface VocalManualTag {
  schema: 1
  contentHash: string
  trackId: string
  name: string
  genre?: string
  regions: VocalRegion[]
  /** True once he said "I finished marking this song": from then on, everything outside the regions is "no voice". */
  finished: boolean
  /**
   * "Teach the computer from this song" (the owner's button, 03/10): the song is a lesson — his marks are the truth here, the computer's own guess for it
   * is forgotten, and the training scripts take ONLY taught songs. Only a finished song can be taught.
   */
  taught?: boolean
  taughtAt?: number
  updatedAt: number
}

/** Shorter than this is a mis-click, not a vocal: refused with a message, never stored. */
export const MIN_REGION_SEC = 0.5

export type AddRegionResult = { ok: true; regions: VocalRegion[] } | { ok: false; reason: 'too-short' | 'bad-time' }

/** Appends a mark. The two times can come in either order (he may have seeked back before pressing "ended"); they are clamped to the song. */
export function addRegion(regions: readonly VocalRegion[], aSec: number, bSec: number, durationSec: number, kind: 'voice' | 'none' = 'voice'): AddRegionResult {
  if (![aSec, bSec, durationSec].every(Number.isFinite) || durationSec <= 0) return { ok: false, reason: 'bad-time' }
  const from = Math.max(0, Math.min(aSec, bSec))
  const to = Math.min(durationSec, Math.max(aSec, bSec))
  if (to - from < MIN_REGION_SEC) return { ok: false, reason: 'too-short' }
  return { ok: true, regions: [...regions, kind === 'voice' ? { fromSec: from, toSec: to } : { fromSec: from, toSec: to, kind }] }
}

export function removeLastRegion(regions: readonly VocalRegion[]): VocalRegion[] {
  return regions.slice(0, -1)
}

/**
 * Undo of the last "ended" press: the mark goes back to being OPEN, at the press that started it, so a wrong "ended" is fixed by pressing "ended"
 * again at the right moment — not by marking the whole stretch from scratch. (Cancelling the open mark is the second step, for a wrong "started".)
 * Without a grid the start press is recovered from the stored mark by taking the lead back off; a mark that was clamped at the start of the song gives a press
 * a little later than the real one, which only matters to the draft until he presses "ended".
 */
export function undoLastEnd(
  regions: readonly VocalRegion[],
  grid: BeatGrid | null = null,
): { regions: VocalRegion[]; reopenStartPressSec: number | null; reopenKind: 'voice' | 'none' } {
  const last = regions[regions.length - 1]
  if (!last) return { regions: [], reopenStartPressSec: null, reopenKind: 'voice' }
  // On a grid a mark made since 04/10 starts ON a yellow line, and a press on a line snaps to that same line, so the start itself is the press to
  // reopen at. A mark that is not on a line was made with the old half-second lead (or on another grid): take the lead back off, as before.
  const onLine = usableGrid(grid) && Math.abs(barLineAtOrBeforeSec(last.fromSec + 1e-6, grid) - last.fromSec) < 1e-6
  const reopen = onLine ? last.fromSec : last.fromSec + MARK_LEAD_SEC
  return { regions: regions.slice(0, -1), reopenStartPressSec: reopen, reopenKind: last.kind === 'none' ? 'none' : 'voice' }
}

/**
 * What the strip draws and the countdown reads.
 *  - finished: his marks are voice, everything else is none — the model is not consulted;
 *  - not finished: the model's guess with his marks (and the one still open, up to `openToSec`) laid over it as voice;
 *  - not finished and no model strip: his marks as voice and everything else "unsure", never "none" — he has not said the rest is empty.
 */
export function effectiveTimeline(
  base: VocalTimeline | null,
  tag: Pick<VocalManualTag, 'regions' | 'finished'> | undefined,
  durationSec: number,
  open?: { fromSec: number; toSec: number; kind?: 'voice' | 'none' } | null,
): VocalTimeline | null {
  if (!tag && !open) return base
  const n = Math.max(0, Math.floor(durationSec / VOCAL_CELL_SEC))
  const cells = tag?.finished ? new Uint8Array(n).fill(CELL_NONE) : base ? Uint8Array.from(base.cells) : new Uint8Array(n).fill(CELL_UNSURE)
  const openRegion = open ? { fromSec: Math.min(open.fromSec, open.toSec), toSec: Math.max(open.fromSec, open.toSec), kind: open.kind } : null
  paintRegions(cells, [...(tag?.regions ?? []), ...(openRegion ? [openRegion] : [])])
  return { cells, stereo: base?.stereo ?? true }
}

/** Paints his marks onto `cells` in the order he made them — voice as VOCAL, none as NONE, the later one on top. A mark's edge is rounded OUT to the cell. */
export function paintRegions(cells: Uint8Array, regions: readonly VocalRegion[]): void {
  for (const r of regions) {
    const a = Math.max(0, Math.floor(r.fromSec / VOCAL_CELL_SEC))
    const b = Math.min(cells.length, Math.ceil(r.toSec / VOCAL_CELL_SEC))
    const v = r.kind === 'none' ? CELL_NONE : CELL_VOCAL
    for (let i = a; i < b; i++) cells[i] = v
  }
}

/** The labels a FINISHED song gives the trainer: 1 = voice, 0 = everything else, his black marks included. */
export function manualLabels(regions: readonly VocalRegion[], durationSec: number): Uint8Array {
  const cells = new Uint8Array(Math.max(0, Math.floor(durationSec / VOCAL_CELL_SEC)))
  paintRegions(cells, regions)
  return cells
}

/**
 * Reaction time (the owner, 03/10): from hearing the voice start to pressing the button takes a moment, so "started" is placed this much BEFORE
 * the press and "ended" this much AFTER it (his wording). It was a full second first; he measured it on his own marks the same day and said it
 * was too much, so it is half a second. Fixed, not a setting. Since 04/10 this is only the fallback for a song with no beat grid — see `markedSpan`.
 */
export const MARK_LEAD_SEC = 0.5
export const MARK_TAIL_SEC = 0.5

function usableGrid(grid: BeatGrid | null): grid is BeatGrid {
  return !!grid && Number.isFinite(grid.bpm) && grid.bpm > 0 && Number.isFinite(grid.offsetSec)
}

/**
 * The yellow lines exactly as the deck's waveform draws them (`Deck.tsx` → `Waveform.tsx`: `bpm` with the grid's offset, 0 when there is no grid
 * yet). The snap must use the same lines he sees: a tag BPM with no detected grid still draws yellow lines, so it is snapped to as well. Only no
 * BPM at all (no lines on screen) falls back to the half second.
 */
export function drawnBarGrid(deck: { bpm: number | null; beatGrid: BeatGrid | null }): BeatGrid | null {
  return deck.bpm && deck.bpm > 0 ? { bpm: deck.bpm, offsetSec: deck.beatGrid?.offsetSec ?? 0 } : null
}

/** The yellow (bar) line at or before `sec`: the last one the playhead has already passed. A press exactly on a line keeps that line. */
export function barLineAtOrBeforeSec(sec: number, grid: BeatGrid): number {
  return nextBarLineSec(sec, grid) - (60 / grid.bpm) * BEATS_PER_BAR
}

/** The yellow (bar) line at or after `sec`: the first one the playhead has not yet passed. A press exactly on a line keeps that line. */
export function barLineAtOrAfterSec(sec: number, grid: BeatGrid): number {
  const before = barLineAtOrBeforeSec(sec, grid)
  return sec - before < 1e-6 ? before : before + (60 / grid.bpm) * BEATS_PER_BAR
}

/**
 * Where two presses put a mark (the owner, 04/10: "take the last yellow line that passed instead of half a second back" — vocals come in and out
 * on the bars, and the song's bars are about to be fixed, so the marks will sit right on them). With a beat grid "started" goes back to the
 * yellow line before the press and "ended" FORWARD to the line after it. The first version took "ended" back too, as first asked; that cut off
 * the last part of a voice that ends mid-bar, and he chose the line after (same day). Presses before the first line, where the start is clamped
 * to the song's start, can still leave a sliver: then the end goes to the next line after that. No grid (nothing to snap to) → the old half
 * second before / after.
 */
export function markedSpan(startPressSec: number, endPressSec: number, grid: BeatGrid | null): { fromSec: number; toSec: number } {
  const lo = Math.min(startPressSec, endPressSec)
  const hi = Math.max(startPressSec, endPressSec)
  if (!usableGrid(grid)) return { fromSec: lo - MARK_LEAD_SEC, toSec: hi + MARK_TAIL_SEC }
  const fromSec = Math.max(0, barLineAtOrBeforeSec(lo, grid))
  const toSec = barLineAtOrAfterSec(hi, grid)
  return { fromSec, toSec: toSec - fromSec < MIN_REGION_SEC ? nextBarLineSec(hi, grid) : toSec }
}

/**
 * The mark that two presses make. The too-short check is on the PRESSES, before the snapping: two accidental presses a moment apart must still be
 * refused, not turned into a whole bar of vocal.
 */
export function addMarkedRegion(
  regions: readonly VocalRegion[],
  startPressSec: number,
  endPressSec: number,
  durationSec: number,
  kind: 'voice' | 'none' = 'voice',
  grid: BeatGrid | null = null,
): AddRegionResult {
  if (![startPressSec, endPressSec].every(Number.isFinite)) return { ok: false, reason: 'bad-time' }
  if (Math.abs(endPressSec - startPressSec) < MIN_REGION_SEC) return { ok: false, reason: 'too-short' }
  const span = markedSpan(startPressSec, endPressSec, grid)
  return addRegion(regions, span.fromSec, span.toSec, durationSec, kind)
}

/**
 * Drags one edge of one mark (the owner, 03/10: resize the purple bars with the mouse). The edge stops MIN_REGION_SEC short of the other one, and
 * stays inside the song; the time is kept to a hundredth. `null` when there is no such mark or the time is not a number — the caller keeps what it had.
 */
export function moveRegionEdge(regions: readonly VocalRegion[], index: number, edge: 'from' | 'to', sec: number, durationSec: number): VocalRegion[] | null {
  const r = regions[index]
  if (!r || !Number.isFinite(sec) || !(durationSec > 0)) return null
  const hundredth = (x: number) => Math.round(x * 100) / 100
  const next: VocalRegion = edge === 'from' ? { ...r, fromSec: hundredth(Math.max(0, Math.min(sec, r.toSec - MIN_REGION_SEC))) } : { ...r, toSec: hundredth(Math.min(durationSec, Math.max(sec, r.fromSec + MIN_REGION_SEC))) }
  return regions.map((x, i) => (i === index ? next : x))
}
