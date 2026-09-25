import { useEffect, useRef, useState } from 'react'
import { AiControlBar } from '@/app/components/AiControlBar'
import { Deck } from '@/app/components/Deck'
import { Library } from '@/app/components/Library'
import { Mixer } from '@/app/components/Mixer'
import { SettingsScreen } from '@/app/components/Settings'
import { SetHistoryScreen } from '@/app/components/SetHistory'
import { KeysScreen } from '@/app/components/KeysScreen'
import { TaggingScreen } from '@/app/components/TaggingScreen'
import { TopBar } from '@/app/components/TopBar'
import { TransitionRatingPrompt } from '@/app/components/TransitionRatingPrompt'
import * as ctl from '@/controls'
import { settings } from '@/platform/settings-idb/store'
import { getCrates } from '@/platform/crates-idb/store'
import { useRenderLoop } from '@/app/hooks/useRenderLoop'
import { useStore } from '@/app/state/store'
import type { DeckId } from '@/core/types'

export default function App() {
  useRenderLoop()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsGroup, setSettingsGroup] = useState<'hardware' | 'legal'>('hardware')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [taggingOpen, setTaggingOpen] = useState(false)
  // The Keys screen covers the decks: a key tried from its table must not
  // play, cue or load a deck the owner can't see (v0.8.24 review).
  const keysOpenRef = useRef(false)
  useEffect(() => {
    // The tagging screen covers the decks too, and its clip plays through
    // master — a stray key must not start a deck under it.
    keysOpenRef.current = keysOpen || taggingOpen
  }, [keysOpen, taggingOpen])
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  const storageNotice = useStore((s) => s.storageNotice)
  /**
   * Read inside the key handler rather than listed as a dependency: the handler
   * owns a Set of physically-held bend keys, and re-registering the listener
   * would drop it — a key held across the toggle would then never get its
   * release and the deck would stay bent with nothing on screen saying why.
   */
  const settingsOpenRef = useRef(false)
  useEffect(() => {
    settingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  // Loads the stored settings once. Until it resolves the app runs on the
  // built-in defaults, which is the same thing it did before there were any.
  useEffect(() => {
    void settings.init()
  }, [])

  // Crates (v0.8.1) are independent of the library scan, so they load once
  // at boot rather than as part of Library.tsx's scan pipeline. Until this
  // resolves the crate rail is simply empty, same as an empty library.
  useEffect(() => {
    void getCrates().then((crates) => useStore.getState().set('crates', crates))
  }, [])

  useEffect(() => {
    /**
     * Bend keys, mirrored like the rest of the map: deck A on the left of the
     * keyboard beside its cue key, deck B on the right beside its own.
     *
     * Bend only — there is deliberately no scratch key. A scratch is a
     * continuous gesture with a speed, and a key has no speed; a "scratch key"
     * would look like the feature and not be it.
     */
    // Direction only — the strength is read at press time from Settings, so a
    // change on the screen is felt on the very next key, with no listener to
    // rebuild and no stale closure holding the old number.
    const bendKeys: Record<string, [DeckId, number]> = {
      KeyS: ['A', -1],
      KeyD: ['A', 1],
      KeyK: ['B', -1],
      KeyL: ['B', 1],
    }
    /**
     * Which bend keys are physically down. Needed because two of them can be
     * held at once and because the OS repeats a held key: without this, the
     * second key's release would end a bend the first key is still asking for.
     */
    const bending = new Set<string>()

    /**
     * SHIFT (v0.5.0) — the keyboard's version of the FLX4's physical SHIFT
     * button: global, not per-deck (`ctl.setShiftHeld`). A `Set` of the
     * physical codes currently down, same reason as `bending` above — either
     * key can be held, and the other one's release must not drop the flag
     * while the first is still down.
     */
    const shiftCodes = new Set<string>()

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      // The Settings screen has its own keyboard; a stray D there must not
      // bend a deck that is playing to the room.
      if (settingsOpenRef.current || keysOpenRef.current) return
      // A focused knob or fader steps on its own arrow keys; the library
      // selection moving too was two things at once from one key press.
      if (e.target instanceof HTMLElement && e.target.getAttribute('role') === 'slider' && e.code.startsWith('Arrow')) return

      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        if (!shiftCodes.has(e.code)) {
          shiftCodes.add(e.code)
          ctl.setShiftHeld(true)
        }
        return
      }

      const bend = bendKeys[e.code]
      if (bend) {
        // Auto-repeat re-sends keydown while the key is simply still down. It
        // is not a new press, and re-applying would restart the bend on every
        // repeat, so the decay never gets to run.
        if (e.repeat || bending.has(e.code)) return
        bending.add(e.code)
        ctl.bendDeck(bend[0], bend[1] * settings.values.keyboardBend)
        return
      }

      switch (e.code) {
        case 'KeyQ':
          ctl.togglePlay('A')
          break
        case 'KeyP':
          ctl.togglePlay('B')
          break
        case 'KeyA':
          ctl.cue('A')
          break
        case 'Semicolon':
          ctl.cue('B')
          break
        case 'ArrowUp':
          ctl.moveSelection(-1)
          e.preventDefault()
          break
        case 'ArrowDown':
          ctl.moveSelection(1)
          e.preventDefault()
          break
        case 'BracketLeft': {
          const t = ctl.selectedTrack()
          if (t) void ctl.loadTrackToDeck('A', t)
          break
        }
        case 'BracketRight': {
          const t = ctl.selectedTrack()
          if (t) void ctl.loadTrackToDeck('B', t)
          break
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        shiftCodes.delete(e.code)
        if (shiftCodes.size === 0) ctl.setShiftHeld(false)
        return
      }
      const bend = bendKeys[e.code]
      if (!bend || !bending.delete(e.code)) return
      // Only the last bend key for this deck releases it: letting go of one
      // while the other is still held should leave that one bending.
      const stillHeld = Object.entries(bendKeys).some(
        ([code, [deck]]) => deck === bend[0] && bending.has(code),
      )
      if (!stillHeld) ctl.releaseBend(bend[0])
    }

    /**
     * A key held while the window loses focus never sends its keyup, and the
     * deck would stay bent with nothing on screen saying why. Releasing on blur
     * is the visible-degradation rule applied to a stuck key.
     */
    const onBlur = () => {
      for (const code of bending) {
        const bend = bendKeys[code]
        if (bend) ctl.releaseBend(bend[0])
      }
      bending.clear()
      if (shiftCodes.size > 0) {
        shiftCodes.clear()
        ctl.setShiftHeld(false)
      }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TopBar
        onOpenSettings={() => {
          setSettingsGroup('hardware')
          setSettingsOpen(true)
        }}
        onOpenLegal={() => {
          setSettingsGroup('legal')
          setSettingsOpen(true)
        }}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenKeys={() => setKeysOpen(true)}
        onOpenTagging={() => setTaggingOpen(true)}
      />
      {/* Anything the app refused or quietly substituted says so here. It sits
          under the top bar rather than in a corner toast because a refusal the
          user misses is the same as no refusal at all. */}
      {storageNotice && (
        <div
          className={`flex shrink-0 items-center gap-2 px-4 py-1.5 text-2xs ${
            storageNotice.tone === 'warn' ? 'bg-warn/12 text-warn' : 'bg-surface-2 text-grid-muted'
          }`}
        >
          <span className="min-w-0 flex-1">{storageNotice.text}</span>
          <button
            onClick={() => useStore.getState().set('storageNotice', null)}
            className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 hover:bg-surface-3"
          >
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <div
          className={`flex shrink-0 items-center gap-2 px-4 py-1.5 text-2xs ${
            notice.tone === 'warn' ? 'bg-warn/12 text-warn' : 'bg-surface-2 text-grid-muted'
          }`}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button
            onClick={() => setNotice(null)}
            className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 hover:bg-surface-3"
          >
            Dismiss
          </button>
        </div>
      )}
      <TransitionRatingPrompt />
      <AiControlBar />
      <main className="grid shrink-0 grid-cols-[1fr_auto_1fr] gap-3 p-3">
        <Deck deckId="A" />
        <Mixer />
        <Deck deckId="B" />
      </main>
      <div className="min-h-[200px] flex-1 px-3 pb-3">
        <Library />
      </div>
      {settingsOpen && (
        <SettingsScreen onClose={() => setSettingsOpen(false)} initialGroup={settingsGroup} />
      )}
      {historyOpen && <SetHistoryScreen onClose={() => setHistoryOpen(false)} />}
      {keysOpen && <KeysScreen onClose={() => setKeysOpen(false)} />}
      {taggingOpen && <TaggingScreen onClose={() => setTaggingOpen(false)} />}
    </div>
  )
}
