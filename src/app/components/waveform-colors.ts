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
