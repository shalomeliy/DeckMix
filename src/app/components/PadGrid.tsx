import { useRef, useState } from 'react'
import * as ctl from '@/controls'
import { HOT_CUE_COLORS } from '@/core/constants'
import { LOOP_BEATS_STEPS } from '@/core/padmodes'
import { customTextOf } from '@/core/hotcues'
import type { HintId } from '@/core/hints'
import { isSamplerSlotOccupied, type SamplerMode, type SamplerSlot } from '@/core/sampler'
import { Button, HintIcon, Knob, Pill } from '@/app/components/controls'
import { useStore } from '@/app/state/store'
import type { DeckId, HotCue, PadMode } from '@/core/types'

/** Same drag payload `Library.tsx` sets and `Deck.tsx`'s own drop zone reads — a track dropped on a sampler pad loads it the same way one dropped on a deck does. */
const TRACK_MIME = 'application/x-soundgrid-track'

/** A saved mix-in point (`saveMixEntryHotCue`, v0.4.7) — pressing it re-runs the automatic transition, not just a jump. `kind` (v0.5.3), never the label: a manually renamed plain pad also carries a non-ordinal label now, on purpose. */
const isMixEntry = (cue: HotCue): boolean => cue.kind === 'mixEntry'

/** Same m:ss shape `Deck.tsx`/`Library.tsx`/`TransitionPointsPanel.tsx` each already format independently — no shared formatter exists yet to import instead. */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface Props {
  deckId: DeckId
  hotCues: HotCue[]
  padMode: PadMode
  color: string
}

/** Drag payload: the source pad's index, as plain text. */
const HOT_CUE_MIME = 'application/x-soundgrid-hotcue'

const MODES: { mode: PadMode; label: string }[] = [
  { mode: 'hotcue', label: 'Cue' },
  { mode: 'loop', label: 'Loop' },
  { mode: 'beatJump', label: 'Jump' },
  { mode: 'sampler', label: 'Smpl' },
]

/** "¼"-style beat-count label — the notation a DJ already reads on loop-length controls, not a raw decimal. */
function beatsLabel(n: number): string {
  return n < 1 ? `1/${Math.round(1 / n)}` : `${n}`
}

const padClass =
  'group relative h-10 rounded-[var(--radius-sm)] px-1 text-2xs font-bold tabular-nums transition-[transform,box-shadow,background] duration-100 ease-[var(--ease-out)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)]'

/**
 * Pad grid (v0.5.0) — one of 4 modes per deck, switched by the row above it.
 * The row above used to just label the grid ("Hot Cues"); it is the mode
 * switch itself now, replacing rather than adding to that row, so the
 * height budget this panel already had (`CLAUDE.md`'s ~710px note) does not
 * grow. `shiftHeld` (global — one physical SHIFT button on the FLX4, not
 * one per deck) rings the whole grid and swaps every pad's label to what
 * SHIFT does right now, so nothing about the remap is color-only.
 */
export function PadGrid({ deckId, hotCues, padMode, color }: Props) {
  const shiftHeld = useStore((s) => s.shiftHeld)
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <span className="relative inline-flex shrink-0">
          <HintIcon id="deck.padMode" />
        </span>
        <div className="grid flex-1 grid-cols-4 gap-1">
          {MODES.map(({ mode, label }) => (
            <Button
              key={mode}
              variant="toggle"
              size="sm"
              active={padMode === mode}
              tone={color}
              onClick={() => ctl.setPadMode(deckId, mode)}
              aria-label={`Pad mode: ${label}`}
            >
              {label}
            </Button>
          ))}
        </div>
        {/* SHIFT has no persistent on-screen control (keyboard/hardware only)
            — the Pill is its only visible presence while held, and this
            HintIcon is how Hint mode explains it *before* it's ever pressed,
            the same discoverability every other control gets. */}
        {shiftHeld ? <Pill tone="accent" label="SHIFT" /> : <HintIcon id="deck.shift" />}
      </div>
      <div
        className="grid grid-cols-4 gap-1 rounded-[var(--radius-sm)] transition-shadow duration-100"
        style={shiftHeld ? { boxShadow: `0 0 0 2px var(--color-accent)` } : undefined}
        // Sampler mode only: `Deck.tsx` wraps the *whole* deck panel — pads
        // included — in its own "drop to load deck" zone for the same drag
        // payload. This marker is how it recognizes "this drop belongs to a
        // pad, not to me" and defers, without stopping the event itself —
        // stopping propagation here was tried first and broke the deck's
        // own `dropActive` reset (its overlay got stuck on after a pad
        // drop, found by Shalom on the real app).
        data-drop-zone={padMode === 'sampler' ? 'sampler' : undefined}
      >
        {padMode === 'hotcue' && <HotCuePads deckId={deckId} hotCues={hotCues} shiftHeld={shiftHeld} />}
        {padMode === 'loop' && <LoopPads deckId={deckId} shiftHeld={shiftHeld} />}
        {padMode === 'beatJump' && <BeatJumpPads deckId={deckId} shiftHeld={shiftHeld} />}
        {padMode === 'sampler' && <SamplerPads deckId={deckId} shiftHeld={shiftHeld} />}
      </div>
      {/* What SHIFT does, in every mode, always on screen (v0.8.24) — SHIFT
          has no button of its own, so until this line the only place it was
          explained was a hint shown nowhere. The current mode's part is lit. */}
      <div className="mt-0.5 flex items-center gap-1 text-2xs leading-tight text-grid-dim">
        <span className="font-semibold">SHIFT:</span>
        {SHIFT_LEGEND.map(({ mode, label }, i) => (
          <span key={mode} className={padMode === mode ? 'text-grid-text' : undefined}>
            {i > 0 && <span aria-hidden> · </span>}
            {label}
          </span>
        ))}
        <HintIcon id={PAD_HINT[padMode]} className="relative ml-auto" />
      </div>
    </div>
  )
}

