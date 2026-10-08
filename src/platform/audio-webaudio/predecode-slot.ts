/**
 * The one slot of a song decoded ahead of time (v0.9.66). One, not a queue: a decoded song is 80–230 MB, and the plan
 * (`docs/research/predecode-next-plan.md` §1–2) keeps exactly one. `take` empties it — a deck load consumes the buffer, and no second
 * copy stays alive beside the one the deck owns.
 *
 * Also the status the Settings screen prints under the switch, so a skipped or failed decode is told, not swallowed.
 */
export type PredecodeStatus =
  | { state: 'idle' }
  | { state: 'decoding'; name: string }
  | { state: 'ready'; name: string; megabytes: number }
  | { state: 'skipped'; name: string; why: string }
  | { state: 'failed'; name: string; why: string }

interface Held {
  key: string
  buffer: AudioBuffer
  contentHash: string | undefined
}

let held: Held | null = null
let status: PredecodeStatus = { state: 'idle' }
const listeners = new Set<() => void>()

export function setPredecodeStatus(next: PredecodeStatus) {
  status = next
  for (const fn of listeners) fn()
}
export function getPredecodeStatus(): PredecodeStatus {
  return status
}
export function subscribePredecodeStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function putPredecoded(key: string, buffer: AudioBuffer, contentHash: string | undefined) {
  held = { key, buffer, contentHash }
}

export function hasPredecoded(key: string): boolean {
  return held?.key === key
}

/** Whether anything is held at all — a load asks this first so it does not even look at the file's metadata when the slot is empty. */
export function slotOccupied(): boolean {
  return held !== null
}

/** The buffer for `key`, once; `null` for any other key (the slot keeps what it has — a miss must not throw away a good decode). */
export function takePredecoded(key: string): { buffer: AudioBuffer; contentHash: string | undefined } | null {
  if (!held || held.key !== key) return null
  const { buffer, contentHash } = held
  held = null
  if (status.state === 'ready') setPredecodeStatus({ state: 'idle' })
  return { buffer, contentHash }
}

export function clearPredecoded() {
  held = null
  if (status.state === 'ready' || status.state === 'decoding') setPredecodeStatus({ state: 'idle' })
}
