/**
 * Where a song's sound actually ends (v0.9.70).
 *
 * Why this exists: a file's length is not the song's length. Of the owner's 345 readable tracks, 55 end in more than 2 s of near-silence
 * (below -60 dBFS), 15 in more than 5 s, and one (Travis Scott, "Goosebumps") in 69 s (18/10, `research/soundcraft-2026-10-18`). Everything
 * that reasons about "how much song is left" — the countdown on the deck, Mix Assist's last possible join, its "enough song after the mix"
 * check — read the file length, so for those songs a mix could be planned into the silence: A runs out, B never starts, the room goes quiet.
 *
 * Only a silent tail of at least `MIN_DEAD_TAIL_SEC` moves the end. A normal fade-out or a 0.3 s gap is the song, and measuring it would shift
 * every other song's countdown by a fraction of a second for nothing; below the threshold the end is the file's length, exactly as before.
 */

/** Below this, a sample is silence. -60 dBFS: -48 counted ordinary fade-outs as dead air (half of the library); -60 only real silence. */
export const AUDIBLE_FLOOR_DB = -60

/** A silent tail shorter than this is not moved: it is a fade or a gap inside the song, not dead air. */
export const MIN_DEAD_TAIL_SEC = 2

/**
 * The second at which the last audible sample ends, or `durationSec` when the tail is shorter than `MIN_DEAD_TAIL_SEC` (or the whole file is
 * silent — the end of a silent file is not "0", it is simply not known). Scans backwards from the end and stops at the first loud sample, so a
 * normal song costs a few thousand samples, not a pass over the file.
 */
export function audibleEndSec(channels: ArrayLike<ArrayLike<number>>, sampleRate: number, durationSec: number): number {
  if (!(sampleRate > 0) || !(durationSec > 0) || channels.length === 0) return durationSec
  const len = channels[0].length
  if (len === 0) return durationSec
  const floor = 10 ** (AUDIBLE_FLOOR_DB / 20)
  for (let i = len - 1; i >= 0; i--) {
    for (let c = 0; c < channels.length; c++) {
      if (Math.abs(channels[c][i]) > floor) {
        const endSec = Math.min(durationSec, (i + 1) / sampleRate)
        return durationSec - endSec >= MIN_DEAD_TAIL_SEC ? endSec : durationSec
      }
    }
  }
  return durationSec
}

/** The end to reason with: the measured one, or the file's length while none is known (0, a deck with nothing measured yet). */
export function songEndSec(audibleEnd: number | undefined, durationSec: number): number {
  return audibleEnd != null && audibleEnd > 0 && audibleEnd < durationSec ? audibleEnd : durationSec
}
