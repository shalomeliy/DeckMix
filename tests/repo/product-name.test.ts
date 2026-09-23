import { describe, expect, it } from 'vitest'
import { git, read, requireGit } from './repo.ts'

/**
 * v0.8.19 renamed the app from SoundGrid to DeckMix. "SoundGrid" is very
 * likely a Waves Audio trademark in audio software, and Shalom chose the new
 * name on 23/09 after a WIPO Global Brand Database search came back empty
 * for it. So the old name must not come back on any screen, file name or
 * dialog.
 *
 * One part of the old name stays on purpose, and it is a named exemption, not
 * something the rename forgot: the `soundgrid:` storage keys. Every setting, cue,
 * rating, crate and the remembered library folder is saved under them in the
 * owner's own browser. Rename a key and the app stops finding that data. Nothing
 * gets deleted, but everything *looks* deleted, and the owner cannot tell the
 * difference. The internal drag-and-drop MIME types and the folder-picker `id`
 * stay too, and nobody ever sees them. The old sampler-bank export name is kept
 * only so a new export can overwrite an old one (see `sampler-bank-fsaccess`).
 */

/** Every storage key as of v0.8.19. Renaming any one hides that data from the owner. */
const STORAGE_KEYS = [
  'soundgrid:ai-local:warningAcknowledged',
  'soundgrid:analysisCache:',
  'soundgrid:bootLatency',
  'soundgrid:crates',
  'soundgrid:cues:',
  'soundgrid:embeddingCache:',
  'soundgrid:fx:racks',
  'soundgrid:genreOverrides',
  'soundgrid:genreOverrides:migratedToHash',
  'soundgrid:genreOverridesByHash',
  'soundgrid:keyMode',
  'soundgrid:libraryDir',
  'soundgrid:midiMapping',
  'soundgrid:mixpairs:',
  'soundgrid:mixratings:',
  'soundgrid:sampler:bank',
  'soundgrid:sampler:recording:',
  'soundgrid:settings',
  'soundgrid:tempo2:',
  'soundgrid:trackMeta',
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

  it('every storage key keeps its soundgrid: prefix, so no saved data looks lost', () => {
    const found = new Set<string>()
    for (const f of userFacingFiles()) {
      for (const m of read(f).matchAll(/['`](soundgrid:[^'`]*)['`]/g)) found.add(m[1])
    }
    expect([...found].sort()).toEqual([...STORAGE_KEYS].sort())
  })

  it('the drag-and-drop types and the folder-picker id keep their old names', () => {
    expect(read('src/app/components/Deck.tsx')).toContain(`'application/x-soundgrid-track'`)
    expect(read('src/app/components/PadGrid.tsx')).toContain(`'application/x-soundgrid-hotcue'`)
    expect(read('src/platform/source-fsaccess/library.ts')).toContain(`id: 'soundgrid-music'`)
  })
})
