import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ctl from '@/controls'
import {
  FINE_STEP_SEC,
  VIEW_BARS,
  pickBarSample,
  VOCAL_CLIPS_PER_SONG,
  firstUnansweredClip,
  pickVocalSample,
  pickVocalRound2Sample,
  vocalClipsAnswered,
  vocalSongsDone,
  pickVocalReview,
  reviewSongsDone,
  reviewSummary,
  pickFreshSample,
  disputedSongs,
  neutralSec,
  snapToBeat,
  type MarkAnswer,
  type SampleEntry,
  type VocalAnswer,
  type VocalReviewTag,
  type VocalTag,
} from '@/core/tagging'
import { BEATS_PER_BAR } from '@/core/beatgrid'
import { useStore } from '@/app/state/store'
import { Button } from '@/app/components/controls'
import { TagWaveform } from '@/app/components/TagWaveform'
import { ClipSpectrogram } from '@/app/components/ClipSpectrogram'

/**
 * Tagging (v0.9.0): Shalom marks where the "1" is, and whether a short clip
 * has vocals, on a sample the app picks — the answers the bar and vocal
 * detectors will be graded against. Since v0.9.1 the "1" is a yellow marker
 * he drags on the song's waveform, snapping to the nearest beat; v0.9.0's
 * four "loud on N" buttons made him hear a loop and never see the drop, and
 * he said "I think we are missing" (26/09). Text in Hebrew, layout LTR (the 02/09
 * interface decision); `dir="rtl"` only on the Hebrew sentences themselves,
 * so their punctuation lands on the right side.
 *
 * Behind Settings › Library › Tagging, off by default — this screen covers
 * the decks, so it has no place in a live set (Shalom, 25/09).
 */

/**
 * 'decide' (v0.12.8) is the blind tie-break: the songs whose two "1" answers
 * disagree, opened with no marker at all — no computer's guess and no earlier
 * answer on screen — so the third look is not pulled toward either.
 */
/**
 * 'fresh' (v0.9.5) is the same blind marking, on House/Techno/Trance songs no
 * "1" was ever given for — the fair test of a detector tuned on the 105 others.
 */
