import type { HistoryEntry } from '@/core/types'

/**
 * Plain-text setlist, one numbered line per entry, for pasting into a
 * post-set caption (v0.8.3 decision, closed with Shalom 13/09) — not a data
 * format, so no deck/BPM/timestamp columns.
 *
 * `setDate` is a parameter rather than `new Date()` read internally, so this
 * stays pure and testable without depending on the real clock — the same
 * shape `buildCueSheet` (`core/recording.ts`) uses for `sampleRate`.
 */
export function formatSetHistory(entries: HistoryEntry[], setDate: Date): string {
  const header = `DeckMix set — ${setDate.toISOString().slice(0, 10)}`
  const lines = entries.map((e, i) => `${i + 1}. ${e.artist ? `${e.artist} — ` : ''}${e.name}`)
  return [header, ...lines].join('\n') + '\n'
}
