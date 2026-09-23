import type { HotCue } from '@/core/types'

/**
 * Pure relocate/swap/no-op reducer for dragging a hot cue pad onto another
 * slot (v0.4.0 `PadGrid.tsx` drag-and-drop). Extracted from `controls.ts` so
 * the three cases are unit-testable without a store or engine.
 *
 * - `fromIndex` empty: no-op, same array reference back.
 * - `toIndex` empty: relocate — the cue takes `toIndex` and its label follows.
 * - `toIndex` occupied: swap — both cues exchange index and label.
 *
 * Always returns the result sorted by index, matching `setHotCue`'s existing
 * ordering (`controls.ts`).
 */
/**
 * A label nobody has renamed yet — always exactly the pad's own ordinal, set
 * by `setHotCue`. Exported so `controls.ts`'s `pressHotCue` (v0.4.7) can use
 * the same test as `moveHotCue` for "is this a plain jump cue or a saved
 * mix-in point" — one definition, not two that can drift apart.
 */
export function isOrdinalLabel(cue: HotCue): boolean {
  return cue.label === `${cue.index + 1}`
}

export function moveHotCue(cues: HotCue[], fromIndex: number, toIndex: number): HotCue[] {
  if (fromIndex === toIndex) return cues
  const from = cues.find((c) => c.index === fromIndex)
  if (!from) return cues
  const to = cues.find((c) => c.index === toIndex)
  // A plain numbered cue keeps its label in sync with wherever it lands
  // (unchanged since v0.4.0). A cue carrying a v0.4.7 descriptive name
  // (`saveMixEntryHotCue`) keeps that name instead — relabeling it to a bare
  // number on every drag would erase it silently, which this project's
  // central rule forbids just as much for a name as for a skipped file.
  const next = cues.map((c) => {
    if (c.index === fromIndex) {
      return { ...c, index: toIndex, label: isOrdinalLabel(c) ? `${toIndex + 1}` : c.label }
    }
    if (to && c.index === toIndex) {
      return { ...c, index: fromIndex, label: isOrdinalLabel(c) ? `${fromIndex + 1}` : c.label }
    }
    return c
  })
  return next.sort((a, b) => a.index - b.index)
}

/**
 * Whether pressing a pad should re-run the automatic transition
 * (`startAutoTransition`) instead of the plain jump-or-create `setHotCue`
 * always does. `controls.ts`'s `pressHotCue` (v0.4.9) calls this *before*
 * deciding — not just "is this a mix-in pad" — because a mix-in pad must
 * never become strictly worse than a plain one: if a transition genuinely
 * can't make sense right now (this deck is already playing, or there's
 * nothing on the other deck to mix from), pressing it should still fall
 * through to the ordinary seek, exactly like every other pad, rather than a
 * dead warning notice and no seek at all. `startAutoTransition`'s own other
 * refusals (no beat grid, a transition already running) still apply and
 * still show their own notice once this returns `true` — this only guards
 * the cases where attempting a transition was never the right call.
 */
export function shouldTriggerMixEntry(
  cue: HotCue | undefined,
  deckPlaying: boolean,
  otherDeckPlaying: boolean,
): boolean {
  return !!cue && cue.kind === 'mixEntry' && !deckPlaying && otherDeckPlaying
}

/**
 * The free-text part of a renamed or mix-entry pad's label, with this
 * project's own trailing "m:ss" position stripped back off — so reopening
 * the rename box pre-fills what the DJ actually typed (or "Mix in" for a
 * Mix Assist pad), not the timestamp that gets re-appended on every save
 * regardless. A plain (never-renamed) pad has no custom text to recover, so
 * this returns `''` for it rather than its ordinal number.
 *
 * The trailing separator is optional on purpose: `renameHotCue`/
 * `saveMixEntryHotCue` both write "<text> · m:ss" today, but a pad saved by
 * an older build of `saveMixEntryHotCue` (before v0.5.3 unified the format)
 * can still be sitting in a DJ's real, already-persisted library as the
 * bare "Mix m:ss" — no middot. Stripping only the newer shape there would
 * leave the whole label, timestamp included, as "custom text"; renaming
 * that pad would then glue a second, differently-formatted timestamp onto
 * the first one. Matching either shape means both old and new data recover
 * cleanly, and there is nothing left to migrate.
 */
export function customTextOf(cue: HotCue): string {
  if (isOrdinalLabel(cue)) return ''
  return cue.label.replace(/\s*(?:·\s*)?\d{1,3}:\d{2}$/, '')
}

/**
 * Which pad `saveMixEntryHotCue` (v0.4.7, `controls.ts`) should write to: the
 * first empty one (0..7, in order), or — when all 8 are already occupied —
 * the one with the oldest `createdAt` (missing `createdAt` counts as oldest
 * of all, per `HotCue`'s own doc comment). This eviction is always visible:
 * the pad it lands on changes in the Pad Grid immediately, never silently.
 */
export function pickHotCueSlot(cues: HotCue[]): number {
  for (let i = 0; i < 8; i++) {
    if (!cues.some((c) => c.index === i)) return i
  }
  let oldest = cues[0]
  for (const c of cues) {
    if ((c.createdAt ?? 0) < (oldest.createdAt ?? 0)) oldest = c
  }
  return oldest.index
}

/**
 * The label a saved mix-in pad gets: "Mix in · m:ss", the point's own track
 * time, so several mix-in pads on one deck read as distinct points. Same
 * "<text> · m:ss" shape `renameHotCue` writes, so `customTextOf` recovers
 * "Mix in" cleanly. Lives here since v0.8.14 moved the save from the click
 * (`Deck.tsx`) to the "Excellent" rating (`controls.ts`).
 */
export function mixEntryLabel(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `Mix in · ${m}:${s.toString().padStart(2, '0')}`
}

/** Already a mix-in pad within half a second of `sec`? Rating the same replayed pairing "Excellent" twice must not fill the pad grid with copies of one point. */
export function hasMixEntryNear(cues: HotCue[], sec: number): boolean {
  return cues.some((c) => c.kind === 'mixEntry' && Math.abs(c.positionSec - sec) < 0.5)
}
