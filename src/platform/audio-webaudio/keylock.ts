/**
 * The key lock's stretch node (v0.9.20): Signalsmith Stretch, MIT (notice in `public/third-party-notices.txt`). Since v0.9.27 it is
 * our own rebuild in `vendor/signalsmith-stretch/` (still imported as 'signalsmith-stretch', a `file:` dependency): the author's 1.3.2
 * put every shifted note 1-2.5 Hz sharp, which is +86 cents at 50 Hz - an out-of-tune bassline under the key lock. Going back to the
 * npm package brings that back; `tests/platform/keylock-pitch.test.ts` fails if it does.
 * The owner chose the library on 05/10 ("use the small free library, it's enough") over writing a time-stretcher from scratch:
 * a phase vocoder that does not smear drums or sound "phasey" is years of specialist work (ROADMAP.md, old v0.9.0).
 *
 * Used in live-input mode: the deck's own player stays the transport (position, loops, scratch, SYNC), and only its output passes through.
 * Loaded on demand — the library is ~110 KB with its WASM inlined, and most sets never touch the key lock.
 */

/** The parts of the library's node this app uses. The package ships no types. */
export interface StretchNode extends AudioNode {
  schedule(change: { active?: boolean; semitones?: number; output?: number }): Promise<unknown>
  configure(config: { blockMs?: number; intervalMs?: number }): Promise<unknown>
  latency(): Promise<number>
}

/**
 * The stretch's block, in ms. Its latency is the block (measured in Chromium: 120 ms at the library's default, 60 ms here, 40 ms at 40).
 * 120 ms is longer than a sixteenth note at 128 BPM (117 ms) — a hot cue pressed on the beat would land a sixteenth late — so half of it;
 * shorter blocks smear low notes more. Chosen, not tuned by ear: the owner's ear decides.
 */
export const KEY_LOCK_BLOCK_MS = 60

/** One stretch node per deck, on `ctx`. Throws (with the library's own reason) when it cannot be built; the engine names that on screen. */
export async function createKeyLockNode(ctx: AudioContext): Promise<{ node: StretchNode; latencySec: number }> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch')
  const node = (await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })) as StretchNode
  await node.configure({ blockMs: KEY_LOCK_BLOCK_MS })
  const reported = await node.latency()
  if (!(reported >= 0 && reported < 1)) throw new Error(`the key lock reported a latency of ${reported} s`)
  // Measured in the running app (scripts/verify-key-lock.mjs, clicks against the position): the sound comes out 0–20 ms later than the
  // reported latency, varying from run to run with where the stretch's hop (block/4 = 15 ms) falls — 9 ms late on average over five runs.
  // Half a hop on top centres that spread on zero instead of leaving every keyed deck a little behind the plain one.
  return { node, latencySec: reported + KEY_LOCK_BLOCK_MS / 4 / 2 / 1000 }
}
