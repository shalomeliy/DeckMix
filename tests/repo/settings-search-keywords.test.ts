import { describe, expect, it } from 'vitest'
import { FIELDS } from '@/core/settings.ts'
import { PANEL_ENTRIES } from '@/core/settings-search.ts'
import { read } from './repo'

/**
 * v0.9.55: the Settings search understands Hebrew because every setting
 * carries Hebrew words of its own. A setting added later without them would
 * be invisible to a Hebrew search, and nothing on screen would say so — so
 * the gap fails here instead.
 */
const HEBREW = /[א-ת]/
const LATIN = /[a-z]/i

describe('every setting can be found in Hebrew and in English', () => {
  const all = [
    ...FIELDS.map((f) => ({ id: f.key, keywords: f.keywords })),
    ...PANEL_ENTRIES.map((p) => ({ id: p.id, keywords: p.keywords })),
  ]
  for (const e of all) {
    it(e.id, () => {
      expect(e.keywords.some((k) => HEBREW.test(k)), `${e.id} has no Hebrew keyword`).toBe(true)
      expect(e.keywords.some((k) => LATIN.test(k)), `${e.id} has no English keyword`).toBe(true)
    })
  }
})

describe('every hand-written block on the Settings screen has a search entry', () => {
  // A block that is not in FIELDS is wrapped in id="setting-<id>" so a search
  // result can jump to it. A fifth block added without a PANEL_ENTRIES row
  // would be unfindable, and "No setting matches" would not say why.
  it('the wrappers in Settings.tsx and PANEL_ENTRIES name the same blocks', () => {
    const src = read('src/app/components/Settings.tsx')
    const wrapped = [...src.matchAll(/id="setting-(\w+)"/g)].map((m) => m[1]).sort()
    expect(wrapped).toEqual(PANEL_ENTRIES.map((p) => p.id).sort())
  })
})