/** The SHIFT line under the pads — pad-grid order, so it reads left to right like the mode tabs. */
const SHIFT_LEGEND: { mode: PadMode; label: string }[] = [
  { mode: 'hotcue', label: 'delete' },
  { mode: 'loop', label: 'loop roll' },
  { mode: 'beatJump', label: 'jump back' },
  { mode: 'sampler', label: 'slots 9–16' },
]

const PAD_HINT: Record<PadMode, HintId> = {
  hotcue: 'pads.hotcue',
  loop: 'pads.loop',
  beatJump: 'pads.beatJump',
  sampler: 'pads.sampler',
}

/**
 * Hot Cue pads (v0.4.0, unchanged by v0.5.0's mode switch). Click sets/jumps
 * a plain pad, or re-runs the automatic transition for a pad saved from the
 * Mix Assist panel (`ctl.pressHotCue`, v0.4.7) — the distinction is
 * `isMixEntry`, not a separate button. Delete is two ways to the same
 * action, on purpose — a hover-revealed `×` (discoverable) and `Shift`+click
 * (existing muscle memory, kept). Dragging an occupied pad onto an empty one
 * relocates the cue; onto another occupied pad, it swaps them — never a
 * silent overwrite. The `×` is a `span[role=button]`, not a nested
 * `<button>`, because the whole pad is already one.
 *
 * `Alt`+click (v0.5.3) opens a rename box in place of the label — the
 * owner's own request: any pad, mix-entry or plain, can carry free text, and
 * whatever is saved always keeps the cue's own position visible in the name
 * (`renameHotCue`, `controls.ts` — `<text> · m:ss`, or bare `m:ss` if left
 * blank), so a renamed pad never turns into an unlabeled mystery once the
 * custom text scrolls out of memory. `Enter` saves; `Escape` or clicking away
 * cancels without writing anything — a stray `Alt`+click should never be able
 * to relabel a pad by accident.
 *
 * v0.8.24: while SHIFT is held a set pad *says* "× delete" — the next click
 * deletes it, and until then nothing on screen warned. A visible ✎ beside
 * the × opens the same rename box as Alt+click; Alt itself shows nothing
 * live, because on Windows a bare Alt press jumps to the browser's menu.
 */
