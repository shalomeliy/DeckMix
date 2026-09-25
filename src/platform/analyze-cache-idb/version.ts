/**
 * Bump this whenever `core/beatgrid.ts` or `analyzer-js/analyze.ts` changes
 * meaningfully enough that a previously-cached `TrackAnalysis` might no
 * longer match what analysis would produce today (e.g. a `CONFIDENCE_RATIO`
 * retuning, a bug fix in the onset envelope). A cache entry stamped with an
 * older version is treated as a miss and re-analyzed — silently keeping a
 * stale result forever is exactly the "never skip silently" failure this
 * project's central rule forbids, and there is no way to detect "the
 * analyzer changed" automatically, so this is a deliberate manual step,
 * named here rather than left implicit. See `workshop-output/PLAN.md`
 * (v0.4.0) Risk 2.
 */
// 3 (v0.8.27): `TrackAnalysis` gained `key`. A version-2 entry has none, and
// read as "the audio picked no key" it would leave every untagged track keyless.
// 4 (v0.8.30): the key detector changed (three bands) — a version-3 key is
// the old, less accurate guess, and would stay on screen forever.
export const ANALYZER_VERSION = 4
