import { useEffect, useState } from 'react'
import { create } from 'zustand'

/**
 * A short flash on the control that just did something (v0.9.62). A press on the FLX4 gave no sign on screen that it was received; the
 * actions below call `pressFlash` from `controls.ts`, so a click, a key, MIDI and AI all light the same place.
 *
 * Only discrete actions may call this. Never the jog (~670 messages a second) and never anything drawn every frame: a flash re-renders
 * the one component that listens to its key, and a stream of them would be the stutter v0.9.58 spent a version removing.
 * `prefers-reduced-motion` already shortens every animation to nothing (`index.css`), so the flash is skipped for those users, as today.
 */
export const FLASH_MS = 150

export type FlashKey = `deck:${'A' | 'B'}` | `sync:${'A' | 'B'}` | 'mix' | `export:${'A' | 'B'}`

const useFlashStore = create<{ key: FlashKey | null; n: number }>(() => ({ key: null, n: 0 }))

export function pressFlash(key: FlashKey): void {
  useFlashStore.setState((s) => ({ key, n: s.n + 1 }))
}

/** True for FLASH_MS after each `pressFlash(key)`; a second press inside that window restarts it. */
export function useFlash(key: FlashKey): boolean {
  // The press counter, only for this key: other keys' presses leave this selector's value unchanged, so they do not re-render this component.
  const n = useFlashStore((s) => (s.key === key ? s.n : 0))
  const [lit, setLit] = useState(0)
  useEffect(() => {
    // Another key pressed inside the window drops this key's counter to 0: the class must go with it, not wait for a timer that cleanup cleared.
    if (!n) {
      setLit(0)
      return
    }
    setLit(n)
    const id = window.setTimeout(() => setLit(0), FLASH_MS)
    return () => window.clearTimeout(id)
  }, [n])
  return lit !== 0
}
