import { useEffect, useMemo, useRef, useState } from 'react'
import * as ctl from '@/controls'
import { LONG_PRESS_MS, PLATTER_SIZE } from '@/core/constants'
import { songEndSec } from '@/core/audible-end'
import { useSettings } from '@/app/hooks/useSettings'
import { useFlash } from '@/app/state/flash'
import { useStore } from '@/app/state/store'
import { getBadEntries } from '@/platform/mix-bad-idb/store'
import { getExcellentFollowUps } from '@/platform/mix-pairs-idb/store'
import { entriesOf } from '@/core/pair-entries'
import type { BadEntry } from '@/core/bad-mixes'
import type { DeckId } from '@/core/types'
import { heardSemitones, shiftCamelot } from '@/core/key-sync'
import { Button, Fader, HintIcon, Pill } from '@/app/components/controls'
import { BeatGridPanel } from '@/app/components/BeatGridPanel'
import { BarOneQueue } from '@/app/components/BarOneQueue'
import { PadGrid } from '@/app/components/PadGrid'
import { Platter } from '@/app/components/Platter'
import { TransitionPointsPanel } from '@/app/components/TransitionPointsPanel'
import { Waveform } from '@/app/components/Waveform'
import { WaveformOverview } from '@/app/components/WaveformOverview'
import { SampleStrip } from '@/app/components/SampleStrip'
import { VocalStrip } from '@/app/components/VocalStrip'

