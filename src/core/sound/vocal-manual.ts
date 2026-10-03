/**
 * The owner's own vocal marks (v0.9.10b, 03/10): he presses "vocal started" and "vocal ended" while the song plays, as many times as the song needs.
 * His ears beat the model, so his marks win — but only in the way he chose: what he did NOT colour stays empty once he says the song is finished,
 * and until then his marks are drawn over the model's guess. Pure: no storage, no clock.
 *
 * `regions` is the list in the order he made them, NOT a merged set, so "undo last" undoes what he last did even when it overlapped an older mark.
 * Overlaps are merged only when a timeline is built.
 */
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, VOCAL_CELL_SEC, type VocalTimeline } from '@/core/sound/vocal-timeline'

export interface VocalRegion {
  fromSec: number
  toSec: number
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
  updatedAt: number
}

/** Shorter than this is a mis-click, not a vocal: refused with a message, never stored. */
export const MIN_REGION_SEC = 0.5

export type AddRegionResult = { ok: true; regions: VocalRegion[] } | { ok: false; reason: 'too-short' | 'bad-time' }

/** Appends a mark. The two times can come in either order (he may have seeked back before pressing "ended"); they are clamped to the song. */
export function addRegion(regions: readonly VocalRegion[], aSec: number, bSec: number, durationSec: number): AddRegionResult {
  if (![aSec, bSec, durationSec].every(Number.isFinite) || durationSec <= 0) return { ok: false, reason: 'bad-time' }
  const from = Math.max(0, Math.min(aSec, bSec))
  const to = Math.min(durationSec, Math.max(aSec, bSec))
  if (to - from < MIN_REGION_SEC) return { ok: false, reason: 'too-short' }
  return { ok: true, regions: [...regions, { fromSec: from, toSec: to }] }
}

export function removeLastRegion(regions: readonly VocalRegion[]): VocalRegion[] {
  return regions.slice(0, -1)
}

/**
 * Undo of the last "ended" press: the mark goes back to being OPEN, at the press that started it, so a wrong "ended" is fixed by pressing "ended"
 * again at the right moment — not by marking the whole stretch from scratch. (Cancelling the open mark is the second step, for a wrong "started".)
 * The start press is recovered from the stored mark by taking the lead back off; a mark that was clamped at the start of the song gives a press
 * a little later than the real one, which only matters to the draft until he presses "ended".
 */
export function undoLastEnd(regions: readonly VocalRegion[]): { regions: VocalRegion[]; reopenStartPressSec: number | null } {
  const last = regions[regions.length - 1]
  if (!last) return { regions: [], reopenStartPressSec: null }
  return { regions: regions.slice(0, -1), reopenStartPressSec: last.fromSec + MARK_LEAD_SEC }
}

/** One 0/1 per half second: 1 where any region touches the cell. A region's edge is rounded OUT to the cell, so a mark never shrinks. */
export function regionMask(regions: readonly VocalRegion[], durationSec: number): Uint8Array {
  const n = Math.max(0, Math.floor(durationSec / VOCAL_CELL_SEC))
  const mask = new Uint8Array(n)
  for (const r of regions) {
    const a = Math.max(0, Math.floor(r.fromSec / VOCAL_CELL_SEC))
    const b = Math.min(n, Math.ceil(r.toSec / VOCAL_CELL_SEC))
    for (let i = a; i < b; i++) mask[i] = 1
  }
  return mask
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
  open?: { fromSec: number; toSec: number } | null,
): VocalTimeline | null {
  const regions = [...(tag?.regions ?? []), ...(open ? [{ fromSec: Math.min(open.fromSec, open.toSec), toSec: Math.max(open.fromSec, open.toSec) }] : [])]
  if (!tag && !open) return base
  const mask = regionMask(regions, durationSec)
  if (tag?.finished) {
    return { cells: mask.map((m) => (m ? CELL_VOCAL : CELL_NONE)), stereo: base?.stereo ?? true }
  }
  const cells = base ? Uint8Array.from(base.cells) : new Uint8Array(mask.length).fill(CELL_UNSURE)
  for (let i = 0; i < Math.min(cells.length, mask.length); i++) if (mask[i]) cells[i] = CELL_VOCAL
  return { cells, stereo: base?.stereo ?? true }
}

/**
 * Reaction time (the owner, 03/10): from hearing the voice start to pressing the button takes a moment, so "started" is placed this much BEFORE
 * the press and "ended" this much AFTER it (his wording). It was a full second first; he measured it on his own marks the same day and said it
 * was too much, so it is half a second. Fixed, not a setting.
 */
export const MARK_LEAD_SEC = 0.5
export const MARK_TAIL_SEC = 0.5

/**
 * The mark that two presses make. The too-short check is on the PRESSES, before the widening: two accidental presses a moment apart must still be
 * refused, not turned into a two-second vocal by the lead and tail.
 */
export function addMarkedRegion(regions: readonly VocalRegion[], startPressSec: number, endPressSec: number, durationSec: number): AddRegionResult {
  if (![startPressSec, endPressSec].every(Number.isFinite)) return { ok: false, reason: 'bad-time' }
  const lo = Math.min(startPressSec, endPressSec)
  const hi = Math.max(startPressSec, endPressSec)
  if (hi - lo < MIN_REGION_SEC) return { ok: false, reason: 'too-short' }
  return addRegion(regions, lo - MARK_LEAD_SEC, hi + MARK_TAIL_SEC, durationSec)
}
