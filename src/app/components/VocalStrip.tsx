import { useMemo, useState } from 'react'
import { useSettings } from '@/app/hooks/useSettings'
import { useStore } from '@/app/state/store'
import * as ctl from '@/controls'
import { MARK_LEAD_SEC, MARK_TAIL_SEC, effectiveTimeline, regionMask } from '@/core/sound/vocal-manual'
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
 * vertical line — with its own playhead and played shade, like the overview's. Three looks, never two: solid = voice, dashed = unsure, empty = no
 * voice. Unsure is NEVER drawn like "no voice". Display only: it suggests no mix and moves nothing.
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
  // His marks win over the model's guess (core: `effectiveTimeline`). The open one is drawn up to the play position, in whole seconds like the timers.
  const secBucket = Math.floor(positionSec)
  const timeline = useMemo(
    () => effectiveTimeline(vocal?.timeline ?? null, tag, durationSec, open ? { fromSec: open.startSec - MARK_LEAD_SEC, toSec: secBucket + MARK_TAIL_SEC } : null),
    [vocal?.timeline, tag, durationSec, open, secBucket],
  )
  const manualSegs = useMemo(() => {
    if (!tag && !open) return []
    const mask = regionMask([...(tag?.regions ?? []), ...(open ? [{ fromSec: Math.min(open.startSec, secBucket) - MARK_LEAD_SEC, toSec: Math.max(open.startSec, secBucket) + MARK_TAIL_SEC }] : [])], durationSec)
    return durationSec > 0 ? vocalStripSegments({ cells: mask, stereo: true }, durationSec, 600, 2).filter((s) => s.cell === CELL_VOCAL) : []
  }, [tag, open, secBucket, durationSec])
  const segs = useMemo(() => (timeline && durationSec > 0 ? vocalStripSegments(timeline, durationSec, 600, 2) : []), [timeline, durationSec])
  const countdown = useMemo(() => (timeline ? vocalCountdown(timeline, secBucket, durationSec) : null), [timeline, secBucket, durationSec])
  // His finished marks replace whatever the model's state said (a Trance rule, a failure): the strip is now his, and the line says so.
  const note = tag?.finished ? 'סומן ידנית' : vocal ? vocalStateText(vocal.state, vocal.note) : durationSec > 0 ? 'שירה: לא נותח עדיין' : null
  const pct = durationSec > 0 ? Math.max(0, Math.min(100, (positionSec / durationSec) * 100)) : 0
  return (
    <div className="flex shrink-0 flex-col gap-0.5" data-vocal-strip={deckId} data-vocal-state={vocal?.state ?? 'none'}>
      <div className="flex items-center gap-1">
        <div
          className="relative h-2 flex-1 overflow-hidden rounded-[2px] bg-white/10"
          role="img"
          aria-label={timeline ? 'פס שירה: מלא = יש שירה, מקווקו = לא בטוח, ריק = אין שירה' : (note ?? 'אין פס שירה')}
        >
          {segs.map((s, i) =>
            s.cell === CELL_NONE ? null : (
              <div
                key={i}
                data-vocal-cell={s.cell === CELL_VOCAL ? 'vocal' : 'unsure'}
                className="absolute inset-y-0"
                style={{
                  left: `${s.leftPct}%`,
                  width: `${s.widthPct}%`,
                  background: s.cell === CELL_VOCAL ? VOICE : `repeating-linear-gradient(90deg, ${VOICE} 0 2px, transparent 2px 4px)`,
                }}
              />
            ),
          )}
          {manualSegs.map((m, i) => (
            <div key={`m${i}`} data-vocal-manual className="absolute top-0 h-[2px] bg-white" style={{ left: `${m.leftPct}%`, width: `${m.widthPct}%` }} />
          ))}
          {timeline && durationSec > 0 && (
            <>
              <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/50" style={{ width: `${pct}%` }} />
              <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct}%` }} />
            </>
          )}
        </div>
        {/* the overview above has a hint icon (w-4) beside it; this keeps the two lanes the same width */}
        <span className="w-4 shrink-0" aria-hidden />
      </div>
      {vocalMarking && contentHash && durationSec > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs" data-vocal-marking={deckId}>
          <button
            type="button"
            onClick={() => void ctl.toggleVocalMark(deckId)}
            className={`rounded-[var(--radius-sm)] px-2 py-1 font-semibold ${open ? 'bg-white text-black' : 'bg-surface-2 text-white'}`}
            style={open ? undefined : { boxShadow: `inset 0 0 0 1px ${VOICE}` }}
          >
            {open ? 'נגמרה שירה' : 'התחילה שירה'}
          </button>
          <button type="button" disabled={!open && !(tag && tag.regions.length > 0)} onClick={() => void ctl.undoVocalMark(deckId)} title="לחצת בטעות? 'ביטול התחלה' מבטל סימון פתוח. 'ביטול סיום' מחזיר את הסימון האחרון למצב פתוח כדי ללחוץ 'נגמרה שירה' שוב במקום הנכון." className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted disabled:opacity-40">
            {open ? 'ביטול התחלה' : 'ביטול סיום'}
          </button>
          {!tag?.finished ? (
            <button
              type="button"
              disabled={!tag || tag.regions.length === 0}
              onClick={() => void ctl.finishVocalMarks(deckId)}
              title="אחרי הלחיצה, כל מה שלא סימנת בשיר הזה יהיה ריק (במקום הניחוש של המחשב)."
              className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted disabled:opacity-40"
            >
              סיימתי לסמן את השיר
            </button>
          ) : (
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
              {confirmClear ? 'בטוח? לחץ שוב — כל הסימונים נמחקים' : 'חזרה לניחוש המחשב'}
            </button>
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
          {countdown ? countdownText(countdown) : null}
        </span>
        {note && <span className="text-grid-muted">{note}</span>}
      </div>
    </div>
  )
}