const DECK_COLOR: Record<DeckId, string> = { A: 'var(--color-deck-a)', B: 'var(--color-deck-b)' }

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function Deck({ deckId }: { deckId: DeckId }) {
  const deck = useStore((s) => s.decks[deckId])
  const compact = useStore((s) => s.libraryExpanded)
  const activeTransition = useStore((s) => s.activeTransition)
  const otherDeckId: DeckId = deckId === 'A' ? 'B' : 'A'
  const otherPlaying = useStore((s) => s.decks[otherDeckId].playing)
  const otherBands = useStore((s) => s.decks[otherDeckId].bands)
  const otherDurationSec = useStore((s) => s.decks[otherDeckId].durationSec)
  // Floored *in the selector*, not after — `useRenderLoop` writes the other
  // deck's raw `positionSec` every frame regardless of whether this panel is
  // showing anything, so selecting the raw value here would re-render this
  // whole Deck at frame rate any time the other deck plays. Selecting the
  // already-floored number means Zustand's own equality check only sees a
  // change once a second, matching the ~1s resolution the comparison itself
  // has (`TransitionPointsPanel`'s own energy contour).
  const otherPositionBucketSec = useStore((s) => Math.floor(s.decks[otherDeckId].positionSec))
  const otherAnalysisFailed = useStore((s) => s.decks[otherDeckId].track?.analysisState === 'failed')
  const color = DECK_COLOR[deckId]
  const loaded = !!deck.track
  // read from the library by id, not from the deck's snapshot of the track: the strip lands after the track was loaded
  const trackVocal = useStore((s) => (deck.track ? s.library.tracks.find((t) => t.id === deck.track?.id)?.vocal : undefined))
  // Mix Assist (v0.4.6): relevant exactly when this deck is the one about to
  // be brought in — loaded, not already playing, while the other deck is the
  // reference it would join against. Neither deck playing, or this one
  // already playing, and there is nothing to show a mix-in point for.
  // `!deck.loading` matters on its own: `loadTrackToDeck` (controls.ts)
  // leaves the *previous* track's `bands`/`beatGrid` in place until the new
  // one's decode finishes and patches everything atomically — without this
  // check, loading a new track over an already-eligible deck would keep
  // showing the outgoing track's candidate points during that window.
  // `!activeTransition`: since v0.8.14 a transition waits up to a bar with this
  // deck still paused — without it, the panel stayed clickable and each
  // extra click saved another "Mix in" pad.
  const showTransitionPoints = loaded && !deck.loading && !deck.playing && otherPlaying && !activeTransition
  // v0.9.15: both decks' voice for the handoff rows — his marks over the strip, as the vocal strip shows them. Re-read when a strip or a mark
  // lands, or a grid moves; not on every frame.
  const otherTrackVocal = useStore((s) => {
    const id = s.decks[otherDeckId].track?.id
    return id ? s.library.tracks.find((t) => t.id === id)?.vocal : undefined
  })
  const otherBeatGrid = useStore((s) => s.decks[otherDeckId].beatGrid)
  const otherTrack = useStore((s) => s.decks[otherDeckId].track)
  // v0.12.14: mixes the owner rated Bad (outgoing = the playing deck's song) — Mix Assist's panel leaves those rows out.
  const badMixesRev = useStore((s) => s.badMixesRev)
  const pairFromHash = otherTrack?.contentHash
  const pairToHash = deck.track?.contentHash
  const [badEntries, setBadEntries] = useState<BadEntry[]>([])
  // the same pair's Excellent entry seconds: first in the panel and marked (v0.12.15)
  const [excellentSecs, setExcellentSecs] = useState<number[]>([])
  const excellentPairsRev = useStore((s) => s.excellentPairsRev)
  useEffect(() => {
    let cancelled = false
    if (!pairFromHash || !pairToHash) {
      setBadEntries([])
      setExcellentSecs([])
      return
    }
    void getBadEntries(pairFromHash, pairToHash).then((b) => {
      if (!cancelled) setBadEntries(b)
    })
    void getExcellentFollowUps(pairFromHash).then((f) => {
      const pair = f.find((p) => p.toHash === pairToHash)
      if (!cancelled) setExcellentSecs(pair ? entriesOf(pair).map((e) => e.entrySec) : [])
    })
    return () => {
      cancelled = true
    }
  }, [pairFromHash, pairToHash, badMixesRev, excellentPairsRev])
  const manualTags = useStore((s) => s.vocalManual)
  const vocalSide = useMemo(
    () => (showTransitionPoints ? ctl.deckHandoffSide(deckId) : { missing: '' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showTransitionPoints, trackVocal, manualTags, deck.beatGrid, deck.durationSec, deck.track, deck.bands],
  )
  const otherVocalSide = useMemo(
    () => (showTransitionPoints ? ctl.deckHandoffSide(otherDeckId) : { missing: '' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showTransitionPoints, otherTrackVocal, manualTags, otherBeatGrid, otherDurationSec, otherTrack, otherBands],
  )
  // v0.5.4: this deck's own suggested exit point, shown the moment it becomes
  // the outgoing side of a running transition — transparently, per the
  // owner's own request, not tucked away until the transition finishes.
  // `null` here only means "no transition running on this deck" — the
  // heuristic-found-nothing case no longer exists (`AppState.activeTransition`'s
  // own doc comment, fixed 23/09).
  const exitPointSec = activeTransition?.fromDeckId === deckId ? activeTransition.exitPointSec : null
  const exitPointKnownGood = exitPointSec != null && deck.excellentMixPoints.includes(Math.round(exitPointSec))
  const [dropActive, setDropActive] = useState(false)
  const [gridPanelOpen, setGridPanelOpen] = useState(false)
  // Only the panel's own ✕ counts as "I checked it" (`confirmBeatGrid`, v0.12.4
  // — Shalom's call, 28/09). Since a confirm is saved, a stray click elsewhere
  // that merely closes the panel would otherwise pin a grid nobody looked at,
  // and no later analysis could replace it.
  const closeGridPanel = () => setGridPanelOpen(false)
  const confirmAndCloseGridPanel = () => {
    setGridPanelOpen(false)
    ctl.confirmBeatGrid(deckId)
  }
  useEffect(() => {
    if (!gridPanelOpen) return
    const onDocClick = () => closeGridPanel()
    // Next tick: otherwise the same click that opened it closes it right back.
    const id = window.setTimeout(() => document.addEventListener('click', onDocClick), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('click', onDocClick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridPanelOpen])

  // SYNC: a tap toggles phase-lock to the master deck; a long-press makes
  // this deck the master instead (v0.3.0). Mirrors Platter.tsx's hold-timer
  // idiom (a ref, not state, since the timer firing shouldn't re-render) and
  // the CUE button's window-level pointerup listener just below — the
  // release has to be caught even if the pointer drifted off the button
  // first, the same reason CUE doesn't rely on onPointerUp alone.
  const deckFlash = useFlash(`deck:${deckId}`)
  const syncFlash = useFlash(`sync:${deckId}`)
  const syncHoldTimer = useRef(0)
  const syncLongFired = useRef(false)
  useEffect(() => () => window.clearTimeout(syncHoldTimer.current), [])
  const onSyncDown = () => {
    syncLongFired.current = false
    window.clearTimeout(syncHoldTimer.current)
    syncHoldTimer.current = window.setTimeout(() => {
      syncLongFired.current = true
      ctl.setMasterDeck(deckId)
    }, LONG_PRESS_MS)
    const up = () => {
      window.clearTimeout(syncHoldTimer.current)
      if (!syncLongFired.current) ctl.syncDeck(deckId)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointerup', up)
  }

  const TRACK_MIME = 'application/x-soundgrid-track'
  // The sampler pad grid (`PadGrid.tsx`) is its own, more specific drop
  // target for the exact same drag payload, and it lives inside this
  // section. `closest` is checked directly against the event, not against
  // stopped propagation — an earlier version tried stopping the event from
  // reaching this section instead, but that also stopped `setDropActive`
  // from ever resetting on a pad drop, leaving this panel's "Drop to load
  // deck" overlay stuck on permanently (found by Shalom on the real app).
  // Letting every event still reach here, and simply deferring to the pad
  // grid when that's where it landed, keeps this section's own state
  // correct no matter which drop target the browser actually resolved.
  const overSamplerGrid = (e: React.DragEvent) =>
    (e.target as HTMLElement).closest('[data-drop-zone="sampler"]') != null
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropActive(false)
    if (overSamplerGrid(e)) return
    const id = e.dataTransfer.getData(TRACK_MIME)
    const track = useStore.getState().library.tracks.find((t) => t.id === id)
    if (track) void ctl.loadTrackToDeck(deckId, track)
  }
  // Tempo range and BPM precision are the user's from v0.2.5. The fader's
  // -1..1 value is unchanged by the range; what it means in percent is not.
  const { tempoRange, bpmDecimals } = useSettings()
  // The fader's middle is the track's saved speed (v0.9.47, `baseRate`); the % beside the BPM is the fader's move off it.
  const effectiveBpm = deck.bpm != null ? deck.bpm * deck.baseRate * (1 + deck.tempo * tempoRange) : null
  const deltaPct = deck.tempo * tempoRange * 100
  // v0.9.50: the key as it is heard now, beside the BPM — "8A→9A" when it moved off the song's own (owner, 07/10: no sign of the current key after Key sync).
  const ownKey = deck.track?.camelot ?? null
  const heardSemis = Math.round(heardSemitones(deck.baseRate * (1 + deck.tempo * tempoRange), deck.keyLock, deck.keySyncShift ?? 0))
  const heardKey = ownKey ? shiftCamelot(ownKey, heardSemis) : null
  // v0.9.70: to where the sound ends, not the file's end; a long silent tail is said in the tooltip, never dropped without a word.
  const songEnd = songEndSec(deck.audibleEndSec, deck.durationSec)
  const silentTailSec = deck.durationSec - songEnd
  const remain = songEnd - deck.positionSec
  // "Save tempo" (v0.9.46) is offered only when there is something to save: a hand moved the fader off the middle — not SYNC, a mix or a
  // glide back (`tempoByHand`), whose number belongs to the pairing (the 20/09 bug). "Forget tempo": a saved speed, fader in the middle.
  const centred = Math.abs(deck.tempo) < 1e-4
  const tempoAction: 'save' | 'forget' | null =
    !deck.track || deck.syncActive ? null : !centred && deck.tempoByHand ? 'save' : centred && Math.abs(deck.baseRate - 1) > 1e-4 ? 'forget' : null

  // Built once, placed in either layout below: the full one, or the compact
  // one while the track list is pulled up (v0.9.34).
  const deckToggles = (
    <span className="flex gap-2">
      <span className="relative inline-flex">
        <Button
          variant="toggle"
          active={deck.vinylMode}
          tone={color}
          onClick={() => ctl.toggleVinylMode(deckId)}
          title="Vinyl mode: stop and start spin down and up instead of cutting"
        >
          Vinyl
        </Button>
        <HintIcon id="deck.vinyl" className="absolute -right-1.5 -top-1.5" />
      </span>
      <span className="relative inline-flex">
        <Button
          variant="toggle"
          active={deck.keyLock}
          tone={color}
          onClick={() => void ctl.toggleKeyLock(deckId)}
          title="Key lock: the tempo fader changes the speed, the pitch stays the song's own"
        >
          Key lock
        </Button>
        <HintIcon id="deck.keylock" className="absolute -right-1.5 -top-1.5" />
      </span>
      <span className="relative inline-flex">
        <Button
          variant="toggle"
          active={deck.keySyncShift != null}
          tone={color}
          onClick={() => void ctl.toggleKeySync(deckId)}
          title={
            deck.keySyncShift != null
              ? deck.keySyncShift === 0
                ? "Key sync checked: the two songs' keys already fit, so nothing was moved. Click to switch it off."
                : `Key sync is on: moved ${deck.keySyncShift > 0 ? '+' : ''}${deck.keySyncShift} semitones to fit the other deck. Click to go back to the song's own key.`
              : "Key sync: move this deck's key, without changing its speed, to the nearest key that fits the other deck"
          }
        >
          {deck.keySyncShift == null ? 'Key sync' : deck.keySyncShift === 0 ? 'Key fits' : `Key ${deck.keySyncShift > 0 ? '+' : ''}${deck.keySyncShift}`}
        </Button>
        <HintIcon id="deck.keysync" className="absolute -right-1.5 -top-1.5" />
      </span>
    </span>
  )
  const tempoFader = (length: number, vertical = true) => (
    <Fader
      vertical={vertical}
      label="Tempo"
      value={deck.tempo}
      min={-1}
      max={1}
      onChange={(v) => ctl.setTempo(deckId, v)}
      color={color}
      length={length}
      detent
      hint="deck.tempo"
      format={(v) =>
        `${v * tempoRange * 100 > 0 ? '+' : ''}${(v * tempoRange * 100).toFixed(1)}%`
      }
    />
  )

  return (
    <section
      className={`panel relative flex min-h-0 min-w-0 flex-col gap-2 p-2.5 transition-shadow${deckFlash ? ' press-flash' : ''}`}
      style={dropActive ? { boxShadow: `0 0 0 2px ${color}, var(--shadow-panel)` } : undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TRACK_MIME)) return
        // A drag can enter this panel somewhere else first (the overlay is
        // meant to cover that case) and only *then* reach the pad grid —
        // dragover never fires again for a target it's already true for,
        // so without this the overlay would sit there the whole time the
        // pointer is over the pads, only clearing on drop.
        if (overSamplerGrid(e)) {
          setDropActive(false)
          return
        }
        e.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false)
      }}
      onDrop={onDrop}
    >
      {dropActive && (
        <div
          className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[var(--radius-lg)] text-sm font-semibold"
          style={{ background: 'color-mix(in srgb, var(--color-surface-0), transparent 25%)', color }}
        >
          Drop to load deck {deckId}
        </div>
      )}
      {/* identity + primary readouts ------------------------------------ */}
      <header className="flex items-start gap-3">
        <span
          className="mt-0.5 grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-sm font-bold text-black"
          style={{ background: color }}
        >
          {deckId}
        </span>
        <div className="relative min-w-0 flex-1">
          <div
            className={`truncate text-base font-semibold leading-tight ${
              loaded ? '' : 'text-grid-dim'
            }`}
          >
            {deck.loading ? 'Loading track…' : (deck.track?.name ?? 'No track loaded')}
          </div>
          <div className="tnum mt-0.5 flex items-center gap-2 text-xs text-grid-muted">
            <span className="uppercase tracking-wide">{deck.track?.kind ?? '—'}</span>
            {loaded && (
              <>
                <span aria-hidden>·</span>
                <span>{fmt(deck.positionSec)}</span>
                <span className="text-grid-dim">/ {fmt(deck.durationSec)}</span>
                <span
                  className={remain <= 30 && remain > 0 ? 'text-warn' : 'text-grid-dim'}
                  title={silentTailSec > 0 ? `Counts to where the sound ends. The last ${fmt(silentTailSec)} of the file is silence.` : undefined}
                >
                  −{fmt(remain)}
                </span>
                {/* v0.8.17: disabled, not hidden, while playing — the button
                    stays where the owner learned it is, and the title says
                    why it won't press. */}
                <button
                  type="button"
                  onClick={() => ctl.ejectDeck(deckId)}
                  disabled={deck.playing || deck.loading}
                  aria-label={`Eject deck ${deckId}`}
                  title={
                    deck.playing
                      ? 'Pause the deck to eject its track'
                      : deck.loading
                        ? 'Wait for the track to finish loading'
                        : `Eject — empty deck ${deckId}`
                  }
                  className="ms-1 rounded-[var(--radius-sm)] px-1.5 text-sm leading-none text-grid-muted hover:bg-surface-3 hover:text-grid-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  ⏏
                </button>
              </>
            )}
          </div>
          {exitPointSec != null && (
            <div className="mt-0.5">
              <Pill
                tone={exitPointKnownGood ? 'accent' : 'idle'}
                label={
                  exitPointKnownGood
                    ? `★ exit at ${fmt(exitPointSec)} — worked well before`
                    : `suggested exit at ${fmt(exitPointSec)}`
                }
              />
            </div>
          )}
          {showTransitionPoints && (
            <TransitionPointsPanel
              bands={deck.bands}
              durationSec={deck.durationSec}
              endSec={songEnd}
              beatGrid={deck.beatGrid}
              analysisFailed={deck.track?.analysisState === 'failed'}
              otherDeckId={otherDeckId}
              otherBands={otherBands}
              otherDurationSec={otherDurationSec}
              otherPositionBucketSec={otherPositionBucketSec}
              otherAnalysisFailed={otherAnalysisFailed}
              vocalSide={vocalSide}
              otherVocalSide={otherVocalSide}
              syncMult={ctl.handoffSyncMultiplier(otherDeckId, deckId)}
              badEntries={badEntries}
              excellentSecs={excellentSecs}
              onRestoreBad={() => pairFromHash && pairToHash && ctl.restoreBadMixes(pairFromHash, pairToHash)}
              onHandoff={(voice) => ctl.startVocalHandoffAt(otherDeckId, deckId, voice)}
              onVocalSwap={(entry) => ctl.startVocalSwapAt(otherDeckId, deckId, entry)}
              phraseJoin={(pos, entrySec) => ctl.deckPhraseJoin(otherDeckId, pos, entrySec == null ? undefined : { toDeckId: deckId, sec: entrySec })}
              onSelect={(sec) => {
                // Starts where the other deck's voice is over for the whole mix (v0.9.63; its next phrase start in v0.9.17). No
                // "Mix in" pad here any more — it's saved only if the mix is
                // then rated Excellent (`rateMixTransition`).
                ctl.startAutoTransitionOnPhrase(otherDeckId, deckId, sec)
              }}
            />
          )}
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            className="text-right disabled:cursor-not-allowed"
            onClick={() => {
              if (!loaded) return
              if (gridPanelOpen) closeGridPanel()
              else setGridPanelOpen(true)
            }}
            disabled={!loaded}
            aria-label="Edit beat grid"
            aria-expanded={gridPanelOpen}
          >
            <div
              className="tnum text-xl font-semibold leading-none"
              style={{ color: effectiveBpm ? color : 'var(--color-grid-dim)' }}
            >
              {effectiveBpm ? effectiveBpm.toFixed(bpmDecimals) : '—'}
            </div>
            <div className="tnum mt-0.5 text-2xs text-grid-muted">
              BPM
              {ownKey && (
                <span
                  className={`ml-1 ${heardKey && heardKey !== ownKey ? 'text-accent' : 'text-grid-dim'}`}
                  title={heardKey && heardKey !== ownKey ? `Heard in ${heardKey}; the song's own key is ${ownKey}` : `Key ${ownKey}, the song's own`}
                >
                  {heardKey && heardKey !== ownKey ? `${ownKey}→${heardKey}` : ownKey}
                </span>
              )}
              {deltaPct !== 0 && (
                <span className="ml-1 text-grid-dim">
                  {deltaPct > 0 ? '+' : ''}
                  {deltaPct.toFixed(1)}%
                </span>
              )}
            </div>
          </button>
          {/* Sibling of the button, not a child: HintIcon carries its own
              tabIndex, and HTML forbids any tabindex-bearing descendant of a
              <button> — this div is already `relative`, so the badge anchors
              to it exactly as it would have anchored to the button itself. */}
          {/* Left of the number, not over its corner: the readout is right-
              aligned, so a badge at the top-right sat on the last digit. */}
          <HintIcon id="deck.bpm" className="absolute -left-4 top-0" />
          {/* Live bar/downbeat correction (v0.8.8) — only relevant mid-mix:
              this deck is phase-locked to the other one, which is actually
              playing right now. `shiftDeckByBeat` itself guards master/no-
              grid/active-loop with a notice; this condition only covers
              "is there anything to shift at all" (same shape as the
              "♫ N mixable" toggle in Library.tsx, which only shows while
              `anyPlaying`). See workshop-output/FEATURE_SPEC_BARSYNC.md —
              SYNC locks beat phase, never bar phase, so this is a live,
              by-ear correction, not something the app can do silently. */}
          {/* Beside the "BPM +x%" line, not under it: a row here pushed the waveform, the pads and the track list 22px down every
              time the fader moved (measured, v0.9.46), on a deck that already fills the 710px screen. */}
          {tempoAction && (
            <div className="absolute right-full top-[21px] mr-1 whitespace-nowrap">
              <button
                type="button"
                onClick={() => void ctl.saveDeckTempo(deckId, { forget: tempoAction === 'forget' })}
                title={
                  tempoAction === 'forget'
                    ? "Forget the speed saved for this track: it goes back to the file's own speed"
                    : "Make this the track's own speed: the fader goes back to the middle, the BPM stays, and it plays at this speed every time. Nothing is kept unless you press this."
                }
                className="rounded-[var(--radius-xs)] px-1 py-0.5 text-2xs text-grid-muted transition-colors hover:bg-surface-2 hover:text-grid-text"
              >
                {tempoAction === 'forget' ? 'Forget tempo' : 'Save tempo'}
              </button>
            </div>
          )}
          {deck.syncActive && otherPlaying && (
            <div className="mt-1 flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => ctl.shiftDeckByBeat(deckId, -1)}
                title="Beats ticking together but the drums still clash? Tap to bump the track back one whole beat — like nudging a record one click back so the big hits land together."
                className="rounded-[var(--radius-xs)] px-1 py-0.5 text-2xs text-grid-dim transition-colors hover:bg-surface-2 hover:text-grid-text"
              >
                ◂ beat
              </button>
              <button
                type="button"
                onClick={() => ctl.shiftDeckByBeat(deckId, 1)}
                title="Beats ticking together but the drums still clash? Tap to bump the track forward one whole beat — like nudging a record one click ahead so the big hits land together."
                className="rounded-[var(--radius-xs)] px-1 py-0.5 text-2xs text-grid-dim transition-colors hover:bg-surface-2 hover:text-grid-text"
              >
                beat ▸
              </button>
            </div>
          )}
          {/* A grid detection wasn't confident about, or found nothing at all,
              is shown — never silently trusted (CLAUDE.md's central rule).
              Cleared once the user checks or edits it (BeatGridPanel). */}
          {loaded && !deck.beatGridConfirmed && (
            <div className="mt-1 flex justify-end">
              <Pill tone="warn" label="unconfirmed grid" />
            </div>
          )}
          {/* v0.9.5: the "1" is a guess the detector was not sure of — the
              yellow lines are dashed, and this opens the panel to fix or
              check it (its ✕ counts as checked). */}
          {loaded && deck.barOneUnsure && !gridPanelOpen && (
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setGridPanelOpen(true)
                }}
                title='The computer is not sure which beat is the "1" here, so the yellow lines are dashed. Open to move it ("Set downbeat here" on the real 1) or close with ✕ if it is right.'
                className="rounded-[var(--radius-xs)]"
              >
                <Pill tone="warn" label="bar 1 unsure" />
              </button>
            </div>
          )}
          {gridPanelOpen && (
            <BeatGridPanel deckId={deckId} beatGrid={deck.beatGrid} bpmOrigin={deck.bpmOrigin} onClose={confirmAndCloseGridPanel} />
          )}
        </div>
      </header>

      <WaveformOverview
        deckId={deckId}
        peaks={deck.peaks}
        bands={deck.bands}
        positionSec={deck.positionSec}
        durationSec={deck.durationSec}
        hotCues={deck.hotCues}
        loopRange={deck.loopRange}
        color={color}
      />
      {loaded && <VocalStrip vocal={trackVocal} durationSec={deck.durationSec} positionSec={deck.positionSec} deckId={deckId} contentHash={deck.track?.contentHash} />}
      {loaded && <SampleStrip durationSec={deck.durationSec} positionSec={deck.positionSec} deckId={deckId} contentHash={deck.track?.contentHash} />}

      <Waveform
        deckId={deckId}
        peaks={deck.peaks}
        bands={deck.bands}
        positionSec={deck.positionSec}
        durationSec={deck.durationSec}
        bpm={deck.bpm}
        offsetSec={deck.beatGrid?.offsetSec ?? 0}
        barUnsure={deck.barOneUnsure}
        hotCues={deck.hotCues}
        loopRange={deck.loopRange}
        color={color}
        loading={deck.loading}
        onSeek={(s) => ctl.seekDeckByHand(deckId, s)}
      />
      <BarOneQueue deckId={deckId} />

      <div className="flex gap-3">
        {/* left: transport + pads ------------------------------------- */}
        <div className="flex flex-1 flex-col gap-1.5">
          {/* Each grid cell holds a wrapping span, not the Button directly:
              HintIcon must be a sibling of the button (see the note by
              HintIcon's definition), and the span needs `flex` + the button
              `flex-1` so the button still fills the grid track exactly as it
              did before — a grid item stretches by default, and a plain
              wrapper without this would leave the button its own
              content-width, shrunk to the left of its cell. */}
          <div className="grid grid-cols-[1fr_1.4fr_1fr] gap-2">
            <span className="relative flex">
              <Button
                variant="transport"
                className="flex-1"
                onPointerDown={() => {
                  const release = ctl.cuePlayPreview(deckId)
                  const up = () => {
                    release()
                    window.removeEventListener('pointerup', up)
                  }
                  if (!deck.playing) window.addEventListener('pointerup', up)
                  else ctl.cue(deckId)
                }}
                disabled={!loaded}
              >
                Cue
              </Button>
              <HintIcon id="deck.cue" className="absolute -right-1.5 -top-1.5" />
            </span>
            <span className="relative flex">
              <Button
                variant="transport"
                className="flex-1"
                active={deck.playing}
                tone={color}
                onClick={() => ctl.togglePlay(deckId)}
                disabled={!loaded}
              >
                {deck.playing ? 'Pause' : 'Play'}
              </Button>
              <HintIcon id="deck.play" className="absolute -right-1.5 -top-1.5" />
            </span>
            <span className="relative flex">
              <Button
                variant="transport"
                className={`flex-1${syncFlash ? ' press-flash' : ''}`}
                active={deck.syncActive}
                tone={color}
                onPointerDown={onSyncDown}
                disabled={!loaded}
                title="Tap: sync to master. Hold: make this deck master."
              >
                Sync
              </Button>
              <HintIcon id="deck.sync" className="absolute -right-1.5 -top-1.5" />
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="relative inline-flex">
              <Button
                variant="toggle"
                active={deck.loopActive}
                tone={color}
                onClick={() => ctl.toggleLoop(deckId)}
                disabled={!loaded}
              >
                Loop
              </Button>
              <HintIcon id="deck.loop" className="absolute -right-1.5 -top-1.5" />
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ctl.setLoopBeats(deckId, deck.loopBeats / 2)}
              disabled={!loaded}
            >
              ÷2
            </Button>
            <span className="tnum w-9 text-center text-xs text-grid-muted">{deck.loopBeats}b</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ctl.setLoopBeats(deckId, deck.loopBeats * 2)}
              disabled={!loaded}
            >
              ×2
            </Button>
            <span className="relative ml-auto inline-flex">
              <Button
                variant="toggle"
                active={deck.cueMonitor}
                tone="var(--color-live)"
                onClick={() => ctl.toggleCueMonitor(deckId)}
              >
                PFL
              </Button>
              <HintIcon id="deck.pfl" className="absolute -right-1.5 -top-1.5" />
            </span>
          </div>

          {compact ? (
            // The track list is pulled up (v0.9.34): pads and platter step
            // aside, the buttons that were under the platter and the tempo
            // fader (laid flat) take one row instead of the platter's height.
            <div className="flex items-center gap-3">
              {deckToggles}
              <span className="ml-auto">{tempoFader(120, false)}</span>
            </div>
          ) : (
            <PadGrid deckId={deckId} hotCues={deck.hotCues} padMode={deck.padMode} color={color} />
          )}
        </div>

        {/* right: platter + vinyl, tempo beside them ------------------- */}
        {/* Side by side, not stacked. Stacking is what forced the platter down
            to 54px: the column had to hold both. Beside each other, the platter
            gets the column's full 178px height and the layout does not grow. */}
        {!compact && (
          <div className="flex shrink-0 items-start gap-2">
            {/* Vinyl keeps its natural width rather than filling the platter:
                stretched to 142px it became the largest coloured area on the deck
                — louder than PLAY — and it is on by default, so it would be lit
                almost always. Moving the control is the change here; its weight
                stays what it was. */}
            <div className="flex flex-col items-center gap-1">
              <span className="relative inline-block">
                <Platter
                  deckId={deckId}
                  positionSec={deck.positionSec}
                  durationSec={deck.durationSec}
                  playing={deck.playing}
                  scratching={deck.scratching}
                  hasTrack={!!deck.track}
                  color={color}
                  size={PLATTER_SIZE}
                />
                <HintIcon id="deck.platter" className="absolute -bottom-1 -right-1" />
              </span>
              {deckToggles}
            </div>
            {tempoFader(160)}
          </div>
        )}
      </div>
    </section>
  )
}
