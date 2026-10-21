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
import { HANDOFF_NEEDS_STRAIGHT_SYNC, bVoiceStarts, enoughSongAfterMix, handoffEndInB, planHandoff, plainMixEndInB, type BVoiceStart, type HandoffPlan, type HandoffSide } from '@/core/vocal-handoff'
import { SWAP_BARS, planVocalSwap, swapEntries, type SwapEntry, type VocalSwapPlan } from '@/core/vocal-swap-mix'
import { excellentFirst, isExcellentEntry, withoutBad, type BadEntry } from '@/core/bad-mixes'
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
  /** The file's length — what `bands` is spread over, so the only length that turns a bucket into a second. */
  durationSec: number
  /** v0.9.70: where the sound ends (`songEndSec`). A silent tail is no room for a mix; the energy points offered are judged against this. */
  endSec: number
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
  /** v0.9.17: where an energy point would join the other deck, and why there (`ctl.deckPhraseJoin`); null without a grid. */
  phraseJoin: (otherPositionSec: number, entrySec?: number) => { sec: number; why: string; aVoiceSec: number | null; rise: 'ok' | 'moved' | 'stuck' | 'unchecked' } | null
  /** A vocal-swap row was clicked (`ctl.startVocalSwapAt`): planned again from the live position. */
  onVocalSwap: (entry: SwapEntry) => void
  /** v0.12.14: this pair's mixes rated Bad (by the incoming song's start second). Rows at those seconds are left out, and counted. */
  badEntries: readonly BadEntry[]
  /** v0.12.15: entry seconds of this pair rated Excellent: listed first, marked, and never hidden by a Bad. */
  excellentSecs: readonly number[]
  /** "Show again": forgets the Bad ratings of this pair. */
  onRestoreBad: () => void
}

/** Shown at most, earliest first. A row is a click target on a ~710 px screen, and the energy points still have to fit under them. */
const MAX_HANDOFF_ROWS = 4

/**
 * The handoff rows (v0.9.15): one per voice of the incoming song that has room for a run-in before it, each planned against the playing song.
 * In song order since v0.12.13, the incoming song's earliest way in first. The plan itself is core's (`planHandoff`).
 */
function handoffRows(other: HandoffSide, otherPosSec: number, self: HandoffSide): { rows: { voice: BVoiceStart; plan: HandoffPlan }[]; allLate: boolean } {
  const rows: { voice: BVoiceStart; plan: HandoffPlan }[] = []
  let late = 0
  let unplanned = 0
  for (const voice of bVoiceStarts(self)) {
    const plan = planHandoff(other, otherPosSec, self, voice)
    if (!plan) {
      unplanned++
      continue
    }
    // v0.9.23: a voice this close to the song's end would leave B over before the mix is — not offered.
    if (enoughSongAfterMix(self.durationSec, self.grid, handoffEndInB(plan))) rows.push({ voice, plan })
    else late++
  }
  // Only when the song's end is the whole reason: a voice deck A never goes quiet for is the other reason, and the note must not blame one
  // for the other.
  // v0.12.13 (owner, 19/10): in song order — the incoming song's earliest way in first.
  return { rows: rows.sort((x, y) => x.plan.entrySec - y.plan.entrySec), allLate: late > 0 && unplanned === 0 }
}

/*
 * Points the panel does not offer (too late in the song, too short, too early, past the row cap) are left out with no line counting them.
 * The owner's decision, 06/10, after v0.9.23 counted them: "אין צורך להציג... שיש קטע שלא מוצג, פשוט אל תציג אותם". A named exemption from
 * the never-skip-silently rule, not an omission: the rules that hide them are fixed and named (`enoughSongAfterMix`, `swapEntries`,
 * `MAX_HANDOFF_ROWS`), and a section with nothing to offer still says so in words.
 */

/**
 * The vocal-swap rows: one per voice of the incoming song it can come in on, each planned against the playing song, earliest first
 * (`core/vocal-swap-mix.ts`). `note` is why there is none — never an empty section.
 */
