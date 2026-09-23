import { quantizeToGrid } from '@/core/beatgrid'
import type { BeatGrid } from '@/core/types'

/**
 * Candidate mix-transition points from the track's own energy contour.
 *
 * This is deliberately *not* structure detection: telling an intro from a
 * verse from a drop needs kick/snare timbre analysis this project doesn't do
 * (`core/beatgrid.ts`'s own doc comment: beat phase only, no bar/downbeat).
 * What this finds is sustained rises and falls in the already-computed
 * low/mid/high RMS envelope (`platform/analyzer-js/analyze.ts`'s `bands`) — a
 * loudness-contour heuristic, not a musical one. The UI must say so in these
 * exact terms ("based on energy", never "structure detected"/"intro"/
 * "outro") — see ROADMAP.md v0.4.6.
 */
export type StructureReason = 'energy-builds' | 'quiet-passage' | 'energy-lifts'

export interface StructureCandidate {
  sec: number
  reason: StructureReason
}

/**
 * Below this fraction of the track's own near-peak sustained level, a
 * window counts as "quiet". Chosen, not measured — same status as
 * `beatgrid.ts`'s `CONFIDENCE_RATIO` until checked against real tracks.
 * Global (whole-track-peak-relative) on purpose — this is only used to find
 * the *intro* boundary (`energy-builds` below), where "quiet, then loud" is
 * the whole point. Everything else in this file compares a point to its own
 * *local* neighbourhood instead — see `LOCAL_DEVIATION_RATIO`.
 */
const ENERGY_THRESHOLD_RATIO = 0.55

/** A rise/fall must hold for this long to count as a real transition, not a transient. */
const MIN_SUSTAIN_SEC = 4

/** Coarse analysis window — the raw `bands` buckets (~5ms apart) are far too fine-grained to threshold directly. */
const WINDOW_SEC = 1

/**
 * v0.5.1: a mid-track candidate must differ from its own trailing local
 * average by at least this fraction to count as a real shift — comparing
 * against a nearby stretch of the *same* track, not the track's global peak
 * (`ENERGY_THRESHOLD_RATIO`), is what lets this catch a bridge/breakdown in a
 * loudness-war master, where every section already sits close to the global
 * peak and a global threshold never fires there at all. Chosen, not measured.
 */
const LOCAL_DEVIATION_RATIO = 0.3

/** How far back a mid-track candidate looks to build its "what came before" baseline. */
const LOCAL_BASELINE_SEC = 15

/** No mid-track candidate this close to the very start — `energy-builds` already owns the intro boundary. */
const START_GUARD_SEC = 10

/**
 * No mid-track candidate this close to the very end. Almost every track
 * thins out or fades somewhere in its last few seconds — surfacing that as a
 * "mix point" is trivial and was the direct complaint this version fixes: a
 * DJ mixing out with under ~20s of track left gains nothing from being told
 * the fade exists. v0.5.1 removed the dedicated end-of-track scan outright
 * (it used to always find that fade and label it "into the outro"); this
 * guard keeps the general mid-track scan below from rediscovering the same
 * non-answer.
 */
const END_GUARD_SEC = 20

/** Two candidates closer together than this are the same transition still settling, not two distinct ones. */
const MIN_GAP_SEC = 20

/** Never flood the popover with every local wiggle that clears the bar. */
const MAX_MID_CANDIDATES = 3

/**
 * Per-second combined loudness (low+mid+high RMS summed), downsampled from
 * the fine-grained `bands` buckets analysis already computed at load time.
 */
function energyContour(bands: Float32Array, durationSec: number): number[] {
  const bucketCount = Math.floor(bands.length / 3)
  if (bucketCount === 0 || durationSec <= 0) return []
  const secPerBucket = durationSec / bucketCount
  const bucketsPerWindow = Math.max(1, Math.round(WINDOW_SEC / secPerBucket))
  const windows = Math.ceil(bucketCount / bucketsPerWindow)
  const out = new Array<number>(windows).fill(0)
  for (let w = 0; w < windows; w++) {
    const start = w * bucketsPerWindow
    const end = Math.min(bucketCount, start + bucketsPerWindow)
    let sum = 0
    for (let i = start; i < end; i++) sum += bands[i * 3] + bands[i * 3 + 1] + bands[i * 3 + 2]
    out[w] = sum / Math.max(1, end - start)
  }
  return out
}

/** 90th percentile — resistant to a single loud transient the way a bare max isn't. */
function nearPeakLevel(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.9)]
}

/**
 * A track's energy contour plus the two numbers needed to read a level back
 * out of it at an arbitrary point in time. Shared by `findTransitionCandidates`
 * (a track's own candidate points) and `energyProximity` (comparing *two*
 * tracks' levels at specific moments) so both read the same per-track-normalized
 * data instead of two heuristics that could drift apart.
 */
