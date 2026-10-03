import { useMemo } from 'react'
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
  deckId: string
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
export function VocalStrip({ vocal, durationSec, positionSec, deckId }: Props) {
  const timeline = vocal?.timeline ?? null
  const segs = useMemo(() => (timeline && durationSec > 0 ? vocalStripSegments(timeline, durationSec, 600, 2) : []), [timeline, durationSec])
  const secBucket = Math.floor(positionSec)
  const countdown = useMemo(() => (timeline ? vocalCountdown(timeline, secBucket, durationSec) : null), [timeline, secBucket, durationSec])
  const note = vocal ? vocalStateText(vocal.state, vocal.note) : durationSec > 0 ? 'שירה: לא נותח עדיין' : null
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