function HotCuePads({ deckId, hotCues, shiftHeld }: { deckId: DeckId; hotCues: HotCue[]; shiftHeld: boolean }) {
  const [renaming, setRenaming] = useState<{ index: number; text: string } | null>(null)
  const commitRename = (cue: HotCue) => {
    const text = renaming!.text.trim()
    ctl.renameHotCue(deckId, cue.index, text ? `${text} · ${fmt(cue.positionSec)}` : fmt(cue.positionSec))
    setRenaming(null)
  }
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => {
        const cue = hotCues.find((c) => c.index === i)
        const color = cue?.color ?? HOT_CUE_COLORS[i]
        const occupiedStyle = {
          background: color,
          color: '#000',
          boxShadow: `0 0 0 1px ${color}, 0 0 14px -3px ${color}`,
        }
        const dot = (
          <span
            className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full"
            style={{ background: cue ? '#0007' : color, opacity: cue ? 1 : 0.5 }}
          />
        )

        // Rename mode swaps the pad's root element from `<button>` to
        // `<div>` entirely, rather than nesting the `<input>` inside the
        // button — an `<input>` is itself interactive, and HTML forbids
        // interactive descendants of a `<button>` (the same reason the
        // delete affordance below is a `span[role=button]`, never a nested
        // `<button>`).
        if (renaming?.index === i && cue) {
          return (
            <div key={i} className={padClass} style={occupiedStyle}>
              {dot}
              <input
                autoFocus
                value={renaming.text}
                aria-label={`Rename hot cue ${i + 1}`}
                onChange={(e) => setRenaming({ index: i, text: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitRename(cue)
                  else if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => setRenaming(null)}
                className="block w-full truncate bg-transparent px-0.5 text-center outline-none"
              />
            </div>
          )
        }

        return (
          <button
            key={i}
            draggable={!!cue}
            onDragStart={(e) => {
              e.dataTransfer.setData(HOT_CUE_MIME, String(i))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(HOT_CUE_MIME)) e.preventDefault()
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(HOT_CUE_MIME)) return
              e.preventDefault()
              const from = Number(e.dataTransfer.getData(HOT_CUE_MIME))
              ctl.moveHotCue(deckId, from, i)
            }}
            onClick={(e) => {
              if (e.shiftKey && cue) ctl.deleteHotCue(deckId, i)
              else if (e.altKey && cue) setRenaming({ index: i, text: customTextOf(cue) })
              else ctl.pressHotCue(deckId, i)
            }}
            // F2 is rename's keyboard path — ✎ and Alt+click are both mouse-only.
            onKeyDown={(e) => {
              if (e.key === 'F2' && cue) {
                e.preventDefault()
                setRenaming({ index: i, text: customTextOf(cue) })
              }
            }}
            aria-label={
              cue && shiftHeld
                ? `Shift held: click deletes hot cue ${i + 1}`
                : cue
                ? isMixEntry(cue)
                  ? `Start mix from ${cue.label}`
                  : `Jump to hot cue ${cue.label}`
                : `Set hot cue ${i + 1}`
            }
            className={padClass}
            style={
              cue
                ? occupiedStyle
                : {
                    background: 'var(--color-surface-2)',
                    color: 'var(--color-grid-dim)',
                    boxShadow: `inset 0 0 0 1px ${color}33`,
                  }
            }
          >
            {dot}
            {/* Plain manually-set cues carry a label that's already just the
                slot number (`setHotCue`, `controls.ts`) — this renders the
                same as `{i + 1}` always did. A v0.4.7 auto-saved mix-in cue,
                or any manually renamed pad (v0.5.3), carries a short
                descriptive label instead; `truncate` keeps it from
                overflowing the pad rather than wrapping/clipping
                mid-character. */}
            <span className="block truncate px-0.5">
              {cue && shiftHeld ? '× delete' : cue ? cue.label : i + 1}
            </span>
            {cue && (
              <span
                role="button"
                aria-label={`Edit name of hot cue ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setRenaming({ index: i, text: customTextOf(cue) })
                }}
                // Bottom corner, clickable only while shown: at the top next to
                // the × it covered the label, and an invisible target there
                // turned a plain "jump to cue" click into a rename.
                className="pointer-events-none absolute bottom-0.5 right-0.5 grid h-4 w-4 place-items-center rounded-full text-[10px] leading-none text-black opacity-0 transition-opacity duration-100 hover:bg-black/20 group-hover:pointer-events-auto group-hover:opacity-100"
              >
                ✎
              </span>
            )}
            {cue && (
              // A hover-revealed `span[role=button]`, not a nested
              // `<button>` (the pad is already one, and HTML forbids
              // interactive descendants of a button). Mouse-only by design
              // — `Shift`+click above reaches this same delete without a
              // pointer resting on the pad, so this adds no keyboard gap
              // beyond what the pad's own drag gesture already has.
              <span
                role="button"
                aria-label={`Delete hot cue ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation()
                  ctl.deleteHotCue(deckId, i)
                }}
                className="pointer-events-none absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full text-[10px] leading-none text-black opacity-0 transition-opacity duration-100 hover:bg-black/20 group-hover:pointer-events-auto group-hover:opacity-100"
              >
                ×
              </span>
            )}
          </button>
        )
      })}
    </>
  )
}