type Mode = 'bar' | 'decide' | 'fresh' | 'vocal' | 'vocal2' | 'review'
type Loaded = Awaited<ReturnType<typeof ctl.tagPrepare>>

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
  const vocal2Sample = useMemo(() => pickVocalRound2Sample(tracks), [tracks])
  const [mode, setMode] = useState<Mode>('bar')
  /** contentHash and trackId of every stored tag, per kind — `null` until read, and nothing can be answered before that. */
  const [taggedBar, setTaggedBar] = useState<Set<string> | null>(null)
  const [taggedVocal, setTaggedVocal] = useState<Set<string> | null>(null)
  const [taggedDecide, setTaggedDecide] = useState<Set<string> | null>(null)
  /** Computed from the stored answers, so it is the same list on every open and in every browser that has them. */
  const [decideSample, setDecideSample] = useState<SampleEntry[]>([])
  /** Every song that already has a "1" answer (any round) — what the fresh round leaves out. `null` until read. */
  const [answeredEver, setAnsweredEver] = useState<Set<string> | null>(null)
  const [taggedFresh, setTaggedFresh] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)
  const recording = useStore((s) => s.recording.active != null)
  /** Tracks skipped this session because they could not be opened — shown, never silently dropped. */
  const [failed, setFailed] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [current, setCurrent] = useState<Loaded>(null)
  const [busy, setBusy] = useState(false)
  /** Which drop spot the marker was last put on — "another place in the song" steps through them. */
  const [spot, setSpot] = useState(0)
  /** Which of the song's three vocal clips is up (v0.9.10). */
  const [clip, setClip] = useState(0)
  const vocalTags = useRef<readonly { contentHash: string; clipIndex?: number }[]>([])
  /** Every first-pass vocal answer and every re-check answer — the re-check list is computed from the first, and done-ness from the second. */
  const [allVocal, setAllVocal] = useState<readonly VocalTag[]>([])
  const [reviewTags, setReviewTags] = useState<readonly VocalReviewTag[]>([])
  const [markSec, setMarkSec] = useState<number | null>(null)
  const [viewStart, setViewStart] = useState(0)
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [oldBarCount, setOldBarCount] = useState<number | null>(null)
  /** Presses of "play from here", and when the song appeared — both saved with the answer. */
  const plays = useRef(0)
  const openedAt = useRef(0)
  const raf = useRef(0)
  /** Mirrors of `markSec` and `playhead` for the key listener — see there. */
  const markRef = useRef<number | null>(null)
  const playheadRef = useRef<number | null>(null)
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
      cancelAnimationFrame(raf.current)
      ctl.tagClose()
    }
  }, [onClose])

  const refreshTagged = useCallback(async () => {
    const all = await ctl.tagLoadAll()
    if (!all) return
    // The "1" counts only the waveform tags: every song is tagged again (26/09), and the 4-button answers stay beside them.
    setTaggedBar(new Set(all.mark.flatMap((t) => [t.contentHash, t.trackId])))
    setOldBarCount(all.bar.length)
    vocalTags.current = all.vocal
    setAllVocal(all.vocal)
    setReviewTags(all.vocalReview)
    // A song is done only when all its clips are: a half-answered one reopens on the first missing clip.
    setTaggedVocal(vocalSongsDone(all.vocal))
    setTaggedDecide(new Set(all.decide.flatMap((t) => [t.contentHash, t.trackId])))
    setDecideSample(disputedSongs(all.bar, all.mark))
    setTaggedFresh(new Set(all.fresh.flatMap((t) => [t.contentHash, t.trackId])))
    // Fresh-round answers stay in: a song answered there is still part of the round, counted as done — not dropped from it.
    setAnsweredEver((prev) => prev ?? new Set([...all.mark, ...all.decide, ...all.bar].flatMap((t) => [t.contentHash, t.trackId])))
  }, [])
  useEffect(() => {
    void refreshTagged()
  }, [refreshTagged])

  const reviewPlan = useMemo(() => pickVocalReview(allVocal, new Set(tracks.map((t) => t.id))), [allVocal, tracks])
  const taggedReview = useMemo(() => (taggedVocal ? reviewSongsDone(reviewPlan, reviewTags) : null), [taggedVocal, reviewPlan, reviewTags])
  const reviewClipTotal = [...reviewPlan.clipsByTrack.values()].reduce((n, c) => n + c.length, 0)
  const reviewDanceClips = [...reviewPlan.clipsByTrack.values()].flat().filter((c) => c.group === 'dance').length
  const freshSample = useMemo(() => (answeredEver ? pickFreshSample(tracks, answeredEver) : []), [tracks, answeredEver])
  const sample = mode === 'bar' ? barSample : mode === 'decide' ? decideSample : mode === 'fresh' ? freshSample : mode === 'vocal2' ? vocal2Sample : mode === 'review' ? reviewPlan.entries : vocalSample
  const isVocal = mode === 'vocal' || mode === 'vocal2' || mode === 'review'
  const isBar = !isVocal
  const blind = mode === 'decide' || mode === 'fresh'
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
  // Both vocal rounds share one set: a song is done once all its clips are answered.
  const tagged = mode === 'bar' ? taggedBar : mode === 'decide' ? taggedDecide : mode === 'fresh' ? taggedFresh : mode === 'review' ? taggedReview : taggedVocal

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

  const stopSound = useCallback(() => {
    ctl.tagStop()
    cancelAnimationFrame(raf.current)
    playheadRef.current = null
    setPlayhead(null)
  }, [])

  const open = useCallback(
    async (from: number) => {
      stopSound()
      setSpot(0)
      setCurrent(null)
      const seq = ++openSeq.current
      let i = nextOpen(from)
      setBusy(true)
      while (i < sample.length) {
        const entry: SampleEntry = sample[i]
        const view = await ctl.tagPrepare(entry, {
          needGrid: !isVocal,
          suspectClips: mode === 'vocal2',
          reviewClips: mode === 'review' ? reviewPlan.clipsByTrack.get(entry.trackId) : undefined,
        })
        if (seq !== openSeq.current) return
        if (view && !tagged?.has(view.contentHash)) {
          setIndex(i)
          setCurrent(view)
          if (mode === 'review') {
            const asked = reviewPlan.clipsByTrack.get(entry.trackId) ?? []
            const have = new Set(reviewTags.filter((t) => t.contentHash === view.contentHash).map((t) => t.clipIndex))
            setClip(Math.max(0, asked.findIndex((c) => !have.has(c.clipIndex))))
          } else setClip(Math.min(VOCAL_CLIPS_PER_SONG - 1, firstUnansweredClip(vocalClipsAnswered(vocalTags.current, view.contentHash))))
          const first = view.marks[0] ?? null
          const start = blind ? null : first
          markRef.current = start
          setMarkSec(start)
          const centre = first != null && view.grid && blind ? neutralSec(first, entry.trackId, view.grid.bpm, view.durationSec) : first
          if (view.grid && centre != null) setViewStart(viewStartFor(centre, view.grid.bpm, view.durationSec))
          plays.current = 0
          openedAt.current = performance.now()
          setBusy(false)
          return
        }
        if (!view) setFailed((f) => [...f, entry.trackId])
        i = nextOpen(i + 1)
      }
      setIndex(sample.length)
      setBusy(false)
    },
    [nextOpen, sample, mode, isVocal, blind, tagged, stopSound, reviewPlan, reviewTags],
  )

  // One answer at a time: a double-click would save twice and open twice.
  const answer = async (save: (hash: string) => Promise<boolean>) => {
    if (!current || saving) return
    stopSound()
    setSaving(true)
    const saved = await save(current.contentHash)
    setSaving(false)
    if (saved) {
      await refreshTagged()
      void open(index + 1)
    }
  }
  const answerMark = (a: MarkAnswer) =>
    answer((h) =>
      ctl.tagSaveMark(h, {
        answer: a,
        markSec: a === 'marked' ? markSec : null,
        startMarkSec: blind ? null : (current?.marks[spot] ?? null),
        answerMs: performance.now() - openedAt.current,
        plays: plays.current,
        round: mode === 'decide' ? 'decide' : mode === 'fresh' ? 'fresh' : undefined,
      }),
    )
  const answerVocal = async (a: VocalAnswer) => {
    if (!current || saving) return
    stopSound()
    setSaving(true)
    const asked = mode === 'review' ? reviewPlan.clipsByTrack.get(sample[index]?.trackId ?? '') : undefined
    if (mode === 'review' && !asked?.[clip]) {
      setSaving(false)
      return
    }
    const saved = asked ? await ctl.tagSaveVocalReview(current.contentHash, a, asked[clip]) : await ctl.tagSaveVocal(current.contentHash, a, clip)
    setSaving(false)
    if (!saved) return
    await refreshTagged()
    // The next clip of the same song, without decoding it again; after the last one, the next song.
    if (clip + 1 < (asked ? asked.length : VOCAL_CLIPS_PER_SONG)) setClip(clip + 1)
    else void open(index + 1)
  }

  // Within this sample, by the row each tag was sampled as — a count of every
  // stored tag could pass M after a rescan or a genre change (v0.9.0 review).
  const doneCount = tagged == null ? null : sample.filter((e) => tagged.has(e.trackId)).length
  // The app's notice bar sits under this screen, so its own notices are repeated here.
  const notice = useStore((s) => (s.notice?.source === 'tagging' ? s.notice : null))

  const switchMode = (m: Mode) => {
    openSeq.current++
    stopSound()
    setCurrent(null)
    setBusy(false)
    setIndex(0)
    setMode(m)
  }

  const grid = isBar ? (current?.grid ?? null) : null
  const entryNow: SampleEntry | undefined = sample[index]
  /** Where unmarked playing and the first arrow press start: the drop's computer "1" in bar mode, shifted 0–3 beats in the blind tie-break. */
  const startSecAt = useCallback(
    (spotIdx: number): number | null => {
      const at = current?.marks[spotIdx]
      if (at == null || !current || !grid) return null
      return blind && entryNow ? neutralSec(at, entryNow.trackId, grid.bpm, current.durationSec) : at
    },
    [current, grid, blind, entryNow],
  )
  const viewLen = grid ? viewLenFor(grid.bpm, current?.durationSec ?? 0) : 0

  /**
   * Every marker move goes through here. It stops the sound: the clicks were
   * laid on the old marker, and hearing them against the new one would
   * sound like a wrong answer.
   *
   * Out of the song it steps back by whole beats, never clamps: clamping to 0
   * put the marker 0.2 s off every beat and saved that as the grid (v0.9.1
   * review). The window follows only keyboard moves (`follow`), and only near
   * its edge: following a mouse re-centred the view under the pointer, which
   * then pointed further along, and a drag ran off to the end of the song.
   */
  const moveMark = useCallback(
    (sec: number, follow: boolean) => {
      if (!current || !grid) return
      const beatSec = 60 / grid.bpm
      let t = sec
      while (t < 0) t += beatSec
      while (t > current.durationSec) t -= beatSec
      stopSound()
      markRef.current = t
      setMarkSec(t)
      if (follow) setViewStart((v) => (t < v + viewLen * 0.1 || t > v + viewLen * 0.9 ? viewStartFor(t, grid.bpm, current.durationSec) : v))
    },
    [current, grid, viewLen, stopSound],
  )

  /** `accent: false` = nothing marked yet on the blind tie-break — even clicks, none of them loud. */
  const play = useCallback((fromSec: number, accent: boolean) => {
    if (!ctl.tagPlayFrom(fromSec, accent)) return
    plays.current++
    cancelAnimationFrame(raf.current)
    const tick = () => {
      const p = ctl.tagPlayheadSec()
      playheadRef.current = p
      setPlayhead(p)
      if (p != null) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [])

  // Arrows move the marker, Space plays or stops. Space is also taken on key
  // UP: a button still focused from the last click would otherwise be
  // pressed by it — the browser clicks a focused button on Space's release.
  // The marker and playhead are read from refs: as dependencies, the playhead
  // re-registered these listeners every frame of playback, and two quick
  // arrow presses could read the same stale marker (v0.9.1 review).
  useEffect(() => {
    if (isVocal || !current || !grid) return
    const beatSec = 60 / grid.bpm
    const onKey = (e: KeyboardEvent) => {
      const m = markRef.current
      // Unmarked (the blind tie-break): Space still plays, from the drop, with even clicks; arrows have nothing to move.
      const from = m ?? startSecAt(spot)
      if (from == null) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        // Unmarked (tie-break): the first press puts the "1" on the neutral start, so the keyboard alone can answer.
        moveMark(m == null ? from : m + dir * (e.shiftKey ? FINE_STEP_SEC : beatSec), true)
      } else if (e.key === ' ') {
        e.preventDefault()
        if (!e.repeat) {
          if (playheadRef.current != null) stopSound()
          else play(from, m != null)
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [isVocal, current, grid, spot, startSecAt, moveMark, play, stopSound])

  // Vocal keys (v0.9.11). Physical keys (`e.code`), not letters: the owner types Hebrew, and a letter shortcut would
  // change meaning with the keyboard layout. A key held down must not answer a whole song's clips in one press.
  useEffect(() => {
    if (!isVocal || !current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        ctl.tagPlayVocal(clip)
      } else if (e.code === 'Digit1' || e.code === 'Numpad1') void answerVocal('yes')
      else if (e.code === 'Digit2' || e.code === 'Numpad2') void answerVocal('no')
      else if (e.code === 'Digit3' || e.code === 'Numpad3') void answerVocal('unsure')
    }
    // A button still focused from the last click would be pressed by Space's release.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  })

  // The picture is for the clip on screen; `current` changes with every song and `clip` with every clip.
  const vocalSpec = useMemo(() => (isVocal && current ? ctl.tagClipSpectrogram(clip) : null), [isVocal, current, clip])

  return (
    <div role="dialog" aria-modal="true" aria-label="Tagging" className="absolute inset-0 z-40 flex flex-col bg-surface-0/97 backdrop-blur-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-bold tracking-tight">תיוג</h2>
        <div className="flex gap-1">
          <Button variant="toggle" active={mode === 'bar'} size="sm" onClick={() => switchMode('bar')}>
            איפה ה-1
          </Button>
          {(decideSample.length > 0 || mode === 'decide') && (
            <Button variant="toggle" active={mode === 'decide'} size="sm" onClick={() => switchMode('decide')}>
              הכרעה ({decideSample.length})
            </Button>
          )}
          {(freshSample.length > 0 || mode === 'fresh') && (
            <Button variant="toggle" active={mode === 'fresh'} size="sm" onClick={() => switchMode('fresh')}>
              סבב חדש ({freshSample.length})
            </Button>
          )}
          <Button variant="toggle" active={mode === 'vocal'} size="sm" onClick={() => switchMode('vocal')}>
            שירה
          </Button>
          <Button variant="toggle" active={mode === 'vocal2'} size="sm" onClick={() => switchMode('vocal2')}>
            שירה – סבב שני ({vocal2Sample.length})
          </Button>
          {(reviewClipTotal > 0 || mode === 'review') && (
            <Button variant="toggle" active={mode === 'review'} size="sm" onClick={() => switchMode('review')}>
              בדיקה חוזרת ({reviewClipTotal})
            </Button>
          )}
        </div>
        <span className="tnum text-xs text-grid-muted" data-testid="tag-count">
          {doneCount == null ? '…' : `${blind ? 'נענו' : 'תויגו'} ${doneCount} מתוך ${sample.length}`}
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
            {mode === 'fresh' ? (
              <>
                <He>
                  אלה {sample.length} השירים שעוד אף פעם לא סימנת בהם את ה-"1": קודם האוס, טכנו וטראנס, ואחריהם כל השאר. המחשב לא ראה אותם כשכיוונו
                  אותו, ולכן רק הם יכולים להגיד אם הוא באמת מגיע ל-95%.
                </He>
                <He>
                  כמו בהכרעה: כל שיר נפתח בלי קו צהוב ובלי שום ניחוש. לחץ על ה-"1" של הדרופ, ורק אז יופיע הקו. אם הקיק נופל באמצע בין שני קווים, סמן את
                  הפעימה שלפניו.
                </He>
                <He className="text-grid-muted">לא בטוח? דלג. דילוג לא נחשב טעות.</He>
              </>
            ) : mode === 'decide' ? (
              <>
                <He>
                  אלה {sample.length} השירים שבהם ה-"1" שסימנת על גלי הקול שונה מזה שבחרת עם 4 הכפתורים. כאן אתה מכריע.
                </He>
                <He>
                  כל שיר נפתח בלי קו צהוב ובלי שום ניחוש, רק קווים דקים על כל פעימה. לחץ על הרגע הגדול, ורק אז יופיע הקו. אפשר לנגן גם לפני שסימנת: תשמע
                  תקתוק שווה על כל פעימה.
                </He>
                <He className="text-grid-muted">לא בטוח? דלג. דילוג לא נחשב טעות.</He>
              </>
            ) : mode === 'bar' ? (
              <>
                <He>האפליקציה בחרה {sample.length} שירים, בערך אותו מספר מכל ז'אנר.</He>
                <He>בכל שיר תראה את גלי הקול סביב הדרופ, וקו צהוב על ה-"1" שהמחשב מנחש. תזיז את הקו לרגע הגדול: שבו הדרופ נכנס, השירה מתחילה או המצילה מכה. "נגן מכאן" מנגן קצת לפני הקו, כדי שתשמע אותו נוחת.</He>
                <He className="text-grid-muted">לא בטוח? דלג. דילוג לא נחשב טעות.</He>
                {oldBarCount != null && oldBarCount > 0 && (
                  <He className="text-2xs text-grid-muted">
                    {oldBarCount} התשובות מהשיטה הקודמת (4 הכפתורים) שמורות בצד ונכנסות לקובץ הייצוא, כדי להשוות. כאן מתחילים מחדש.
                  </He>
                )}
              </>
            ) : mode === 'review' ? (
              <>
                <He>
                  בדיקה חוזרת, בלי רמז: קטעים שכבר ענית עליהם, ואתה שומע ורואה אותם שוב מההתחלה. קודם כל הקטעים של האוס וטכנו ({reviewDanceClips} קטעים), ואחריהם {reviewClipTotal - reviewDanceClips} אקראיים מהשאר, כי שם המחשב הכי פחות בטוח.
                </He>
                <He>
                  <b>ההחלטה שלך היא הקובעת.</b> לא מראים לך מה ענית קודם ולא מה המחשב חושב, ואין "תשובה נכונה" שצריך לנחש. מילה בודדת, שתי מילים או קול רקע חלש ליד שירה בולטת: לחץ <b>"לא בטוח"</b>, לא "אין שירה". ככה נדע אילו קטעים באמצע.
                </He>
                <He className="text-grid-muted">התשובות החדשות נשמרות בנפרד ולא מוחקות את הקודמות.</He>
                {reviewPlan.missing > 0 && (
                  <He className="text-2xs text-warn">
                    {reviewPlan.missing} קטעים לא נכנסו כי השיר שלהם כבר לא בספרייה.
                  </He>
                )}
              </>
            ) : mode === 'vocal2' ? (
              <>
                <He>
                  סבב שני: {sample.length} שירים חדשים. ריקודים (האוס, טכנו, טראנס) נכנסים כולם ראשונים בין השאר, ושאר הז'אנרים משלימים לפי הסדר; אפשר לעצור בכל רגע. בכל שיר 3 קטעים של 5 שניות. בערך חצי מהקטעים נבחרים במקומות שהמחשב חושב
                  שנשמעת שם שירה, והחצי השני אקראי, כדי שיהיו מספיק דוגמאות של שירה גם בריקודים.
                </He>
                <He className="text-grid-muted">
                  השירים האלה לא כוללים את שירי המבחן הסופי, והקטעים "החשודים" משמשים רק ללימוד, אף פעם לא למדידה. "לא בטוח" זו תשובה טובה.
                </He>
              </>
            ) : (
              <>
                <He>בכל שיר תשמע 5 שניות. ענה אם יש בהן שירה (קול של זמר או זמרת) או לא.</He>
                <He className="text-grid-muted">"לא בטוח" זו תשובה טובה, לא טעות.</He>
              </>
            )}
            {index >= sample.length && doneCount != null ? (
              <>
                <He className="font-bold">סיימת את כל השירים בחלק הזה. אפשר לייצא לקובץ.</He>
                {mode === 'review' && <ReviewSummary tags={reviewTags} />}
              </>
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

        {current && isBar && (
          <div className="mx-auto max-w-5xl space-y-3">
            <div>
              <div className="text-base font-bold">{current.name}</div>
              <div className="text-2xs text-grid-muted">
                {current.genre}
                {grid ? ` · ${grid.bpm.toFixed(1)} BPM` : ''}
                {current.holdout ? ' · מבחן סופי' : ''}
              </div>
            </div>
            {!grid || current.marks.length === 0 || !current.peaks ? (
              <He className="text-warn">לשיר הזה אין עדיין רשת פעימות, אז אי אפשר לסמן בו את ה-1. דלג.</He>
            ) : (
              <>
                <He>
                  {blind
                    ? markSec == null
                      ? 'לחץ על גלי הקול איפה שה-"1" של הדרופ נופל. הקו הצהוב יופיע שם, על הפעימה הכי קרובה.'
                      : 'אפשר להזיז את הקו בלחיצה, בגרירה או בחצים. הוא נדבק לפעימה הכי קרובה.'
                    : 'הקו הצהוב הוא הניחוש של המחשב ל-"1". אם הוא לא על הדרופ, לחץ על גלי הקול איפה שהדרופ נכנס, או גרור את הקו. הוא נדבק לפעימה הכי קרובה.'}
                </He>
                <TagWaveform
                  peaks={current.peaks}
                  bands={current.bands}
                  durationSec={current.durationSec}
                  bpm={grid.bpm}
                  markSec={markSec}
                  beatPhaseSec={grid.offsetSec}
                  viewStartSec={viewStart}
                  viewLenSec={viewLen}
                  playheadSec={playhead}
                  onPick={(sec) => moveMark(snapToBeat(sec, { bpm: grid.bpm, offsetSec: markSec ?? grid.offsetSec }), false)}
                />
                {blind && entryNow?.tempoDiffers && (
                  <He className="text-2xs text-warn">
                    בשיר הזה שתי התשובות שלך שונות גם בקצב, לא רק במקום של ה-1. אם התקתוקים לא יושבים על הקצב, לחץ "התקתוקים לא על הקצב".
                  </He>
                )}
                {current.replacesCorrection && !blind && (
                  <He className="text-2xs text-warn">
                    לשיר הזה יש כבר קו צהוב שהזזת בעבר, והקו כאן מתחיל במקום של המחשב. שמירה תחליף את הקו הישן.
                  </He>
                )}
                <He className="text-2xs text-grid-muted">
                  חצים ← → : פעימה אחת · Shift + חץ: הזזה קטנה, אם הפעימה עצמה לא יושבת על המכה · רווח: נגן / עצור
                </He>
                <div className="flex justify-center gap-2">
                  <Button
                    variant="toggle"
                    active={playhead != null}
                    onClick={() => (playhead != null ? stopSound() : play(markSec ?? startSecAt(spot) ?? current.marks[spot], markSec != null))}
                  >
                    {playhead != null ? '■ עצור' : markSec == null ? '▶ נגן' : '▶ נגן מכאן'}
                  </Button>
                  {current.marks.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const s2 = (spot + 1) % current.marks.length
                        setSpot(s2)
                        stopSound()
                        // Blind: only the view moves — putting the marker on the next drop would be the computer's guess again.
                        if (!blind) {
                          markRef.current = current.marks[s2]
                          setMarkSec(current.marks[s2])
                        }
                        setViewStart(viewStartFor(startSecAt(s2) ?? current.marks[s2], grid.bpm, current.durationSec))
                      }}
                    >
                      מקום אחר בשיר ({spot + 1}/{current.marks.length})
                    </Button>
                  )}
                  <Button variant="toggle" active disabled={saving || markSec == null} onClick={() => void answerMark('marked')}>
                    זה ה-1 ✓
                  </Button>
                </div>
                <He className="text-2xs text-grid-muted">
                  {markSec == null
                    ? 'בנגינה תשמע תקתוק שווה על כל פעימה. אחרי שתסמן, התקתוק על ה-"1" יהיה חזק.'
                    : 'בנגינה תשמע תקתוק על כל פעימה, ותקתוק חזק על כל "1" לפי הקו הצהוב.'}
                </He>
              </>
            )}
            <div className="flex justify-center gap-2 border-t border-hairline pt-3">
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => void answerMark('skip')}>
                לא בטוח, דלג
              </Button>
              {grid && (
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => void answerMark('wrongTempo')}>
                  התקתוקים לא על הקצב
                </Button>
              )}
            </div>
          </div>
        )}

        {current && isVocal && (
          <div className="mx-auto max-w-xl space-y-4">
            <div>
              <div className="text-base font-bold">{current.name}</div>
              <div className="text-2xs text-grid-muted">
                {current.genre}
                {current.holdout ? ' · מבחן סופי' : ''}
              </div>
            </div>
            <He className="text-xs text-grid-muted">
              קטע {clip + 1} מתוך {mode === 'review' ? (reviewPlan.clipsByTrack.get(sample[index]?.trackId ?? '')?.length ?? 0) : VOCAL_CLIPS_PER_SONG} של השיר הזה{mode === 'review' ? ' (בדיקה חוזרת)' : ''}.
              {mode === 'vocal2' && (current.clipPicks[clip] === 'suspect' ? ' (נבחר כי המחשב חושב ששרים שם)' : ' (נבחר אקראית)')}
            </He>
            {mode === 'vocal2' && !current.clipPicks.includes('suspect') && (
              <He className="text-2xs text-warn">
                המחשב לא מצא בשיר הזה מקום שנשמע לו כמו שירה, אז כל הקטעים אקראיים.
              </He>
            )}
            <He className="text-2xs text-grid-muted">
              {mode === 'review'
                ? '"יש שירה" = קול אנושי שרים או ראפ, שנשמע כקול מוביל או בולט. מילה בודדת, שתי מילים או קול רקע חלש = "לא בטוח". "אין שירה" = ממש אין קול אנושי.'
                : '"יש שירה" = קול אנושי שרים או ראפ, שנשמע כקול מוביל או בולט. קול רקע ("אוווו"), קטעי קול חתוכים וקריאות קצרות של פחות משנייה = "אין שירה". אם לא ברור — "לא בטוח".'}
            </He>
            <ClipSpectrogram spec={vocalSpec} />
            <He className="text-2xs text-grid-muted">
              שירה נראית כפסים אופקיים שמתנדנדים; תופים נראים כקו אנכי קצר. התמונה רק עוזרת — ההחלטה לפי מה ששומעים.
            </He>
            <div className="flex justify-center">
              <Button variant="ghost" onClick={() => ctl.tagPlayVocal(clip)}>
                ▶ נגן 5 שניות (רווח)
              </Button>
            </div>
            <div className="flex justify-center gap-2">
              <Button variant="toggle" active disabled={saving} onClick={() => void answerVocal('yes')}>
                יש שירה (1)
              </Button>
              <Button variant="toggle" active disabled={saving} onClick={() => void answerVocal('no')}>
                אין שירה (2)
              </Button>
              <Button variant="ghost" disabled={saving} onClick={() => void answerVocal('unsure')}>
                לא בטוח (3)
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

/** After the whole re-check list: how often the second answer was not the first — the owner's own consistency, and how many clips sit in the middle. */
function ReviewSummary({ tags }: { tags: readonly VocalReviewTag[] }) {
  const sum = reviewSummary(tags)
  const line = (label: string, g: { answered: number; differ: number; unsure: number }) =>
    g.answered === 0 ? null : (
      <He>
        {label}: {g.answered} קטעים. תשובה שונה מהפעם הקודמת ב-{g.differ} ({Math.round((100 * g.differ) / g.answered)}%), מהם "לא בטוח" {g.unsure}.
      </He>
    )
  return (
    <div className="space-y-1">
      {line('האוס וטכנו', sum.dance)}
      {line('שאר הז\'אנרים', sum.consistency)}
    </div>
  )
}

/** The waveform shows `VIEW_BARS` bars — or the whole song, if it is shorter than that. */
function viewLenFor(bpm: number, durationSec: number): number {
  return Math.min((VIEW_BARS * BEATS_PER_BAR * 60) / bpm, durationSec)
}

/** A window centred on `sec`, kept inside the song. */
function viewStartFor(sec: number, bpm: number, durationSec: number): number {
  const len = viewLenFor(bpm, durationSec)
  return Math.min(Math.max(sec - len / 2, 0), Math.max(0, durationSec - len))
}