export interface EnergyProfile {
  contour: number[]
  peak: number
  /** Seconds per `contour` bucket — close to `WINDOW_SEC` but not exact once `durationSec` doesn't divide evenly. */
  windowSec: number
}

/** Builds the per-track energy profile `findTransitionCandidates`/`energyProximity` both read from. */
export function analyzeEnergyProfile(bands: Float32Array, durationSec: number): EnergyProfile {
  const contour = energyContour(bands, durationSec)
  const peak = nearPeakLevel(contour)
  const windowSec = contour.length > 0 ? durationSec / contour.length : 0
  return { contour, peak, windowSec }
}

/**
 * Mid-track candidates (v0.5.1): sustained rises *and* falls anywhere in the
 * track, judged against a *local* trailing baseline instead of the global
 * near-peak level. This is what lets a breakdown in a loudness-war master
 * register at all — it never dips below `ENERGY_THRESHOLD_RATIO` of the
 * track's own peak, but it is still clearly quieter than the 15s that led
 * into it. Returns them in playback order, each at least `MIN_GAP_SEC` apart
 * and capped at `MAX_MID_CANDIDATES` so a track with constant small wobble
 * doesn't flood the popover.
 *
 * `afterSec` excludes anything within `MIN_GAP_SEC` of the `energy-builds`
 * candidate (when one was found) so the intro boundary isn't reported twice
 * under two different reasons.
 */
function findMidTrackCandidates(
  contour: number[],
  windowSec: number,
  afterSec: number | null,
): StructureCandidate[] {
  const baselineWindows = Math.max(1, Math.round(LOCAL_BASELINE_SEC / windowSec))
  const minWindows = Math.max(1, Math.round(MIN_SUSTAIN_SEC / windowSec))
  const minGapWindows = Math.max(1, Math.round(MIN_GAP_SEC / windowSec))
  const startIdx = Math.max(
    baselineWindows,
    Math.round(START_GUARD_SEC / windowSec),
    afterSec != null ? Math.round((afterSec + MIN_GAP_SEC) / windowSec) : 0,
  )
  const endIdx = contour.length - Math.round(END_GUARD_SEC / windowSec)

  const out: StructureCandidate[] = []
  let lastPickedIdx = -Infinity
  for (let i = startIdx; i < endIdx; i++) {
    if (i + minWindows > contour.length) break
    if (i - lastPickedIdx < minGapWindows) continue

    let sum = 0
    for (let k = i - baselineWindows; k < i; k++) sum += contour[k]
    const baseline = sum / baselineWindows
    if (baseline <= 1e-6) continue

    const riseLevel = baseline * (1 + LOCAL_DEVIATION_RATIO)
    const dropLevel = baseline * (1 - LOCAL_DEVIATION_RATIO)
    const isRise = contour[i] >= riseLevel
    const isDrop = contour[i] <= dropLevel
    if (!isRise && !isDrop) continue

    let sustained = true
    for (let k = i; k < i + minWindows; k++) {
      if (isRise ? contour[k] < riseLevel : contour[k] > dropLevel) {
        sustained = false
        break
      }
    }
    if (!sustained) continue

    out.push({ sec: i * windowSec, reason: isRise ? 'energy-lifts' : 'quiet-passage' })
    lastPickedIdx = i
    if (out.length >= MAX_MID_CANDIDATES) break
  }
  return out
}

/**
 * Find candidate mix-transition points on `bands` (from `analyzeWaveform`,
 * `platform/analyzer-js/analyze.ts`), quantized to `grid` when one is known.
 * Returns an empty array — never a fabricated guess — when the track's
 * energy stays roughly constant throughout (ambient, ultra-flat masters):
 * the "never skip silently" rule cuts both ways, and inventing a point here
 * would overstate what this heuristic actually found.
 */
export function findTransitionCandidates(
  bands: Float32Array,
  durationSec: number,
  grid: BeatGrid | null,
): StructureCandidate[] {
  const { contour, peak, windowSec } = analyzeEnergyProfile(bands, durationSec)
  if (contour.length === 0) return []
  const minWindows = Math.max(1, Math.round(MIN_SUSTAIN_SEC / windowSec))
  if (peak <= 1e-6) return []
  const threshold = peak * ENERGY_THRESHOLD_RATIO

  const sustainedFrom = (i: number, above: boolean): boolean => {
    if (i + minWindows > contour.length) return false
    for (let k = i; k < i + minWindows; k++) {
      if (above ? contour[k] < threshold : contour[k] >= threshold) return false
    }
    return true
  }

  const candidates: StructureCandidate[] = []
  let buildsSec: number | null = null

  // Earliest sustained rise — a candidate "past the intro" point. Requires an
  // actual boundary (the window right before was below threshold); otherwise
  // a track that is loud from second 0 would falsely register a "rise" at
  // i=0, when there is nothing before it to have risen from.
  for (let i = 1; i < contour.length; i++) {
    if (contour[i - 1] < threshold && sustainedFrom(i, true)) {
      buildsSec = i * windowSec
      candidates.push({ sec: buildsSec, reason: 'energy-builds' })
      break
    }
  }

  // v0.5.1: the rest of the track, scanned against a local baseline instead
  // of the global peak — see `findMidTrackCandidates`'s own doc comment.
  // This replaces two things that used to live here: a single
  // quiet-passage-in-the-middle-60% scan (too narrow a window, and blind to
  // rises), and a dedicated end-of-track "energy-drops" scan that always
  // trivially found the final fade and reported it as "into the outro" —
  // never a useful mix point, since there is nothing left to mix into by
  // then. Removed outright rather than gated, on Shalom's direct call
  // (09/06): every track has *some* fade at the very end, so that scan could
  // never do anything but fire.
  candidates.push(...findMidTrackCandidates(contour, windowSec, buildsSec))

  if (!grid) return candidates
  return candidates.map((c) => ({ ...c, sec: quantizeToGrid(c.sec, grid) }))
}