/**
 * Loop pads (v0.5.0): plain press starts/stops a loop of that pad's beat
 * length (`ctl.pressLoopPad` inside `ctl.pressPad`). SHIFT+press is Loop
 * Roll — momentary, catches up on release — so every pad is pressed the
 * same way (`onPointerDown`/window `pointerup`, same shape as the Cue
 * button's hold-to-preview in `Deck.tsx`) whether or not this particular
 * press turns out to need a release: `ctl.pressPad` always returns a
 * closure, a no-op for the plain-toggle case.
 */
function LoopPads({ deckId, shiftHeld }: { deckId: DeckId; shiftHeld: boolean }) {
  return (
    <>
      {LOOP_BEATS_STEPS.map((beats, i) => (
        <button
          key={i}
          onPointerDown={() => {
            const release = ctl.pressPad(deckId, i)
            const up = () => {
              release()
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointerup', up)
          }}
          aria-label={shiftHeld ? `Loop roll ${beatsLabel(beats)} beats` : `Loop ${beatsLabel(beats)} beats`}
          className={padClass}
          style={{
            background: 'var(--color-surface-2)',
            color: 'var(--color-grid-text)',
            boxShadow: 'inset 0 0 0 1px var(--color-hairline-strong)',
          }}
        >
          <span className="block truncate px-0.5">{shiftHeld ? `R·${beatsLabel(beats)}` : beatsLabel(beats)}</span>
        </button>
      ))}
    </>
  )
}

/**
 * Beat Jump pads (v0.5.0): a plain click jumps forward by that pad's beat
 * distance; SHIFT+click jumps backward the same distance (`ctl.pressPad`).
 * Not a hold gesture — `ctl.pressPad`'s release closure is always a no-op
 * here, so a plain `onClick` is enough, no pointerup dance needed.
 */
function BeatJumpPads({ deckId, shiftHeld }: { deckId: DeckId; shiftHeld: boolean }) {
  return (
    <>
      {LOOP_BEATS_STEPS.map((beats, i) => (
        <button
          key={i}
          onClick={() => ctl.pressPad(deckId, i)}
          aria-label={
            shiftHeld ? `Jump back ${beatsLabel(beats)} beats` : `Jump forward ${beatsLabel(beats)} beats`
          }
          className={padClass}
          style={{
            background: 'var(--color-surface-2)',
            color: 'var(--color-grid-text)',
            boxShadow: 'inset 0 0 0 1px var(--color-hairline-strong)',
          }}
        >
          <span className="block truncate px-0.5">
            {shiftHeld ? `←${beatsLabel(beats)}` : `→${beatsLabel(beats)}`}
          </span>
        </button>
      ))}
    </>
  )
}

const SAMPLER_MODE_BADGE: Record<SamplerMode, string> = { oneShot: '1×', loop: '⟲', gated: '◉' }

/**
 * Sampler pads (v0.6.0) — one *global* 16-slot bank (`core/sampler.ts`),
 * not per-deck: both decks' grids reach the same slots. 8 pads show slots
 * 0-7; the existing SHIFT layer (v0.5.0) shows 8-15, the same modifier
 * Loop/Beat Jump already use for their own alternate layer, so no new
 * hardware binding is needed to reach all 16 from an 8-pad controller.
 *
 * Loading is drag-and-drop from the library (`Library.tsx`'s rows are
 * already draggable for `Deck.tsx`'s drop zone — this reads the same
 * payload). Pressing triggers per the slot's mode (`ctl.pressPad`, which
 * resolves the absolute slot index and calls into `controls.ts`).
 * Hovering a pad opens the compact editor row above the grid — mode, gain,
 * sync and clear all live there rather than crammed into a 40px pad, the
 * same reasoning `HotCuePads`' inline rename swap keeps controls in place
 * rather than opening a separate panel.
 *
 * `Alt`+click (owner's own request, same gesture as `HotCuePads`) opens a
 * rename box in place of the pad's label — `ctl.renameSamplerSlot`. Guarded
 * on `onPointerDown` too: triggering is pointer-down-based here (so Gated
 * mode can release on pointer-up), and without the guard an Alt+click would
 * both rename *and* fire the sample for the instant before the box opens.
 */
function SamplerPads({ deckId, shiftHeld }: { deckId: DeckId; shiftHeld: boolean }) {
  const slots = useStore((s) => s.sampler.slots)
  const armedSlot = useStore((s) => s.sampler.armedSlot)
  const [hovered, setHovered] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<{ index: number; text: string } | null>(null)
  // `pointerdown` and the `click` that follows it are two different browser
  // events — reading `e.altKey` separately on each means releasing Alt
  // between them (a fast Alt+click is enough to do this) makes pointerdown
  // skip the trigger *and* click skip the rename: the pad does nothing,
  // with no feedback either way. Captured once, at pointerdown, and reused
  // for the click's decision closes that gap.
  const altAtPointerDown = useRef(false)
  const base = shiftHeld ? 8 : 0

  // The editor row sits *above* the grid, not inside each pad, so the mouse
  // has to cross from one to the other to reach its buttons — a bare
  // onMouseLeave on the pad closes the row before that crossing finishes.
  // A short close delay, cancelled by entering either the pad or the row,
  // is the standard fix (a "hover intent"); found by actually driving the
  // UI in a browser, not by looking at a static screenshot of it.
  const closeTimer = useRef(0)
  const openEditor = (index: number) => {
    window.clearTimeout(closeTimer.current)
    setHovered(index)
  }
  const scheduleClose = () => {
    closeTimer.current = window.setTimeout(() => setHovered(null), 150)
  }

  return (
    <>
      <div
        onMouseEnter={() => window.clearTimeout(closeTimer.current)}
        onMouseLeave={scheduleClose}
        className="col-span-4 flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] bg-surface-0/60 px-1.5 shadow-[inset_0_0_0_1px_var(--color-hairline)]"
      >
        {hovered != null ? (
          <SamplerSlotEditor index={hovered} slot={slots[hovered]} />
        ) : (
          <span className="text-2xs text-grid-dim">Drag a track here to load it. Hover a pad to edit it.</span>
        )}
      </div>
      {Array.from({ length: 8 }, (_, i) => {
        const index = base + i
        const slot = slots[index]
        const occupied = isSamplerSlotOccupied(slot)
        const isRecording = armedSlot === index
        // On, but nothing to lock to — shown on the pad itself rather than
        // a notice on every press, per this project's central rule: a
        // degraded state is surfaced, not swallowed, but a per-trigger
        // notice on a real-time percussive control would just be noise.
        const syncStuck = slot.syncEnabled && !slot.bpm

        if (renaming?.index === index) {
          return (
            <div key={i} className={padClass} style={{ background: 'var(--color-surface-2)', color: 'var(--color-grid-text)', boxShadow: 'inset 0 0 0 1px var(--color-accent)' }}>
              <input
                autoFocus
                value={renaming.text}
                aria-label={`Rename sampler slot ${index + 1}`}
                onChange={(e) => setRenaming({ index, text: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    ctl.renameSamplerSlot(index, renaming.text)
                    setRenaming(null)
                  } else if (e.key === 'Escape') {
                    setRenaming(null)
                  }
                }}
                onBlur={() => setRenaming(null)}
                className="block w-full truncate bg-transparent px-0.5 text-center outline-none"
              />
            </div>
          )
        }

        return (
          <button
            key={i}
            onMouseEnter={() => openEditor(index)}
            onMouseLeave={scheduleClose}
            onPointerDown={(e) => {
              altAtPointerDown.current = e.altKey
              // Alt+click renames (below) — must not also trigger the pad.
              if (e.altKey) return
              const release = ctl.pressPad(deckId, i)
              const up = () => {
                release()
                window.removeEventListener('pointerup', up)
              }
              window.addEventListener('pointerup', up)
            }}
            onClick={() => {
              if (altAtPointerDown.current && occupied) setRenaming({ index, text: slot.trackName ?? '' })
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TRACK_MIME)) {
                e.preventDefault()
                setDragOver(index)
              }
            }}
            onDragLeave={() => setDragOver((d) => (d === index ? null : d))}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(TRACK_MIME)) return
              e.preventDefault()
              setDragOver(null)
              // A slot mid-recording (v0.7.5) has no track loaded yet by this
              // check's own definition — dropping onto it here would race
              // `stopSamplerCapture`'s own `loadSlot` call.
              if (index === armedSlot) return
              const id = e.dataTransfer.getData(TRACK_MIME)
              const track = useStore.getState().library.tracks.find((t) => t.id === id)
              if (track) void ctl.loadSamplerSlot(index, track)
            }}
            aria-label={
              isRecording
                ? `Sampler slot ${index + 1} — recording from the master bus`
                : occupied
                  ? `Sampler slot ${index + 1}: ${slot.trackName}, ${slot.mode} mode`
                  : `Sampler slot ${index + 1} — empty, drag a track here`
            }
            className={isRecording ? `${padClass} rec-pulse` : padClass}
            style={
              isRecording
                ? { background: 'var(--color-surface-2)', color: 'var(--color-danger)' }
                : dragOver === index
                  ? { background: 'var(--color-surface-3)', boxShadow: `inset 0 0 0 2px var(--color-accent)` }
                  : slot.playing
                    ? { background: 'var(--color-accent)', color: '#000' }
                    : occupied
                      ? {
                          background: 'var(--color-surface-2)',
                          color: 'var(--color-grid-text)',
                          boxShadow: `inset 0 0 0 1px ${syncStuck ? 'var(--color-warn)' : 'var(--color-hairline-strong)'}`,
                        }
                      : {
                          background: 'var(--color-surface-1)',
                          color: 'var(--color-grid-dim)',
                          boxShadow: 'inset 0 0 0 1px var(--color-hairline)',
                        }
            }
          >
            {isRecording && (
              <span className="absolute left-1 top-1 text-[9px] font-bold leading-none">REC</span>
            )}
            {!isRecording && occupied && (
              <span className="absolute left-1 top-1 text-[9px] font-bold leading-none opacity-70">
                {SAMPLER_MODE_BADGE[slot.mode]}
              </span>
            )}
            <span className="block truncate px-0.5">{occupied ? slot.trackName : index + 1}</span>
          </button>
        )
      })}
    </>
  )
}

