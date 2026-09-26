/**
 * The deck's whole-track overview strip (v0.12.0): the analysed peaks folded
 * down to one column per pixel, once per track and width — never per frame.
 *
 * Pure so the folding can be tested: every bucket of the track must land in
 * a column. The first draft sampled one bucket per column, and a 6-minute
 * track at 420 columns showed one bucket in ~30, so a short drop or break
 * could fall between samples and simply not be on the map.
 */

/** Values per column in the array `overviewColumns` returns. */
export const OVERVIEW_STRIDE = 5

/**
 * Folds `peaks` (min/max interleaved) and `bands` (low/mid/high interleaved,
 * one triple per peak bucket) into `columns` columns. Each column holds
 * [min, max, low, mid, high]: the extremes of every bucket under it, and each
 * band's *mean* over those buckets — a mean, not a sum, so "is this column
 * quiet" means the same thing however many buckets a column covers.
 *
 * With more columns than buckets (a very short sample) neighbouring columns
 * repeat a bucket rather than leaving gaps.
 */
export function overviewColumns(
  peaks: Float32Array,
  bands: Float32Array | null,
  columns: number,
): Float32Array {
  const cols = Math.max(0, Math.floor(columns))
  const out = new Float32Array(cols * OVERVIEW_STRIDE)
  const buckets = Math.floor(peaks.length / 2)
  if (cols === 0 || buckets === 0) return out
  const hasBands = !!bands && bands.length >= buckets * 3
  for (let c = 0; c < cols; c++) {
    const from = Math.floor((c * buckets) / cols)
    const to = Math.min(buckets, Math.max(from + 1, Math.floor(((c + 1) * buckets) / cols)))
    let mn = 0
    let mx = 0
    let lo = 0
    let md = 0
    let hi = 0
    for (let b = from; b < to; b++) {
      if (peaks[b * 2] < mn) mn = peaks[b * 2]
      if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1]
      if (hasBands) {
        lo += bands![b * 3]
        md += bands![b * 3 + 1]
        hi += bands![b * 3 + 2]
      }
    }
    const n = to - from
    const o = c * OVERVIEW_STRIDE
    out[o] = mn
    out[o + 1] = mx
    out[o + 2] = lo / n
    out[o + 3] = md / n
    out[o + 4] = hi / n
  }
  return out
}

/** Track second under a pointer `x` CSS px into a strip `width` px wide, clamped to the track. */
export function overviewSecAt(x: number, width: number, durationSec: number): number {
  if (!(width > 0) || !(durationSec > 0)) return 0
  return Math.max(0, Math.min(durationSec, (x / width) * durationSec))
}