function swapRows(other: HandoffSide, otherPosSec: number, self: HandoffSide, otherDeckId: DeckId): { rows: { entry: SwapEntry; plan: VocalSwapPlan }[]; note: string | null } {
  const { entries } = swapEntries(self)
  const rows: { entry: SwapEntry; plan: VocalSwapPlan }[] = []
  for (const entry of entries) {
    const plan = planVocalSwap(other, otherPosSec, self, entry)
    if (plan) rows.push({ entry, plan })
  }
  rows.sort((x, y) => x.plan.joinSec - y.plan.joinSec || x.entry.voiceSec - y.entry.voiceSec)
  if (rows.length) return { rows, note: null }
  if (entries.length) return { rows, note: `החלפת שירה: אין בדק ${otherDeckId} עד סוף השיר רגע בלי שירה שמחזיק ${SWAP_BARS} תיבות` }
  return { rows, note: 'החלפת שירה: אין בשיר הזה כניסת שירה מתאימה' }
}

const hasVoice = (side: HandoffSide) => side.timeline.cells.some((c) => c !== 0)

export function TransitionPointsPanel({
  bands,
  durationSec,
  endSec,
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
  phraseJoin,
  onVocalSwap,
  badEntries,
  excellentSecs,
  onRestoreBad,
}: Props) {
  // bands stays null until *this deck's* load-time analysis resolves
  // (`controls.ts`'s `loadTrackToDeck`) — independent of the track's
  // library-wide `analysisState`, which can already read "analyzed" from an
  // earlier background pass while this specific deck load is still running.
  // v0.9.23: an energy point B enters at must leave B playing well past the crossfade — the late ones are not offered.
  // Where the mix ends is `plainMixEndInB`'s, the same one a saved pad and an excellent pair are refused by (`refuseTooLateEntry`, v0.9.26).
  const { candidates: allCandidates, lateCandidates } = useMemo(() => {
    const all = bands ? findTransitionCandidates(bands, durationSec, beatGrid) : []
    const ok = all.filter((c) => enoughSongAfterMix(endSec, beatGrid, plainMixEndInB(c.sec, beatGrid, TRANSITION_CROSSFADE_SEC)))
    ok.sort((x, y) => x.sec - y.sec)
    return { candidates: ok, lateCandidates: all.length > ok.length }
  }, [bands, durationSec, endSec, beatGrid])

  const { shown: candidatesShown, hidden: hiddenEnergy } = withoutBad(allCandidates, (c) => c.sec, badEntries, excellentSecs)
  const candidates = excellentFirst(candidatesShown, (c) => c.sec, excellentSecs)
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
  const { rows: allRows, allLate } = useMemo(
    () => (sides && syncMult === 1 && hasVoice(sides.self) ? handoffRows(sides.other, otherPositionBucketSec, sides.self) : { rows: [], allLate: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vocalSide, otherVocalSide, otherPositionBucketSec, syncMult],
  )
  const swapAll = useMemo(
    () => (sides && syncMult === 1 && hasVoice(sides.self) ? swapRows(sides.other, otherPositionBucketSec, sides.self, otherDeckId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vocalSide, otherVocalSide, otherPositionBucketSec, syncMult, otherDeckId],
  )
  // v0.12.14: the Bad-rated rows come out after the notes below were decided on the full lists, so a section whose every row was rated Bad
  // says so (hiddenBad) instead of claiming the song has no such mix.
  const { shown: rowsShown, hidden: hiddenHandoff } = withoutBad(allRows, (r) => r.plan.entrySec, badEntries, excellentSecs)
  const rows = excellentFirst(rowsShown, (r) => r.plan.entrySec, excellentSecs)
  const swapShown = swapAll ? withoutBad(swapAll.rows, (r) => r.plan.entrySec, badEntries, excellentSecs) : null
  const swap = swapAll && swapShown ? { ...swapAll, rows: excellentFirst(swapShown.shown, (r) => r.plan.entrySec, excellentSecs) } : null
  const hiddenBad = hiddenHandoff + (swapShown?.hidden ?? 0) + hiddenEnergy
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
          : allLate
          ? 'מסירת שירה: אין בשיר הזה נקודה שנשאר אחריה מספיק שיר'
          : `מסירת שירה: בשיר הזה אין מספיק נגינה בלי שירה לפני שהוא שר כדי לכסות מעבר של דק ${otherDeckId} — או שדק ${otherDeckId} לא מפסיק לשיר עד הסוף`
        : null
  // The second signal on each energy point: is the playing song singing while the plain transition runs? Never merged with the energy dot.
  // v0.9.17: an energy point starts where the playing song's next phrase starts, not on its next bar — the row says when.
  // Since v0.12.13 (the owner, 19/10) waiting for A's quiet is only the handoff's rule: this line says, as a fact, whether A sings during
  // the plain mix (`ctl.deckPhraseJoin`); it is not a refusal.
  const join = phraseJoin(otherPositionBucketSec)
  // Only A's reading matters here: the line must show even when this song (B) has no voice reading of its own.
  const vocalMessage: { text: string; dot: string } | null = !join
    ? null
    : join.aVoiceSec != null
      ? { text: `דק ${otherDeckId} שר ב-${fmtSec(join.aVoiceSec)} — המעבר ירוץ על השירה שלו`, dot: 'var(--color-warn)' }
      : 'missing' in otherVocalSide
        ? null // the join line itself says A's singing there is unknown
        : { text: 'שירה: נקי', dot: 'var(--color-live)' }

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
      {hiddenBad > 0 && (
        <div className="mb-2 flex items-center gap-2 text-2xs text-grid-muted" data-testid="bad-hidden">
          <span className="min-w-0 flex-1">{`${hiddenBad} מיקסים שסימנת כרעים לא מוצגים כאן`}</span>
          <button type="button" onClick={onRestoreBad} className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 hover:bg-surface-3">
            הצג שוב
          </button>
        </div>
      )}
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
              {/* v0.12.13: his five steps in one row — B's drums from here, A's last line ends, A's transition, B sings. */}
              <Pill tone={isExcellentEntry(excellentSecs, plan.entrySec) ? 'accent' : 'idle'} label={`${isExcellentEntry(excellentSecs, plan.entrySec) ? '★ ' : ''}השיר מתחיל מ-${fmtSec(plan.entrySec)} · שר מ-${fmtSec(plan.bVoiceSec)}`} />
              <span className="mt-0.5 flex items-center gap-1 px-2 text-2xs text-grid-muted">
                <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: 'var(--color-live)' }} />
                {`תופים כשדק ${otherDeckId} ב-${fmtSec(plan.joinSec)} · הוא מסיים לשיר ב-${fmtSec(plan.aVoiceEndSec)} · מעבר ${plan.transitionBars} תיבות · בעוד ${fmtSec(plan.joinSec - otherPositionBucketSec)}`}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* The vocal swap (owner, 05/10): A's voice goes as B's comes in, A's instruments go, B's voice over A's bass, then the bass swap. */}
      <div className="mb-1 label">{`החלפת שירה — ${SWAP_BARS} תיבות`}</div>
      {!swap ? (
        <div className="mb-2 text-2xs text-grid-muted" data-testid="swap-note">{handoffNote?.replace('מסירת שירה', 'החלפת שירה').replace('המסירה', 'המיקס')}</div>
      ) : (
        <div className="mb-2 flex flex-col gap-1" data-testid="swap-rows">
          {swap.rows.slice(0, MAX_HANDOFF_ROWS).sort((x, y) => x.entry.voiceSec - y.entry.voiceSec).map(({ entry, plan }) => (
            <button
              key={entry.voiceSec}
              type="button"
              onClick={() => onVocalSwap(entry)}
              className="rounded-[var(--radius-sm)] text-left transition-opacity hover:opacity-80"
            >
              <Pill tone={isExcellentEntry(excellentSecs, plan.entrySec) ? 'accent' : 'idle'} label={`${isExcellentEntry(excellentSecs, plan.entrySec) ? '★ ' : ''}מתחיל כשדק ${otherDeckId} ב-${fmtSec(plan.joinSec)} · נכנס מהשירה שלו ב-${fmtSec(plan.bVoiceSec)}`} />
              <span className="mt-0.5 flex items-center gap-1 px-2 text-2xs text-grid-muted">
                <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: 'var(--color-live)' }} />
                {plan.onVoiceEnd ? `דק ${otherDeckId} מסיים לשיר ב-${fmtSec(plan.joinSec)}` : `דק ${otherDeckId} שקט ב-${fmtSec(plan.joinSec)}`}
                {` · בעוד ${fmtSec(plan.joinSec - otherPositionBucketSec)} · ${Math.round(plan.endSec - plan.joinSec)} שנ'`}
                {plan.bassHold ? ` · הבס של דק ${otherDeckId} ממשיך עד שהבס הנכנס מתחיל` : plan.holdSkipped ? ` · בלי המשך בס: ${plan.holdSkipped}` : ''}
              </span>
            </button>
          ))}
          {swap.note && <div className="px-2 text-2xs text-grid-muted" data-testid="swap-left-out">{swap.note}</div>}
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
          {hiddenEnergy > 0
            ? 'כל נקודות האנרגיה של השיר הזה סומנו כרעות — "הצג שוב" למעלה מחזיר אותן.'
            : lateCandidates
            ? 'No transition point leaves enough of this song after the mix.'
            : 'No clear transition points found — energy stays roughly constant throughout.'}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {/* v0.12.12 (owner, 19/10: "4 points, all 3:15"): every energy point joins A at the same second — A's next phrase start — so it is said
              once here, not under each point, where it read as four copies of one mix. The points differ in where this song starts. */}
          {join && (
            <div className="mb-0.5 px-2 text-2xs text-grid-muted" data-testid="phrase-join">
              {`כל הנקודות נכנסות כשדק ${otherDeckId} ב-${fmtSec(join.sec)} — ${join.why} · בעוד ${fmtSec(join.sec - otherPositionBucketSec)}`}
            </div>
          )}
          {candidates.map((c) => {
            const { text, dot } = proximityMessage(c.sec)
            const vocal = vocalMessage
            // v0.12.16: a point whose own join differs from the one above (it would cut a rise of A with a quiet start) says so, as a fact.
            const own = phraseJoin(otherPositionBucketSec, c.sec)
            const riseNote =
              own?.rise === 'moved'
                ? `כניסה בעוד ${fmtSec(own.sec - otherPositionBucketSec)} (דק ${otherDeckId} ב-${fmtSec(own.sec)}) — לא קוטעת עלייה`
                : own?.rise === 'stuck'
                  ? `דק ${otherDeckId} עולה אחרי הכניסה והשיר הזה מתחיל שקט — לא נמצאה נקודה טובה יותר`
                  : own?.rise === 'unchecked'
                    ? 'לא נבדק אם הכניסה קוטעת עלייה — אין עדיין ניתוח עוצמה לשני השירים'
                    : null
            // A moved join sings (or not) at its own second, not at the shared one above.
            const vocalHere =
              own?.rise === 'moved' && vocal
                ? own.aVoiceSec != null
                  ? { text: `דק ${otherDeckId} שר ב-${fmtSec(own.aVoiceSec)} — המעבר ירוץ על השירה שלו`, dot: 'var(--color-warn)' }
                  : { text: 'שירה: נקי', dot: 'var(--color-live)' }
                : vocal
            return (
              <button
                key={`${c.reason}-${c.sec}`}
                type="button"
                onClick={() => onSelect(c.sec)}
                className="rounded-[var(--radius-sm)] text-left transition-opacity hover:opacity-80"
              >
                <Pill tone={isExcellentEntry(excellentSecs, c.sec) ? 'accent' : 'idle'} label={`${isExcellentEntry(excellentSecs, c.sec) ? '★ ' : ''}השיר מתחיל מ-${fmtSec(c.sec)} · ${REASON_LABEL[c.reason]}`} />
                <span className="mt-0.5 flex items-center gap-1 px-2 text-2xs text-grid-muted">
                  <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: dot }} />
                  {text}
                </span>
                {vocalHere && (
                  <span className="flex items-center gap-1 px-2 text-2xs text-grid-muted">
                    <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: vocalHere.dot }} />
                    {vocalHere.text}
                  </span>
                )}
                {riseNote && (
                  <span className="flex items-center gap-1 px-2 text-2xs text-grid-muted" data-testid="rise-note">
                    <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: own?.rise === 'stuck' ? 'var(--color-warn)' : 'var(--color-live)' }} />
                    {riseNote}
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
