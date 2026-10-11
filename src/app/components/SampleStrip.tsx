import { useMemo, useState } from 'react'
import { HintIcon } from '@/app/components/controls'
import { useSettings } from '@/app/hooks/useSettings'
import { useStore } from '@/app/state/store'
import { useShallow } from 'zustand/react/shallow'
import * as ctl from '@/controls'
import { overlapsMark } from '@/core/sound/sample-marks'
import { drawnBarGrid } from '@/core/sound/vocal-manual'

interface Props {
  durationSec: number
  positionSec: number
  deckId: 'A' | 'B'
  contentHash: string | undefined
}

const LOOP = '#22d3ee'
const HIT = '#f472b6'
const GUESS = '#fbbf24'
const BARS_CHOICES = [2, 4, 8] as const

/**
 * The sample lane (v0.9.30 stage 1 experiment, 11/10), under the vocal strip and the same width. Two thin rows: the computer's candidates (amber,
 * brighter = the next block repeats this one more exactly) above, and the owner's own marks (cyan = loop, pink = hit) below, so the two can be
 * read against each other on the same vertical line. Display and marking only: it plays nothing by itself and changes no song.
 * Shown only while the "Mark samples by hand" setting is on.
 */
export function SampleStrip({ durationSec, positionSec, deckId, contentHash }: Props) {
  const { sampleMarking } = useSettings()
  const tag = useStore((s) => (contentHash ? s.sampleMarks[contentHash] : undefined))
  const openMark = useStore((s) => s.sampleMarkOpen[deckId])
  const open = openMark && openMark.contentHash === contentHash ? openMark : null
  const framesFor = useStore((s) => s.sampleFramesFor[deckId])
  const failedFor = useStore((s) => s.sampleFramesFailed[deckId])
  const grid = useStore(useShallow((s) => drawnBarGrid(s.decks[deckId])))
  const [bars, setBars] = useState<number>(4)
  const [confirmClear, setConfirmClear] = useState(false)
  const [noneFor, setNoneFor] = useState<string | null>(null)
  const ready = !!contentHash && framesFor === contentHash
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the candidates are read from the controls' cache; what changes them is exactly these inputs
  const cands = useMemo(() => (ready && grid ? ctl.sampleCandidatesFor(deckId, bars) : null), [ready, grid?.bpm, grid?.offsetSec, bars, deckId, durationSec])
  if (!sampleMarking || durationSec <= 0) return null
  if (!contentHash) return <div className="text-xs text-grid-muted" data-sample-strip={deckId}>סימון קטעים לא זמין: הקובץ עוד לא זוהה (או שהזיהוי נכשל).</div>
  const pct = Math.max(0, Math.min(100, (positionSec / durationSec) * 100))
  const left = (sec: number) => `${(sec / durationSec) * 100}%`
  const wide = (a: number, b: number) => `max(3px, ${((b - a) / durationSec) * 100}%)`
  const draft = open ? { fromSec: Math.min(open.startSec, positionSec), toSec: Math.max(open.startSec, positionSec) } : null
  const regions = tag?.regions ?? []
  const guessNote = failedFor === contentHash ? 'חישוב ההצעות נכשל (אפשר לסמן ביד)' : !ready ? 'ההצעות של המחשב מתחשבות… (או שהשיר נטען לפני שהמתג הודלק — טען אותו שוב)' : !grid ? 'אין רשת פעימות לשיר הזה, אז אין הצעות' : `${cands?.length ?? 0} הצעות של ${bars} תיבות`
  const hits = cands ? cands.filter((c) => overlapsMark(c, regions)).length : 0
  const none = !!contentHash && noneFor === contentHash
  const btn = 'rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-grid-muted disabled:opacity-40'
  return (
    <div className="flex shrink-0 flex-col gap-0.5" data-sample-strip={deckId}>
      <div className="flex items-center gap-1">
        <div className="relative flex flex-1 flex-col gap-px" role="img" aria-label="פס קטעים: למעלה הצעות המחשב, למטה הסימונים שלך">
          <div className="relative h-1.5 overflow-hidden rounded-[2px] bg-black" data-sample-guesses>
            {cands?.map((c) => (
              <div
                key={`${c.fromSec}`}
                title={`${c.bars} תיבות · דמיון לבלוק הבא ${c.score.toFixed(2)}`}
                className="absolute inset-y-0"
                style={{ left: left(c.fromSec), width: wide(c.fromSec, c.toSec), background: GUESS, opacity: Math.max(0.2, Math.min(1, c.score)) }}
              />
            ))}
          </div>
          <div className="relative h-2 overflow-hidden rounded-[2px] bg-black" data-sample-marks>
            {[...regions, ...(draft && open ? [{ ...draft, kind: open.kind }] : [])].map((r, i) => (
              <div key={i} data-sample-kind={r.kind} className="absolute inset-y-0" style={{ left: left(r.fromSec), width: wide(r.fromSec, r.toSec), background: r.kind === 'loop' ? LOOP : HIT }} />
            ))}
            <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/50" style={{ width: `${pct}%` }} />
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: `${pct}%` }} />
        </div>
        <span className="invisible"><HintIcon id="deck.vocalStrip" /></span>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs" data-sample-controls={deckId}>
        <button type="button" onClick={() => void ctl.toggleSampleMark(deckId, 'loop')} className={`rounded-[var(--radius-sm)] px-2 py-1 font-semibold ${open?.kind === 'loop' ? 'bg-white text-black' : 'bg-surface-2 text-white'}`} style={open ? undefined : { boxShadow: `inset 0 0 0 1px ${LOOP}` }} disabled={!!open && open.kind !== 'loop'}>
          {open?.kind === 'loop' ? 'נגמר הלופ' : 'התחיל לופ'}
        </button>
        <button type="button" onClick={() => void ctl.toggleSampleMark(deckId, 'hit')} className={`rounded-[var(--radius-sm)] px-2 py-1 font-semibold ${open?.kind === 'hit' ? 'bg-white text-black' : 'bg-surface-2 text-white'}`} style={open ? undefined : { boxShadow: `inset 0 0 0 1px ${HIT}` }} disabled={!!open && open.kind !== 'hit'}>
          {open?.kind === 'hit' ? 'נגמרה הקשה' : 'התחילה הקשה'}
        </button>
        <button type="button" onClick={() => void ctl.undoSampleMark(deckId)} disabled={!open && regions.length === 0} className={btn} title="מבטל סימון פתוח, ואם אין כזה — את הסימון האחרון.">
          ביטול
        </button>
        <select value={bars} onChange={(e) => setBars(Number(e.target.value))} className="rounded-[var(--radius-sm)] bg-surface-2 px-1 py-1 text-grid-muted" title="באיזה אורך המחשב מציע קטעים">
          {BARS_CHOICES.map((b) => (
            <option key={b} value={b}>
              {b} תיבות
            </option>
          ))}
        </select>
        <button type="button" onClick={() => ctl.seekNextSampleCandidate(deckId, bars)} className={btn} title="קופץ להצעה הבאה של המחשב, כדי שתשמע מה הוא בחר.">
          הצעה הבאה
        </button>
        {!tag?.finished ? (
          <>
            {regions.length === 0 && !open && (
              <label className="flex cursor-pointer items-center gap-1 px-1 text-grid-muted" title="סמן אם אין בשיר הזה אף קטע ששווה לשמור: אז אפשר לסיים בלי לסמן כלום.">
                <input type="checkbox" checked={none} onChange={(e) => setNoneFor(e.target.checked ? contentHash : null)} />
                אין בשיר קטע לשמור
              </label>
            )}
            <button type="button" disabled={!none && !open && regions.length === 0} onClick={() => void ctl.finishSampleMarks(deckId)} className={btn} title="אחרי הלחיצה, כל מה שלא סימנת בשיר הזה נחשב 'לא שווה לשמור', וההצעות של המחשב נשמרות לצד הסימונים שלך להשוואה.">
              סיימתי לסמן את השיר
            </button>
          </>
        ) : (
          <>
            <span className="font-semibold" style={{ color: LOOP }}>✓ השיר סומן כגמור</span>
            <button type="button" onClick={() => void ctl.reopenSampleMarks(deckId)} className={btn}>
              פתח שוב
            </button>
          </>
        )}
        <button
          type="button"
          className="rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 text-warn"
          onClick={() => {
            if (!confirmClear) return setConfirmClear(true)
            setConfirmClear(false)
            void ctl.clearSampleMarks(deckId)
          }}
          onBlur={() => setConfirmClear(false)}
          disabled={regions.length === 0 && !tag}
        >
          {confirmClear ? 'בטוח? לחץ שוב — הסימונים נמחקים' : 'מחק סימוני קטעים'}
        </button>
        <button type="button" onClick={() => void ctl.exportSampleMarks()} className={btn} title="שומר את סימוני הקטעים של כל השירים לקובץ חדש.">
          ייצא סימוני קטעים
        </button>
        <span className="text-grid-muted" data-sample-note>
          קטעים: {regions.length} · {guessNote}
          {cands && regions.length > 0 ? ` · ${hits} מההצעות נוגעות בסימון שלך` : ''}
        </span>
      </div>
    </div>
  )
}
