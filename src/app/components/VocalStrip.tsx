import { useMemo, useRef, useState } from 'react'
import { HintIcon } from '@/app/components/controls'
import { useSettings } from '@/app/hooks/useSettings'
import { useStore } from '@/app/state/store'
import { useShallow } from 'zustand/react/shallow'
import * as ctl from '@/controls'
import { MIN_REGION_SEC, drawnBarGrid, effectiveTimeline, markedSpan } from '@/core/sound/vocal-manual'
import {
  CELL_NONE,
  CELL_VOCAL,
  vocalCountdown,
  vocalStateText,
  vocalStripSegments,
  type VocalCountdown,
  type VocalResult,
} from '@/core/sound/vocal-timeline'

interface Props {
  vocal: VocalResult | undefined
  durationSec: number
  positionSec: number
  deckId: 'A' | 'B'
  contentHash: string | undefined
}

const VOICE = '#c084fc'
const mmss = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const mmssTenths = (sec: number) => {
  const t = Math.max(0, Math.round(sec * 10) / 10)
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
}

/** The countdown line. Whole seconds only, so it changes once a second, not on every frame the playhead moves. */
function countdownText(c: VocalCountdown): string {
  switch (c.phase) {
    case 'in':
      return `שירה עכשיו · נגמרת בעוד ${mmss(c.endsInSec ?? 0)}`
    case 'before':
      return `שירה מתחילה בעוד ${mmss(c.startsInSec ?? 0)} · נגמרת בעוד ${mmss(c.endsInSec ?? 0)}`
    case 'after':
      return 'אין עוד שירה בשיר'
    case 'none':
      return 'אין שירה בשיר'
  }
}

/**
 * The vocal strip (v0.9.10b): a lane under the whole-track overview, same width, so a point on the overview and the same point on the lane are one
 * vertical line — with its own playhead and played shade, like the overview's. Solid = voice, empty = no voice, dashed = unsure. Since 04/10 the
 * computer's strip only gives the first two (the owner's rule, core/sound/vocal-strip.ts); dashed is left for a hand-marking draft with no
 * computer guess under it. Unsure is NEVER drawn like "no voice". Display only: it suggests no mix and moves nothing.
 *
 * Under it, the two timers the owner asked for (03/10): when the voice starts and when it ends. They count "unsure" as voice (core: `vocalCountdown`).
 * When there is no strip, the line says why in words instead of staying blank (the project's "never skip silently").
 */
