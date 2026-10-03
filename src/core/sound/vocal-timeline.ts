/**
 * The vocal timeline contract (v0.9.10): what the analysis returns, what is
 * stored, and how a strip is drawn from it. Pure.
 *
 * Three cell values, never two: `unsure` is an answer of its own. A strip that
 * drew "unsure" as "no vocals" would teach the owner to trust an empty lane at
 * a mix point it knows nothing about — the failure the spec guards hardest.
 */

/** 0 = no vocals, 1 = vocals, 2 = the cues are weak or disagree. */
export type VocalCell = 0 | 1 | 2
export const CELL_NONE = 0
export const CELL_VOCAL = 1
export const CELL_UNSURE = 2

/** One cell is half a second, the unit the target accuracy is stated in. */
export const VOCAL_CELL_SEC = 0.5

export interface VocalTimeline {
  /** One `VocalCell` per `VOCAL_CELL_SEC`, from the start of the track. */
  cells: Uint8Array
  /** False when the file is mono (or both channels are the same): the stereo cue was not used. */
  stereo: boolean
}

/**
 * Every outcome has a name, and every name is shown (the project's "never skip
 * silently"). `ready` and `mono` and `no-vocals` carry a timeline; the rest do not.
 */
export type VocalState =
  | 'queued'
  | 'analysing'
  | 'ready'
  | 'mono'
  | 'no-vocals'
  | 'too-short'
  | 'silent'
  | 'failed'

export interface VocalResult {
  state: VocalState
  timeline: VocalTimeline | null
  /** Why, in a few words — shown next to the state when it is not `ready`. */
  note?: string
}

/** Shorter than this has no room for a vocal section to start and end. */
export const VOCAL_MIN_SEC = 30

/** The state shown for a finished timeline: all-none is its own named state. */
export function stateOfTimeline(t: VocalTimeline): VocalState {
  let any = false
  for (let i = 0; i < t.cells.length; i++) {
    if (t.cells[i] === CELL_VOCAL) {
      any = true
      break
    }
  }
  if (!t.stereo) return 'mono'
  return any ? 'ready' : 'no-vocals'
}

/** Text next to the track title when the lane alone does not say enough — Hebrew first, as everywhere in the UI. */
export function vocalStateText(state: VocalState, note?: string): string | null {
  // A note is shown whenever there is one: it carries the reason the strip is missing or weaker (a genre rule, an unknown genre), and a state
  // name alone ("no vocals") would read as a measurement for the Trance rule, which measured nothing.
  const withNote = (base: string) => (note ? `${base} — ${note}` : base)
  switch (state) {
    case 'ready':
      return note ? `שירה: ${note}` : null
    case 'queued':
      return withNote('שירה: לא נותח עדיין')
    case 'analysing':
      return 'שירה: מנתח…'
    case 'mono':
      return withNote('שירה: מונו — פחות בטוח')
    case 'no-vocals':
      return note ? `שירה: ${note}` : 'שירה: אין שירה'
    case 'too-short':
      return withNote('שירה: השיר קצר מדי לניתוח')
    case 'silent':
      return withNote('שירה: השיר שקט')
    case 'failed':
      return `שירה: הניתוח נכשל${note ? ` — ${note}` : ''}`
  }
}

export interface VocalSegment {
  cell: VocalCell
  /** Percent of the strip's width, 0–100. */
  leftPct: number
  widthPct: number
}

/**
 * Runs of equal cells as boxes on a strip. A run narrower than `minPx` is
 * widened to it, so a short vocal in a long track is never drawn as nothing
 * (the same floor `overviewLoopBox` gives a short loop). Boxes stay inside the strip.
 */
export function vocalStripSegments(t: VocalTimeline, durationSec: number, widthPx: number, minPx = 1): VocalSegment[] {
  const n = t.cells.length
  if (n === 0 || !(durationSec > 0) || !(widthPx > 0)) return []
  const out: VocalSegment[] = []
  let start = 0
  for (let i = 1; i <= n; i++) {
    if (i === n || t.cells[i] !== t.cells[start]) {
      const fromSec = start * VOCAL_CELL_SEC
      const toSec = Math.min(durationSec, i * VOCAL_CELL_SEC)
      if (toSec > fromSec) {
        let widthPct = ((toSec - fromSec) / durationSec) * 100
        const minPct = (minPx / widthPx) * 100
        if (widthPct < minPct) widthPct = minPct
        const leftPct = Math.min((fromSec / durationSec) * 100, 100 - widthPct)
        out.push({ cell: t.cells[start] as VocalCell, leftPct, widthPct })
      }
      start = i
    }
  }
  return out
}

/** Share of the track drawn dashed — reported next to every accuracy number, since "unsure" abstains instead of being right or wrong. */
export function dashedFraction(t: VocalTimeline): number {
  if (t.cells.length === 0) return 0
  let u = 0
  for (let i = 0; i < t.cells.length; i++) if (t.cells[i] === CELL_UNSURE) u++
  return u / t.cells.length
}
