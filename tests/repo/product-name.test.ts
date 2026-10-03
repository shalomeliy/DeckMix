import { describe, expect, it } from 'vitest'
import { git, read, requireGit } from './repo.ts'

/**
 * v0.8.19 renamed the app from SoundGrid to DeckMix. "SoundGrid" is very
 * likely a Waves Audio trademark in audio software, and Shalom chose the new
 * name on 23/09 after a WIPO Global Brand Database search came back empty
 * for it. So the old name must not come back on any screen, file name or
 * dialog.
 *
 * The storage keys followed in v0.8.20 (`deckmix:`), and the data under the
 * old `soundgrid:` keys is moved on first load. That move module is the one
 * place that still names the old prefix. The internal drag-and-drop MIME types
 * and the folder-picker `id` keep the old name, since nobody ever sees them. The old
 * sampler-bank export name is kept only so a new export can overwrite an old
 * one (see `sampler-bank-fsaccess`).
 */

/**
 * Every storage key as of v0.8.20. They moved from `soundgrid:` to `deckmix:`
 * then, carried across by `platform/storage-rename/migrate.ts`. A key renamed
 * again without its own move hides that data from the owner.
 */
const STORAGE_KEYS = [
  'deckmix:ai-local:warningAcknowledged',
  'deckmix:analysisCache:',
  'deckmix:bootLatency',
  'deckmix:crates',
  'deckmix:cues:',
  'deckmix:embeddingCache:',
  'deckmix:fx:racks',
  'deckmix:genreOverrides',
  'deckmix:gridCorrection:',
  'deckmix:genreOverrides:migratedToHash',
  'deckmix:genreOverridesByHash',
  'deckmix:keyMode',
  'deckmix:libraryDir',
  'deckmix:midiMapping',
  'deckmix:mixpairs:',
  'deckmix:mixratings:',
  'deckmix:sampler:bank',
  'deckmix:sampler:recording:',
  'deckmix:settings',
  // v0.9.0: the owner's tags, the ground truth the bar/vocal detectors are graded on.
  'deckmix:tag:bar:',
  // v0.9.1: the "1" marked on the waveform — its own prefix, so a re-tag never overwrites the 4-button answer it is compared with.
  'deckmix:tag:mark:',
  // v0.12.8: the blind tie-break on songs whose two answers disagree.
  'deckmix:tag:decide:',
  // v0.9.5: the round on songs the detector was never tuned on.
  'deckmix:tag:fresh:',
  'deckmix:tag:vocal:',
  // v0.9.11: the blind re-check of already-answered vocal clips; new in this version, so nothing old to migrate.
  'deckmix:tag:vocalreview:',
  'deckmix:tempo2:',
  'deckmix:trackMeta',
]

/** The internal identifiers above, which the owner never sees. */
const EXEMPT = /soundgrid:[\w:-]*|x-soundgrid-[\w-]+|soundgrid-music|soundgrid-sampler-bank|soundgrid@[\d.]+/gi

const userFacingFiles = (): string[] => {
  requireGit()
  return git('ls-files', 'src', 'public', 'index.html').split('\n').filter(Boolean)
}

describe('the product is called DeckMix', () => {
  it('the browser tab says DeckMix', () => {
    expect(read('index.html')).toMatch(/<title>DeckMix\b/)
  })

  it('no user-facing source file says "SoundGrid", in any spelling', () => {
    // Tags are stripped first. The top bar spelled the name as
    // `Sound<span>Grid</span>`, and a plain substring search passed right
    // over it. The first version of this very check did exactly that, and the
    // old name stayed on screen.
    const offenders = userFacingFiles().filter((f) =>
      /sound\s*grid/i.test(read(f).replace(/<[^<>]*>/g, '').replace(EXEMPT, '')),
    )
    expect(offenders, 'the old product name is back in these files').toEqual([])
  })

  it('files the owner saves are named deckmix-*', () => {
    const controls = read('src/controls.ts')
    expect(controls).toContain('deckmix-recording-')
    expect(controls).toContain('deckmix-setlist-')
    expect(read('src/platform/sampler-bank-fsaccess/store.ts')).toContain(`'deckmix-sampler-bank'`)
    expect(read('src/platform/sampler-idb/store.ts')).toContain(`'deckmix-sampler-bank.json'`)
  })

  it('every storage key is a deckmix: key, and the list did not change behind the move', () => {
    const found = new Set<string>()
    for (const f of userFacingFiles()) {
      if (f === 'src/core/storage-rename.ts') continue
      for (const m of read(f).matchAll(/'(deckmix:[^']+)'/g)) found.add(m[1])
    }
    expect([...found].sort()).toEqual([...STORAGE_KEYS].sort())
  })

  it('only the move itself still names the old soundgrid: prefix', () => {
    const offenders = userFacingFiles().filter(
      (f) => f !== 'src/core/storage-rename.ts' && f !== 'src/platform/storage-rename/migrate.ts' && f !== 'src/main.tsx' && /soundgrid:/i.test(read(f)),
    )
    expect(offenders, 'a store reads an old key, which the move has already emptied').toEqual([])
  })

  it('the drag-and-drop types and the folder-picker id keep their old names', () => {
    expect(read('src/app/components/Deck.tsx')).toContain(`'application/x-soundgrid-track'`)
    expect(read('src/app/components/PadGrid.tsx')).toContain(`'application/x-soundgrid-hotcue'`)
    expect(read('src/platform/source-fsaccess/library.ts')).toContain(`id: 'soundgrid-music'`)
  })
})