export function VocalStrip({ vocal, durationSec, positionSec, deckId, contentHash }: Props) {
  const { vocalMarking } = useSettings()
  const tag = useStore((s) => (contentHash ? s.vocalManual[contentHash] : undefined))
  const openMark = useStore((s) => s.vocalMarkOpen[deckId])
  const open = openMark && openMark.contentHash === contentHash ? openMark : null
  const [confirmClear, setConfirmClear] = useState(false)
  // "This song has no voice" (the owner's choice, 04/10): the explicit way to finish a song with no marks. Kept per song by its hash, so loading
  // another song never carries a tick over to it.
  const [noVoiceFor, setNoVoiceFor] = useState<string | null>(null)
  const noVoice = !!contentHash && noVoiceFor === contentHash
  // His marks win over the model's guess (core: `effectiveTimeline`). The open one is drawn up to the play position, in whole seconds like the timers.
  const secBucket = Math.floor(positionSec)
  // The open mark is drawn where "ended" would put it now (the same yellow-line snap, core: `markedSpan`); on a grid it grows a bar at a time.
  // Under MIN_REGION_SEC "ended" would be refused, so until then only the stretch between the press and the playhead is drawn, not a whole bar.
  const grid = useStore(useShallow((s) => drawnBarGrid(s.decks[deckId])))
  const draftEnd = grid ? positionSec : secBucket
  const draft = !open ? null : Math.abs(draftEnd - open.startSec) < MIN_REGION_SEC ? { fromSec: Math.min(open.startSec, draftEnd), toSec: Math.max(open.startSec, draftEnd) } : markedSpan(open.startSec, draftEnd, grid)
  const draftFrom = draft?.fromSec ?? 0
  const draftTo = draft?.toSec ?? 0
  // The timers read the half-second cells of everything together: his marks over the guess, or only his marks once the song is finished.
  const timeline = useMemo(
    () => effectiveTimeline(vocal?.timeline ?? null, tag, durationSec, open ? { fromSec: draftFrom, toSec: draftTo, kind: open.kind } : null),
    [vocal?.timeline, tag, durationSec, open, draftFrom, draftTo],
  )
  // What is drawn: the model's guess (unless the song is finished — then it has no say), and over it his marks at their EXACT times, not rounded
  // out to half seconds like the cells the timers read. The mark still open grows with the play position.
  const displayTimeline = useMemo(() => {
    if (tag?.finished) return null
    return tag ? effectiveTimeline(vocal?.timeline ?? null, { regions: [], finished: false }, durationSec) : (vocal?.timeline ?? null)
  }, [tag, vocal?.timeline, durationSec])
  const segs = useMemo(() => (displayTimeline && durationSec > 0 ? vocalStripSegments(displayTimeline, durationSec, 600, 2) : []), [displayTimeline, durationSec])
  const bars = [
    ...(tag?.regions ?? []).map((r, i) => ({ ...r, index: i as number | null })),
    ...(open ? [{ fromSec: draftFrom, toSec: draftTo, kind: open.kind, index: null as number | null }] : []),
  ]
  // Dragging an edge (the owner, 03/10: resize the purple bars with the mouse). Only when marking is on and no mark is open.
  const laneRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ index: number; edge: 'from' | 'to'; lastX: number; sec: number } | null>(null)
  const [dragInfo, setDragInfo] = useState<{ edge: 'from' | 'to'; sec: number } | null>(null)
  const editable = vocalMarking && !!tag && !open && durationSec > 0
  const startDrag = (e: React.PointerEvent<HTMLDivElement>, index: number, edge: 'from' | 'to', sec: number) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { index, edge, lastX: e.clientX, sec }
    setDragInfo({ edge, sec })
    e.stopPropagation()
  }
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const w = laneRef.current?.getBoundingClientRect().width
    if (!d || !w) return
    // Shift = ten times finer: the lane is ~400 px for a whole song, about half a second a pixel — too coarse for the last tenth.
    d.sec += (e.clientX - d.lastX) * (durationSec / w) * (e.shiftKey ? 0.1 : 1)
    d.lastX = e.clientX
    ctl.setVocalRegionEdge(deckId, d.index, d.edge, d.sec, false)
    setDragInfo({ edge: d.edge, sec: d.sec })
  }
  const endDrag = () => {
    const d = drag.current
    drag.current = null
    setDragInfo(null)
    if (d) ctl.setVocalRegionEdge(deckId, d.index, d.edge, d.sec, true)
  }
  const nudge = (e: React.WheelEvent<HTMLDivElement>, index: number, edge: 'from' | 'to', sec: number) => {
    ctl.setVocalRegionEdge(deckId, index, edge, sec + (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 0.02 : 0.1), true)
  }
  const countdown = useMemo(() => (timeline ? vocalCountdown(timeline, secBucket, durationSec) : null), [timeline, secBucket, durationSec])
  // His finished marks replace whatever the model's state said (a Trance rule, a failure): the strip is now his, and the line says so.
  const note = tag?.finished ? 'סומן ידנית' : vocal ? vocalStateText(vocal.state, vocal.note) : durationSec > 0 ? 'שירה: לא נותח עדיין' : null
  const pct = durationSec > 0 ? Math.max(0, Math.min(100, (positionSec / durationSec) * 100)) : 0
  return (
    <div className="flex shrink-0 flex-col gap-0.5" data-vocal-strip={deckId} data-vocal-state={vocal?.state ?? 'none'}>
      <div className="flex items-center gap-1">
        <div ref={laneRef} className="relative h-2 flex-1" role="img" aria-label={timeline ? 'פס שירה: מלא = יש שירה, מקווקו = לא בטוח, ריק = אין שירה' : (note ?? 'אין פס שירה')}>
          {/* "No voice" is ONE look (the owner, 05/10: the black he paints and the black the strip leaves empty are the same thing to him, and
              two blacks — one with a white top line — read as two answers). So once there is anything to draw, the lane itself is that black,
              and his black marks are drawn in exactly the same black with no edge line. Before anything is drawn the lane stays grey: an
              un-analysed song must not look like "no voice". */}
          <div className={`absolute inset-0 overflow-hidden rounded-[2px] ${(timeline || bars.length > 0) && durationSec > 0 ? 'bg-black' : 'bg-white/10'}`}>
            {segs.map((sg, i) =>
              sg.cell === CELL_NONE ? null : (
                <div
                  key={i}
                  data-vocal-cell={sg.cell === CELL_VOCAL ? 'vocal' : 'unsure'}
                  className="absolute inset-y-0"
                  style={{
                    left: `${sg.leftPct}%`,
                    width: `${sg.widthPct}%`,
                    background: sg.cell === CELL_VOCAL ? VOICE : `repeating-linear-gradient(90deg, ${VOICE} 0 2px, transparent 2px 4px)`,
                  }}
                />
              ),
            )}
            {durationSec > 0 &&
              bars.map((m, i) => (
                <div
                  key={`m${i}`}
                  data-vocal-manual
                  data-vocal-manual-kind={m.kind === 'none' ? 'none' : 'voice'}
                  className={`absolute inset-y-0 ${m.kind === 'none' ? 'bg-black' : 'border-t-2 border-white'}`}
                  style={{ left: `${(m.fromSec / durationSec) * 100}%`, width: `${((m.toSec - m.fromSec) / durationSec) * 100}%`, ...(m.kind === 'none' ? {} : { background: VOICE }) }}
                />
              ))}
            {(timeline || bars.length > 0) && durationSec > 0 && (
              <>
                <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/50" style={{ width: `${pct}%` }} />
                <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct}%` }} />
              </>
            )}
          </div>
          {editable &&
            bars.map((m) =>
              m.index == null
                ? null
                : (['from', 'to'] as const).map((edge) => {
                    const sec = edge === 'from' ? m.fromSec : m.toSec
                    return (
                      <div
                        key={`h${m.index}${edge}`}
                        data-vocal-handle={`${m.index}:${edge}`}
                        title="גרור לשינוי הקצה. Shift = עדין פי 10. גלגלת העכבר = 0.1 שנייה (Shift = 0.02)."
                        className="group absolute -inset-y-1 z-10 w-2.5 -translate-x-1/2 cursor-ew-resize touch-none"
                        style={{ left: `${(sec / durationSec) * 100}%` }}
                        onPointerDown={(e) => startDrag(e, m.index as number, edge, sec)}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onLostPointerCapture={endDrag}
                        onWheel={(e) => nudge(e, m.index as number, edge, sec)}
                      >
                        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white/0 group-hover:bg-white" />
                      </div>
                    )
                  }),
            )}
        </div>
        {/* the overview above has a hint icon beside it; this one takes the same place, so the two lanes stay the same width */}
        <HintIcon id="deck.vocalStrip" />
      </div>
      {vocalMarking && contentHash && durationSec > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs" data-vocal-marking={deckId}>
          <button
            type="button"
            disabled={open?.kind === 'none'}
            onClick={() => void ctl.toggleVocalMark(deckId, 'voice')}
            className={`rounded-[var(--radius-sm)] px-2 py-1 font-semibold disabled:opacity-30 ${open?.kind !== 'none' && open ? 'bg-white text-black' : 'bg-surface-2 text-white'}`}
            style={open ? undefined : { boxShadow: `inset 0 0 0 1px ${VOICE}` }}
          >
            {open && open.kind !== 'none' ? 'נגמרה שירה' : 'התחילה שירה'}
          </button>
          <button
            type="button"
            disabled={!!open && open.kind !== 'none'}
            onClick={() => void ctl.toggleVocalMark(deckId, 'none')}
            title="צובע בשחור: אין שירה בקטע הזה, גם אם המחשב חושב שיש. הסימון האחרון שעשית קובע."
            className={`rounded-[var(--radius-sm)] px-2 py-1 font-semibold disabled:opacity-30 ${open?.kind === 'none' ? 'bg-white text-black' : 'bg-black text-white'}`}
            style={open ? undefined : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.4)' }}
          >
            {open?.kind === 'none' ? 'נגמר השקט' : 'התחיל שקט (אין שירה)'}
          </button>
          <button type="button" disabled={!open && !(tag && tag.regions.length > 0)} onClick={() => void ctl.undoVocalMark(deckId)} title="לחצת בטעות? 'ביטול התחלה' מבטל סימון פתוח. 'ביטול סיום' מחזיר את הסימון האחרון למצב פתוח כדי ללחוץ 'נגמרה שירה' שוב במקום הנכון." className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted disabled:opacity-40">
            {open ? 'ביטול התחלה' : 'ביטול סיום'}
          </button>
          {!tag?.finished ? (
            <>
              {!(tag && tag.regions.length > 0) && !open && (
                <label className="flex cursor-pointer items-center gap-1 px-1 text-grid-muted" title="סמן אם אין בשיר הזה שירה בכלל: אז אפשר לסיים בלי לסמן כלום, וכל השיר יהיה שחור.">
                  <input type="checkbox" checked={noVoice} onChange={(e) => setNoVoiceFor(e.target.checked ? contentHash : null)} />
                  אין שירה בשיר
                </label>
              )}
              <button
                type="button"
                disabled={!noVoice && !open && !(tag && tag.regions.length > 0)}
                onClick={() => void ctl.finishVocalMarks(deckId)}
                title="אחרי הלחיצה, כל מה שלא סימנת בשיר הזה יהיה ריק (במקום הניחוש של המחשב). שיר בלי שירה בכלל? סמן 'אין שירה בשיר'."
                className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted disabled:opacity-40"
              >
                סיימתי לסמן את השיר
              </button>
            </>
          ) : tag.taught ? (
            <>
              <span className="font-semibold" style={{ color: VOICE }}>✓ המחשב למד מהשיר הזה</span>
              <button type="button" onClick={() => void ctl.unteachSong(deckId)} className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted">
                הסר מהלימוד
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void ctl.teachFromSong(deckId)}
                title="הסימונים שלך הם התשובה לשיר הזה. הניחוש הישן של המחשב נמחק, והשיר נכנס לרשימת השיעורים שהמחשב לומד מהם."
                className="rounded-[var(--radius-sm)] px-2 py-1 font-semibold text-black"
                style={{ background: VOICE }}
              >
                למד את המחשב מהשיר הזה
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!confirmClear) {
                    setConfirmClear(true)
                    return
                  }
                  setConfirmClear(false)
                  void ctl.clearVocalMarks(deckId)
                }}
                onBlur={() => setConfirmClear(false)}
                className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-warn"
              >
                {confirmClear ? 'בטוח? לחץ שוב — כל הסימונים נמחקים' : 'מחק סימונים וחזור לניחוש'}
              </button>
            </>
          )}
          <button type="button" onClick={() => void ctl.exportVocalMarks()} title="שומר את הסימונים של כל השירים לקובץ חדש (גיבוי, ואחר כך אימון)." className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted">
            ייצא סימונים
          </button>
          <button type="button" onClick={() => void ctl.importVocalMarks()} title="מחזיר סימונים מקובץ גיבוי. שיר שכבר יש לו סימון כאן לא נדרס." className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted">
            ייבא סימונים
          </button>
          {tag && (
            <span className="text-grid-muted">
              סימונים: {tag.regions.length} · {tag.finished ? 'גמור' : 'טיוטה על הניחוש'}
            </span>
          )}
        </div>
      )}
      <div className="flex items-baseline justify-between gap-3 text-xs leading-none">
        <span
          data-vocal-countdown={deckId}
          className="font-semibold tabular-nums"
          style={{ color: countdown && (countdown.phase === 'in' || countdown.phase === 'before') ? VOICE : undefined }}
          title="הטיימרים סופרים גם קטעים של 'לא בטוח' כשירה, ומתעלמים מהפסקה קצרה מ-3 שניות בין שני קטעי שירה."
        >
          {dragInfo ? `${dragInfo.edge === 'from' ? 'התחלה' : 'סוף'} ${mmssTenths(dragInfo.sec)}` : countdown ? countdownText(countdown) : null}
        </span>
        {note && <span className="text-grid-muted">{note}</span>}
      </div>
    </div>
  )
}