/**
 * v0.5.4: the next candidate a currently-*playing* deck is heading toward —
 * an "exit point" to suggest for the *outgoing* side of a transition, reusing
 * the exact same candidates `findTransitionCandidates` already computes for
 * that track (there is no separate "exit" heuristic; a good place to enter a
 * track and a good place to leave one are found the same way). Ignores
 * anything already behind `positionSec` — a candidate the deck has already
 * played past is not somewhere it can still exit to. Returns `null` — never
 * a guess — when nothing is left ahead, e.g. a short track already past its
 * last candidate.
 */
export function nextCandidateFrom(
  candidates: StructureCandidate[],
  positionSec: number,
): StructureCandidate | null {
  let best: StructureCandidate | null = null
  for (const c of candidates) {
    if (c.sec >= positionSec && (best === null || c.sec < best.sec)) best = c
  }
  return best
}

/**
 * What `startAutoTransition` (`controls.ts`) rates and labels an "exit
 * point" — `nextCandidateFrom`'s pick when it found one, otherwise the live
 * position itself. Fixed 23/09: this used to be `nextCandidateFrom(...) ??
 * null`, and a transition started late in a track (past every candidate)
 * silently produced `null` — which in turn skipped the rating prompt
 * entirely in `finishTransition`, with no explanation on screen. Always a
 * real number now: whether or not the structural heuristic had a
 * recommendation, the transition still exited from *somewhere*.
 */
export function resolveExitPointSec(candidates: StructureCandidate[], positionSec: number): number {
  return nextCandidateFrom(candidates, positionSec)?.sec ?? positionSec
}

/**
 * How a candidate mix-in point (in the *incoming* track) compares to the
 * *outgoing* deck's energy right now — v0.4.7. Both levels are read from
 * each track's own contour and normalized to that track's own near-peak
 * (same normalization `findTransitionCandidates` already uses), so this is a
 * claim about contour-shape alignment, not about absolute perceived loudness
 * or mastering level — two tracks mastered very differently can both read
 * "close" here while sitting at different absolute volumes.
 *
 * Returns `null` — never a guess — when the outgoing deck's own analysis
 * isn't available yet (still running, failed, or too short/flat to have a
 * contour): the UI must show that explicitly, not silently default to "close".
 */
export type EnergyProximity = 'close' | 'quieter' | 'louder'

/**
 * Below this gap (as a fraction of each track's own near-peak level), two
 * points read as "about the same energy" rather than one being called out as
 * louder or quieter. Chosen, not measured — same status as
 * `ENERGY_THRESHOLD_RATIO` until checked against real tracks.
 */
const PROXIMITY_CLOSE_RATIO = 0.15

function levelAt(profile: EnergyProfile, sec: number): number {
  // `round`, not `floor`: a candidate's own `sec` is generated as
  // `i * windowSec` (`findTransitionCandidates` above), and dividing back by
  // the same non-exact float `windowSec` can land a hair under the intended
  // integer (e.g. 4.999999... instead of 5) — `floor` would then read the
  // *previous* window's level instead, silently landing on the wrong side of
  // exactly the boundary this function exists to compare across.
  const idx = Math.max(0, Math.min(profile.contour.length - 1, Math.round(sec / profile.windowSec)))
  return profile.contour[idx] / profile.peak
}

export function energyProximity(
  outgoing: EnergyProfile | null,
  outgoingPositionSec: number,
  incoming: EnergyProfile,
  candidateSec: number,
): EnergyProximity | null {
  if (!outgoing || outgoing.contour.length === 0 || outgoing.peak <= 1e-6) return null
  if (incoming.contour.length === 0 || incoming.peak <= 1e-6) return null
  const diff = levelAt(incoming, candidateSec) - levelAt(outgoing, outgoingPositionSec)
  if (Math.abs(diff) <= PROXIMITY_CLOSE_RATIO) return 'close'
  return diff > 0 ? 'louder' : 'quieter'
}
