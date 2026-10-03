import { useMemo } from 'react'
import { CELL_NONE, CELL_UNSURE, CELL_VOCAL, vocalStateText, vocalStripSegments, type VocalResult } from '@/core/sound/vocal-timeline'

interface Props {
  vocal: VocalResult | undefined
  durationSec: number
  deckId: string
}

/**
 * The vocal strip (v0.9.10b): a thin lane under the whole-track overview, same width, so a point on the overview and the same point on the lane
 * are one vertical line. Three looks, never two: solid = voice, dashed = unsure, empty = no voice. Unsure is NEVER drawn like "no voice" — an
 * empty stretch means the model was confident there is none. Display only: it suggests no mix and moves nothing.
 *
 * One hue, light on dark, deliberately not the waveform's green (green there means mid frequencies) and not red/green for yes/no.
 * When there is no strip, the lane says why in words instead of staying blank (the project's "never skip silently").
 */
export function VocalStrip({ vocal, durationSec, deckId }: Props) {
  const segs = useMemo(
    () => (vocal?.timeline && durationSec > 0 ? vocalStripSegments(vocal.timeline, durationSec, 600, 2) : []),
    [vocal, durationSec],
  )
  const text = vocal ? vocalStateText(vocal.state, vocal.note) : durationSec > 0 ? 'שירה: לא נותח עדיין' : null
  const hasStrip = !!vocal?.timeline
  return (
    <div className="flex shrink-0 items-center gap-1" data-vocal-strip={deckId} data-vocal-state={vocal?.state ?? 'none'}>
      <div
        className="relative h-1 flex-1 overflow-hidden rounded-[2px] bg-white/5"
        role="img"
        aria-label={hasStrip ? 'פס שירה: מלא = יש שירה, מקווקו = לא בטוח, ריק = אין שירה' : (text ?? 'אין פס שירה')}
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
                background:
                  s.cell === CELL_VOCAL
                    ? 'var(--color-vocal, #e9d5ff)'
                    : s.cell === CELL_UNSURE
                      ? 'repeating-linear-gradient(90deg, #e9d5ff 0 2px, transparent 2px 4px)'
                      : undefined,
              }}
            />
          ),
        )}
      </div>
      {text && <span className="shrink-0 text-2xs leading-none text-grid-muted">{text}</span>}
      {/* keeps the lane the same width as the overview above it, which has a hint icon (w-4) beside it */}
      <span className="w-4 shrink-0" aria-hidden />
    </div>
  )
}
