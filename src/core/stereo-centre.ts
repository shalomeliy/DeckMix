import type { Spectrogram } from '@/core/spectrogram'

/**
 * How much of each frame sits in the middle of the stereo image — one cue for
 * "is there a lead voice here" (v0.9.10, research §6). It is only a cue: bass,
 * kick and many synths are also centred, so this never decides alone.
 *
 * A file whose two channels are the same (true mono, or a mono rip stored as
 * stereo) has *no* image to read: every frame would score 1.0 and the cue would
 * claim vocals everywhere. That case is reported as `mono: true` so the caller
 * shows "mono — less certain" (the named state the roadmap asks for) instead of
 * trusting the numbers.
 */
export interface StereoCentre {
  /** Per frame: 0 = hard-panned, 1 = identical in both channels. */
  centre: Float32Array
  mono: boolean
}

/** Above this share of near-identical frames the file is treated as mono. */
const MONO_FRAME_SHARE = 0.98
const MONO_CENTRE = 0.999
const SILENCE_ENERGY = 1e-10

export function stereoCentre(left: Spectrogram, right: Spectrogram): StereoCentre {
  if (left.frames.length !== right.frames.length) {
    throw new RangeError(`channel lengths differ: ${left.frames.length} vs ${right.frames.length} frames`)
  }
  const n = left.frames.length
  const centre = new Float32Array(n)
  let identical = 0
  let counted = 0
  for (let t = 0; t < n; t++) {
    const l = left.frames[t]
    const r = right.frames[t]
    let both = 0
    let total = 0
    for (let k = 0; k < l.length; k++) {
      const m = Math.min(l[k], r[k])
      both += 2 * m * m
      total += l[k] * l[k] + r[k] * r[k]
    }
    if (total < SILENCE_ENERGY) continue
    centre[t] = both / total
    counted++
    if (centre[t] >= MONO_CENTRE) identical++
  }
  return { centre, mono: counted > 0 && identical / counted >= MONO_FRAME_SHARE }
}
