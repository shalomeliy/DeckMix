import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ctl from '@/controls'
import { pickBarSample, pickVocalSample, type BarAnswer, type SampleEntry, type VocalAnswer } from '@/core/tagging'
import { useStore } from '@/app/state/store'
import { Button } from '@/app/components/controls'

/**
 * Tagging (v0.9.0): Shalom marks which beat is the "1", and whether a short
 * clip has vocals, on a sample the app picks — the answers the bar and vocal
 * detectors will be graded against. Text in Hebrew, layout LTR (the 02/09
 * interface decision); `dir="rtl"` only on the Hebrew sentences themselves,
 * so their punctuation lands on the right side.
 *
 * Behind Settings › Library › Tagging, off by default — this screen covers
 * the decks, so it has no place in a live set (Shalom, 25/09).
 */

type Mode = 'bar' | 'vocal'
type Loaded = Awaited<ReturnType<typeof ctl.tagPrepare>>

const BEAT_NAMES = ['1', '2', '3', '4']

function He({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <p dir="rtl" className={`text-right ${className}`}>
      {children}
    </p>
  )
}

export function TaggingScreen({ onClose }: { onClose: () => void }) {
  const tracks = useStore((s) => s.library.tracks)
  const barSample = useMemo(() => pickBarSample(tracks), [tracks])
  const vocalSample = useMemo(() => pickVocalSample(tracks), [tracks])
  const [mode, setMode] = useState<Mode>('bar')
  /** contentHash and trackId of every stored tag, per kind — `null` until read, and nothing can be answered before that. */
  const [taggedBar, setTaggedBar] = useState<Set<string> | null>(null)
  const [taggedVocal, setTaggedVocal] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)
  const recording = useStore((s) => s.recording.active != null)
  /** Tracks skipped this session because they could not be opened — shown, never silently dropped. */
  const [failed, setFailed] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [current, setCurrent] = useState<Loaded>(null)
  const [busy, setBusy] = useState(false)
  const [spot, setSpot] = useState(0)
  const [loudBeat, setLoudBeat] = useState<number | null>(null)
  /**
   * Bumped by every open and every tab switch. Opening a song takes seconds
   * (read, decode, analyse); one still in flight when the tab changes must not
   * land its song on the other tab — found by verify-tagging.mjs, where a bar
   * song showed up under the vocal buttons.
   */
  const openSeq = useRef(0)

  // Esc closes, and closing stops the sound — same as the other full screens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      ctl.tagClose()
    }
  }, [onClose])

  const refreshTagged = useCallback(async () => {
    const all = await ctl.tagLoadAll()
    if (!all) return
    setTaggedBar(new Set(all.bar.flatMap((t) => [t.contentHash, t.trackId])))
    setTaggedVocal(new Set(all.vocal.flatMap((t) => [t.contentHash, t.trackId])))
  }, [])
  useEffect(() => {
    void refreshTagged()
  }, [refreshTagged])

  const sample = mode === 'bar' ? barSample : vocalSample
  // A rescan mid-session gives a new sample; the old position would point
  // into it at random, skipping or repeating songs. Keyed on the song list,
  // not the array: the library array changes on every analysis update, and
  // resetting on that threw away the song being opened.
  const sampleKey = sample.map((e) => e.trackId).join('|')
  useEffect(() => {
    openSeq.current++
    setCurrent(null)
    setBusy(false)
    setIndex(0)
  }, [sampleKey])
  const tagged = mode === 'bar' ? taggedBar : taggedVocal

  /** Next sample entry not yet answered, from `from` on. A track the library already hashed is checked without opening it. */
  const nextOpen = useCallback(
    (from: number): number => {
      for (let i = from; i < sample.length; i++) {
        const t = tracks.find((x) => x.id === sample[i].trackId)
        if (tagged?.has(sample[i].trackId) || (t?.contentHash && tagged?.has(t.contentHash))) continue
        return i
      }
      return sample.length
    },
    [sample, tracks, tagged],
  )

  const open = useCallback(
    async (from: number) => {
      ctl.tagStop()
      setLoudBeat(null)
      setSpot(0)
      setCurrent(null)
      const seq = ++openSeq.current
      let i = nextOpen(from)
      setBusy(true)
      while (i < sample.length) {
        const entry: SampleEntry = sample[i]
        const view = await ctl.tagPrepare(entry, { needGrid: mode === 'bar' })
        if (seq !== openSeq.current) return
        if (view && !tagged?.has(view.contentHash)) {
          setIndex(i)
          setCurrent(view)
          setBusy(false)
          return
        }
        if (!view) setFailed((f) => [...f, entry.trackId])
        i = nextOpen(i + 1)
      }
      setIndex(sample.length)
      setBusy(false)
    },
    [nextOpen, sample, mode, tagged],
  )

  // One answer at a time: a double-click would save twice and open twice.
  const answer = async (save: (hash: string) => Promise<boolean>) => {
    if (!current || saving) return
    ctl.tagStop()
    setSaving(true)
    const saved = await save(current.contentHash)
    setSaving(false)
    if (saved) {
      await refreshTagged()
      void open(index + 1)
    }
  }
  const answerBar = (a: BarAnswer) => answer((h) => ctl.tagSaveBar(h, a))
  const answerVocal = (a: VocalAnswer) => answer((h) => ctl.tagSaveVocal(h, a))

  // Within this sample, by the row each tag was sampled as — a count of every
  // stored tag could pass M after a rescan or a genre change (v0.9.0 review).
  const doneCount = tagged == null ? null : sample.filter((e) => tagged.has(e.trackId)).length
  // The app's notice bar sits under this screen, so its own notices are repeated here.
  const notice = useStore((s) => (s.notice?.source === 'tagging' ? s.notice : null))

  const switchMode = (m: Mode) => {
    openSeq.current++
    ctl.tagStop()
    setCurrent(null)
    setBusy(false)
    setIndex(0)
    setMode(m)
  }

  const playBeat = (b: number) => {
    setLoudBeat(b)
    ctl.tagPlayBars(spot, b)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Tagging" className="absolute inset-0 z-40 flex flex-col bg-surface-0/97 backdrop-blur-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-bold tracking-tight">תיוג</h2>
        <div className="flex gap-1">
          <Button variant="toggle" active={mode === 'bar'} size="sm" onClick={() => switchMode('bar')}>
            איפה ה-1
          </Button>
          <Button variant="toggle" active={mode === 'vocal'} size="sm" onClick={() => switchMode('vocal')}>
            שירה
          </Button>
        </div>
        <span className="tnum text-xs text-grid-muted" data-testid="tag-count">
          {doneCount == null ? '…' : `תויגו ${doneCount} מתוך ${sample.length}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void ctl.tagExport()}>
            ייצוא לקובץ
          </Button>
          <span className="text-2xs text-grid-dim">Esc לסגירה</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            סגירה
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4 text-sm">
        {recording && (
          <He className="mb-3 text-warn">שים לב: יש הקלטה פעילה, והצליל של מסך התיוג (כולל התקתוקים) נכנס אליה.</He>
        )}
        {sample.length === 0 && (
          <He className="text-grid-muted">
            אין שירים לתייג: צריך ספרייה פתוחה, עם שירים בתיקיות של ז'אנרים (House, Techno וכו').
          </He>
        )}

        {sample.length > 0 && !current && !busy && (
          <div className="mx-auto max-w-xl space-y-3">
            {mode === 'bar' ? (
              <>
                <He>האפליקציה בחרה {sample.length} שירים, בערך אותו מספר מכל ז'אנר.</He>
                <He>בכל שיר תשמע קטע קצר שחוזר על עצמו, עם תקתוק על כל פעימה. אחד התקתוקים חזק יותר. אתה בוחר איזה תקתוק חזק נופל על ה-"1": על הרגע הגדול, שבו הדרופ נכנס, השירה מתחילה או המצילה מכה.</He>
                <He className="text-grid-muted">לא בטוח? דלג. דילוג לא נחשב טעות.</He>
              </>
            ) : (
              <>
                <He>בכל שיר תשמע 5 שניות. ענה אם יש בהן שירה (קול של זמר או זמרת) או לא.</He>
                <He className="text-grid-muted">"לא בטוח" זו תשובה טובה, לא טעות.</He>
              </>
            )}
            {index >= sample.length && doneCount != null ? (
              <He className="font-bold">סיימת את כל השירים בחלק הזה. אפשר לייצא לקובץ.</He>
            ) : (
              <div dir="rtl" className="text-right">
                <Button variant="toggle" active disabled={doneCount == null} onClick={() => void open(index)}>
                  {doneCount ? 'להמשיך' : 'להתחיל'}
                </Button>
              </div>
            )}
          </div>
        )}

        {busy && <He className="text-grid-muted">פותח את השיר ומנתח אותו…</He>}

        {current && mode === 'bar' && (
          <div className="mx-auto max-w-xl space-y-4">
            <div>
              <div className="text-base font-bold">{current.name}</div>
              <div className="text-2xs text-grid-muted">
                {current.genre}
                {current.bpm ? ` · ${current.bpm.toFixed(1)} BPM` : ''}
                {current.holdout ? ' · מבחן סופי' : ''}
              </div>
            </div>
            {current.bpm == null ? (
              <He className="text-warn">לשיר הזה אין עדיין רשת פעימות, אז אי אפשר לתייג אותו. דלג.</He>
            ) : (
              <>
                <He>לחץ על כל אחד מהכפתורים והקשב: איפה התקתוק החזק נופל על ה-"1"? תספור בראש 1-2-3-4. הדרופ כמעט תמיד נכנס על 1.</He>
                <div className="flex justify-center gap-2" data-testid="beat-buttons">
                  {BEAT_NAMES.map((n, b) => (
                    <Button key={b} variant="toggle" active={loudBeat === b} onClick={() => playBeat(b)}>
                      חזק על {n}
                    </Button>
                  ))}
                </div>
                <div className="flex justify-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => ctl.tagStop()}>
                    עצור
                  </Button>
                  {current.spots.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const s = (spot + 1) % current.spots.length
                        setSpot(s)
                        if (loudBeat != null) ctl.tagPlayBars(s, loudBeat)
                      }}
                    >
                      מקום אחר בשיר ({spot + 1}/{current.spots.length})
                    </Button>
                  )}
                </div>
                <div className="flex justify-center">
                  <Button variant="toggle" active disabled={loudBeat == null || saving} onClick={() => loudBeat != null && void answerBar(loudBeat as BarAnswer)}>
                    זה ה-1 ✓
                  </Button>
                </div>
              </>
            )}
            <div className="flex justify-center gap-2 border-t border-hairline pt-3">
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => void answerBar('skip')}>
                לא בטוח, דלג
              </Button>
              {current.bpm != null && (
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => void answerBar('wrongTempo')}>
                  התקתוקים לא על הקצב
                </Button>
              )}
            </div>
          </div>
        )}

        {current && mode === 'vocal' && (
          <div className="mx-auto max-w-xl space-y-4">
            <div>
              <div className="text-base font-bold">{current.name}</div>
              <div className="text-2xs text-grid-muted">
                {current.genre}
                {current.holdout ? ' · מבחן סופי' : ''}
              </div>
            </div>
            <div className="flex justify-center">
              <Button variant="ghost" onClick={() => ctl.tagPlayVocal()}>
                ▶ נגן 5 שניות
              </Button>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="toggle" active disabled={saving} onClick={() => void answerVocal('yes')}>
                יש שירה
              </Button>
              <Button variant="toggle" active disabled={saving} onClick={() => void answerVocal('no')}>
                אין שירה
              </Button>
              <Button variant="ghost" disabled={saving} onClick={() => void answerVocal('unsure')}>
                לא בטוח
              </Button>
            </div>
          </div>
        )}

        {notice && (
          <He className={`mt-6 text-xs ${notice.tone === 'warn' ? 'text-warn' : 'text-grid-muted'}`}>{notice.text}</He>
        )}
        {failed.length > 0 && (
          <He className="mt-6 text-2xs text-warn">
            {failed.length} שירים לא נפתחו ודולגו (הסיבה של האחרון כתובה למעלה): {failed.join(', ')}
          </He>
        )}
      </div>
    </div>
  )
}
