import { useMemo } from 'react'
import {
  analyzeEnergyProfile,
  energyProximity,
  findTransitionCandidates,
  type EnergyProximity,
  type StructureReason,
} from '@/core/structure'
import type { BeatGrid, DeckId } from '@/core/types'
import { TRANSITION_CROSSFADE_SEC } from '@/core/constants'
import { HANDOFF_NEEDS_STRAIGHT_SYNC, bVoiceStarts, planHandoff, plainTransitionClashSec, type BVoiceStart, type HandoffPlan, type HandoffSide } from '@/core/vocal-handoff'
import { Pill } from '@/app/components/controls'

/**
 * Mix Assist (v0.4.6): the popover that lists this deck's own candidate
 * mix-in points, once it is loaded and paused while the other deck plays.
 * Picking a point is the flow's second and last click (ROADMAP.md v0.4.6,
 * "בחירת נקודה היא הקליק השני והאחרון") — so this panel is shown
 * automatically whenever it applies, never behind an extra open click of its
 * own. `onSelect` drives `startAutoTransition`; the "Mix in" pad is saved
 * later, only on an Excellent rating (`rateMixTransition`, v0.8.14). The
 * deck's own `showTransitionPoints` hides this panel while any transition is
 * active, so there is no double-fire path.
 *
 * The "based on energy" wording is load-bearing, not decoration: this is an
 * RMS-envelope heuristic, never real structure detection (see the doc
 * comment on `core/structure.ts` itself), and every label here — the panel
 * title, each point's reason, the v0.4.7 proximity line — has to say so in
 * the same words.
 */

const REASON_LABEL: Record<StructureReason, string> = {
  'energy-builds': 'past the intro — energy builds',
  'quiet-passage': 'quiet passage — energy dips',
  'energy-lifts': 'energy lifts — fuller section ahead',
}

/**
 * v0.4.7: how a candidate point compares to what's playing *right now* on
 * the other deck — a relative reading, never a promise ("smooth"/"jolt")
 * about how the transition will actually sound. See `energyProximity`'s own
 * doc comment in `core/structure.ts` for why this can't claim more than a
 * contour-shape comparison.
 */
const PROXIMITY_LABEL: Record<EnergyProximity, string> = {
  close: "close to what's playing now",
  quieter: "quieter than what's playing now",
  louder: "louder than what's playing now",
}

const PROXIMITY_DOT: Record<EnergyProximity, string> = {
  close: 'var(--color-live)',
  quieter: 'var(--color-warn)',
  louder: 'var(--color-warn)',
}

