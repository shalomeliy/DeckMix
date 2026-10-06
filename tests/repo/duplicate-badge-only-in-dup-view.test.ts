import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// v0.9.32: the owner (06/10) saw the yellow "≈×2 3:38 · WAV" badge beside
// titles in the plain track list and asked for it only in the Duplicates-only
// view. Library.tsx is a React component this suite can't render, so the wiring
// is pinned by reading the source: if the row gets the group unconditionally
// again, the badge comes back on every duplicate in the normal list.
describe('duplicate badge shows only in the Duplicates-only view (v0.9.32)', () => {
  it('TrackRow gets duplicate/duplicateNote only when dupOnly is on', () => {
    const src = readFileSync(new URL('../../src/app/components/Library.tsx', import.meta.url), 'utf8')
    expect(src).toContain('duplicate={dupOnly ? dupReport.byTrack.get(t.id) : undefined}')
    expect(src).toContain('const g = dupOnly ? dupReport.byTrack.get(t.id) : undefined')
    expect(src).not.toMatch(/duplicate=\{dupReport\.byTrack\.get/)
  })
})