/** The hover-revealed editor for one sampler slot — mode, gain, sync, clear. Real widgets (`Button`/`Knob`) reused from the mixer rather than squeezed into the pad itself. */
function SamplerSlotEditor({ index, slot }: { index: number; slot: SamplerSlot }) {
  const armedSlot = useStore((s) => s.sampler.armedSlot)
  const isRecording = armedSlot === index
  const occupied = isSamplerSlotOccupied(slot)
  const modes: { mode: SamplerMode; label: string }[] = [
    { mode: 'oneShot', label: '1×' },
    { mode: 'loop', label: 'Loop' },
    { mode: 'gated', label: 'Gate' },
  ]
  return (
    <>
      {/* Compact on purpose — the pad being hovered already shows the full
          name, right next to this row; repeating it here left no room for
          the controls at the owner's actual 1536px width. */}
      <span className="shrink-0 text-2xs font-semibold text-grid-dim">
        {occupied ? `#${index + 1}` : `#${index + 1} — empty`}
      </span>
      {occupied ? (
        <>
          <div className="flex gap-0.5">
            {modes.map(({ mode, label }) => (
              <Button
                key={mode}
                variant="toggle"
                size="sm"
                active={slot.mode === mode}
                onClick={() => ctl.setSamplerSlotMode(index, mode)}
              >
                {label}
              </Button>
            ))}
          </div>
          <Knob
            label="Gain"
            size={22}
            min={0}
            max={1}
            value={slot.gain}
            tone="var(--color-accent)"
            onChange={(v) => ctl.setSamplerGain(index, v)}
            format={(v) => `${Math.round(v * 100)}`}
          />
          <Button
            variant="toggle"
            size="sm"
            active={slot.syncEnabled}
            tone="var(--color-live)"
            onClick={() => ctl.setSamplerSyncEnabled(index, !slot.syncEnabled)}
            aria-label={`Sync sampler slot ${index + 1} to master BPM`}
            title={
              slot.syncEnabled && !slot.bpm
                ? "On, but this sample has no BPM tag to sync from"
                : "Match this slot's playback rate to the master deck's BPM"
            }
          >
            Sync
          </Button>
          <Button variant="ghost" size="sm" onClick={() => ctl.clearSamplerSlot(index)}>
            Clear
          </Button>
        </>
      ) : isRecording ? (
        <>
          <span className="text-2xs font-semibold text-danger">Recording…</span>
          <Button variant="toggle" size="sm" active tone="var(--color-danger)" onClick={() => void ctl.stopSamplerCapture(index)}>
            Stop
          </Button>
        </>
      ) : (
        <>
          <span className="text-2xs text-grid-dim">Drag a track here, or record from the master.</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={armedSlot != null}
            onClick={() => void ctl.startSamplerCapture(index)}
          >
            Record
          </Button>
        </>
      )}
    </>
  )
}