function fmtSec(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface Props {
  bands: Float32Array | null
  durationSec: number
  beatGrid: BeatGrid | null
  /** This deck's own load-time analysis failed — distinct from "still running". */
  analysisFailed: boolean
  /** The deck this panel would join against — named in the "can't compare yet" text. */
  otherDeckId: DeckId
  otherBands: Float32Array | null
  otherDurationSec: number
  /**
   * The other deck's playhead, floored to whole seconds *by the caller's own
   * store selector* (`Deck.tsx`) — not just for display here, but so a
   * continuously-updating raw position never reaches this component's props
   * in the first place. `Deck.tsx`'s `positionSec` selector otherwise writes
   * every animation frame regardless of whether this panel is even shown;
   * selecting the floored integer there means React only re-renders this
   * whole subtree about once a second, matching the ~1s resolution
   * `core/structure.ts`'s own contour already has.
   */
  otherPositionBucketSec: number
  otherAnalysisFailed: boolean
  onSelect: (sec: number) => void
  /**
   * v0.9.15, Mix Assist by sound: the voice of this deck (the one coming in) and of the other (playing), from `handoffSide` — his marks over
   * the computer's strip, or the reason there is none.
   */
  vocalSide: HandoffSide | { missing: string }
  otherVocalSide: HandoffSide | { missing: string }
  /** How SYNC will read this deck against the other: 1 straight, 2 / 0.5 half / double time (`ctl.handoffSyncMultiplier`). */
  syncMult: number
  /** A handoff row was clicked: the plan is recomputed from the live position at the click (`ctl.startVocalHandoffAt`). */
  onHandoff: (voice: BVoiceStart) => void
}

/** Shown at most: the earliest ones. A row is a click target on a ~710 px screen, and the energy points still have to fit under them. */
const MAX_HANDOFF_ROWS = 3

/**
 * The handoff rows (v0.9.15): one per voice of the incoming song that has room for drums before it, each planned against the playing song,
 * earliest handoff first. The plan itself is core's (`planHandoff`).
 */
function handoffRows(other: HandoffSide, otherPosSec: number, self: HandoffSide): { voice: BVoiceStart; plan: HandoffPlan }[] {
  // All of them — the panel shows MAX_HANDOFF_ROWS and counts the rest on screen, never drops them quietly.
  const rows: { voice: BVoiceStart; plan: HandoffPlan }[] = []
  for (const voice of bVoiceStarts(self)) {
    const plan = planHandoff(other, otherPosSec, self, voice)
    if (plan) rows.push({ voice, plan })
  }
  return rows.sort((x, y) => x.plan.handoffSec - y.plan.handoffSec)
}

const hasVoice = (side: HandoffSide) => side.timeline.cells.some((c) => c !== 0)

export function TransitionPointsPanel({
  bands,
  durationSec,
  beatGrid,
  analysisFailed,
  otherDeckId,
  otherBands,
  otherDurationSec,
  otherPositionBucketSec,
  otherAnalysisFailed,
  onSelect,
  vocalSide,
  otherVocalSide,
  syncMult,
  onHandoff,
}: Props) {
  // bands stays null until *this deck's* load-time analysis resolves
  // (`controls.ts`'s `loadTrackToDeck`) — independent of the track's
  // library-wide `analysisState`, which can already read "analyzed" from an
  // earlier background pass while this specific deck load is still running.
  const candidates = useMemo(
    () => (bands ? findTransitionCandidates(bands, durationSec, beatGrid) : []),
    [bands, durationSec, beatGrid],
  )

  const incomingProfile = useMemo(
    () => (bands ? analyzeEnergyProfile(bands, durationSec) : null),
    [bands, durationSec],
  )
  const otherProfile = useMemo(
    () => (otherBands ? analyzeEnergyProfile(otherBands, otherDurationSec) : null),
    [otherBands, otherDurationSec],
  )
  const proximityMessage = (candidateSec: number): { text: string; dot: string } => {
    if (incomingProfile && otherProfile) {
      const p = energyProximity(otherProfile, otherPositionBucketSec, incomingProfile, candidateSec)
      if (p) return { text: PROXIMITY_LABEL[p], dot: PROXIMITY_DOT[p] }
    }
    const text = otherAnalysisFailed
      ? `can't compare — deck ${otherDeckId}'s analysis failed`
      : `can't compare yet — deck ${otherDeckId} still analyzing`
    return { text, dot: 'var(--color-grid-dim)' }
  }

  const sides = 'missing' in vocalSide || 'missing' in otherVocalSide ? null : { self: vocalSide, other: otherVocalSide }
  const rows = useMemo(
    () => (sides && syncMult === 1 && hasVoice(sides.self) ? handoffRows(sides.other, otherPositionBucketSec, sides.self) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vocalSide, otherVocalSide, otherPositionBucketSec, syncMult],
  )
  // Why there is no handoff row, in words — the panel never just leaves the section out.
  const handoffNote = !sides
    ? `מסירת שירה: ${'missing' in otherVocalSide ? `דק ${otherDeckId} — ${otherVocalSide.missing}` : `השיר הזה — ${(vocalSide as { missing: string }).missing}`}`
    : syncMult !== 1
      ? HANDOFF_NEEDS_STRAIGHT_SYNC
      : !hasVoice(sides.self)
      ? 'מסירת שירה: בשיר הזה אין שירה — שום נקודה לא תשים שירה על שירה'
      : rows.length === 0
        ? bVoiceStarts(sides.self).length === 0
          ? 'מסירת שירה: אין בשיר הזה 4 תיבות בלי שירה לפני שהשירה נכנסת'
          : `מסירת שירה: אין בדק ${otherDeckId} עד סוף השיר רגע שקט מספיק ארוך (4 תיבות) להוריד אותו`
        : null
  // The second signal on each energy point: the plain transition from there — would it put a voice over a voice? Never merged with the energy dot.
  const vocalMessage = (candidateSec: number): { text: string; dot: string } | null => {
    if (!sides) return null
    const clash = plainTransitionClashSec(sides.other, otherPositionBucketSec, sides.self, candidateSec, TRANSITION_CROSSFADE_SEC, syncMult)
    return clash == null
      ? { text: 'שירה: נקי', dot: 'var(--color-live)' }
      : { text: `שירה על שירה ב-${fmtSec(clash)} (דק ${otherDeckId})`, dot: 'var(--color-danger)' }
  }

  return (
    // `max-h-48 overflow-y-auto` (v0.8.6): unbounded, this grows with the
    // candidate count, and a track with several candidates could push it
    // tall enough to cover the deck's own Play/Sync buttons underneath —
    // found live (Shalom, screenshot) as "I can't reach Play with the other
    // deck playing". It auto-shows without a click of its own (see the class
    // doc comment above), so there was no way to dismiss it except doing the
    // exact thing it was blocking.
    <div
      className="absolute left-0 top-full z-30 mt-1 max-h-48 w-72 overflow-y-auto rounded-[var(--radius-md)] border border-hairline bg-surface-2 p-2.5 text-left shadow-[var(--shadow-pop)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1 label">מסירת שירה — לפי הצליל</div>
      {handoffNote ? (
        <div className="mb-2 text-2xs text-grid-muted" data-testid="handoff-note">{handoffNote}</div>
      ) : (
        <div className="mb-2 flex flex-col gap-1" data-testid="handoff-rows">
          {rows.slice(0, MAX_HANDOFF_ROWS).map(({ voice, plan }) => (
            <button
              key={voice.voiceSec}
              type="button"
              onClick={() => onHandoff(voice)}
              className="rounded-[var(--radius-sm)] text-left transition-opacity hover:opacity-80"
            >
              <Pill tone="idle" label={`נכנס ב-${fmtSec(plan.entrySec)} · ${plan.runwayBars} תיבות בלי שירה · שר מ-${fmtSec(plan.bVoiceSec)}`} />
              <span className="mt-0.5 flex items-center gap-1 px-2 text-2xs text-grid-muted">
                <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: 'var(--color-live)' }} />
                {plan.onVoiceEnd ? `דק ${otherDeckId} מפסיק לשיר ב-${fmtSec(plan.handoffSec)}` : `דק ${otherDeckId} שקט ב-${fmtSec(plan.handoffSec)}`}
                {` · בעוד ${fmtSec(plan.handoffSec - otherPositionBucketSec)}`}
              </span>
            </button>
          ))}
          {rows.length > MAX_HANDOFF_ROWS && (
            <div className="px-2 text-2xs text-grid-muted">{`ועוד ${rows.length - MAX_HANDOFF_ROWS} מאוחרות יותר — יופיעו כשהשיר יתקדם`}</div>
          )}
        </div>
      )}
      <div className="mb-2 label">Transition points — based on energy</div>
      {bands === null ? (
        <div className="text-2xs text-grid-muted">
          {analysisFailed
            ? 'Analysis failed — you can still play it in manually.'
            : 'Still analyzing…'}
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-2xs text-grid-muted">
          No clear transition points found — energy stays roughly constant throughout.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {candidates.map((c) => {
            const { text, dot } = proximityMessage(c.sec)
            const vocal = vocalMessage(c.sec)
            return (
              <button
                key={`${c.reason}-${c.sec}`}
                type="button"
                onClick={() => onSelect(c.sec)}
                className="rounded-[var(--radius-sm)] text-left transition-opacity hover:opacity-80"
              >
                <Pill tone="idle" label={`${fmtSec(c.sec)} · ${REASON_LABEL[c.reason]}`} />
                <span className="mt-0.5 flex items-center gap-1 px-2 text-2xs text-grid-muted">
                  <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: dot }} />
                  {text}
                </span>
                {vocal && (
                  <span className="flex items-center gap-1 px-2 text-2xs text-grid-muted">
                    <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: vocal.dot }} />
                    {vocal.text}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
