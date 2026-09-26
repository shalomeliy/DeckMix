// Shared by the deck's Waveform and the tagging screen's TagWaveform (v0.9.1) —
// its own file, so neither component file exports a non-component.

/*
 * Spectrum colours. The band mix at each column picks a colour, so the shape
 * tells you *what* is playing and not just how loud: bass hits read warm, a
 * vocal or synth lead reads green, hats and air read blue. It is how you spot
 * the breakdown, the drop and the intro without listening through the track.
 *
 * Red/green/blue for low/mid/high is a long-standing DJ convention and DJs read
 * it fluently, so this keeps it — and keeps it saturated. An earlier pass muted
 * these off the primaries to avoid glare and the whole waveform went to mush:
 * against a near-black panel there is no glare to avoid, only contrast to win.
 */
export const BAND_COLORS = [
  [255, 64, 52], // low
  [58, 226, 124], // mid
  [82, 152, 255], // high
] as const

/** Silence has no meaningful band ratio — colouring it would be noise. */
export const QUIET = 0.0015

/**
 * The deck's colour rule, for the overview strip (v0.12.0). NOT yet shared:
 * `Waveform.tsx` and `TagWaveform.tsx` keep inline copies that round the
 * weights to 20 steps (so neighbouring columns reuse a fillStyle every frame)
 * and test QUIET against a per-pixel *sum*; this one is unrounded and the
 * overview passes band *means*. A change to the rule goes in all three.
 * Weights are squared before mixing: one-pole filters leak across the splits,
 * so raw ratios never reach a band's own colour — pure 60Hz came out orange,
 * not red. `null` means quiet, which has no meaningful colour.
 */
export function bandRgb(lo: number, md: number, hi: number): [number, number, number] | null {
  if (lo + md + hi < QUIET) return null
  const q = 1 / (lo * lo + md * md + hi * hi)
  const wl = lo * lo * q
  const wm = md * md * q
  const wh = hi * hi * q
  return [
    (BAND_COLORS[0][0] * wl + BAND_COLORS[1][0] * wm + BAND_COLORS[2][0] * wh) | 0,
    (BAND_COLORS[0][1] * wl + BAND_COLORS[1][1] * wm + BAND_COLORS[2][1] * wh) | 0,
    (BAND_COLORS[0][2] * wl + BAND_COLORS[1][2] * wm + BAND_COLORS[2][2] * wh) | 0,
  ]
}
