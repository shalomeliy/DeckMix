import { describe, expect, it } from 'vitest'
import { FIELDS } from '@/core/settings.ts'
import { PANEL_ENTRIES, SEARCH_SUGGESTIONS, normalize, searchSettings, tokenize } from '@/core/settings-search.ts'

const ids = (q: string) => searchSettings(q).hits.map((h) => h.id)

describe('settings search (v0.9.55)', () => {
  it('finds nothing for an empty or blank query, so the tabs show', () => {
    expect(searchSettings('').hits).toEqual([])
    expect(searchSettings('   ').hits).toEqual([])
  })

  it('matches an English label and marks where', () => {
    const hit = searchSettings('show key').hits.find((h) => h.id === 'keyMode')
    expect(hit).toBeDefined()
    expect(hit!.label).toEqual([
      [0, 4],
      [5, 8],
    ])
    expect(hit!.reasons).toEqual([])
  })

  it('finds a setting from a Hebrew word and says which hidden word matched', () => {
    const hit = searchSettings('סולם').hits.find((h) => h.id === 'keyMode')
    expect(hit?.reasons).toEqual(['סולם'])
    expect(hit?.label).toEqual([])
  })

  it('ignores niqqud, geresh and a Hebrew prefix letter', () => {
    expect(ids('סוּלָּם')).toContain('keyMode')
    expect(ids('ג׳וג')).toContain('jogTicksPerRev')
    expect(ids('גוג')).toContain('jogTicksPerRev')
    expect(ids('הסולם')).toContain('keyMode')
  })

  it('needs every word typed, and the start of a word is enough', () => {
    expect(ids('jog')).toEqual(expect.arrayContaining(['jogTicksPerRev', 'bendPerTick', 'jogSmoothing', 'jogMeasure']))
    expect(ids('jog smooth')).toEqual(['jogSmoothing'])
    expect(ids('camel')).toContain('keyMode')
  })

  it('does not match the middle of a word', () => {
    // "latter" is inside "Platter" but starts no word there.
    expect(ids('latter')).not.toContain('platterRpm')
  })

  it('highlights the help line when the word is there', () => {
    const hit = searchSettings('camelot').hits.find((h) => h.id === 'keyMode')
    expect(hit?.label).toEqual([])
    expect(hit?.help.length).toBeGreaterThan(0) // "Camelot numbers" is in the help line too
  })

  it('names the option when only the option matched', () => {
    const hit = searchSettings('semitone').hits.find((h) => h.id === 'mixAssistKeySync')
    expect(hit).toBeDefined()
    const opt = searchSettings('rpm').hits.find((h) => h.id === 'platterRpm')
    expect(opt?.reasons).toEqual(['33⅓ RPM'])
  })

  it('a tab name brings that whole tab', () => {
    const r = searchSettings('controller')
    expect(r.groups.map((g) => g.section)).toContain('hardware')
    const hw = r.groups.find((g) => g.section === 'hardware')!
    expect(hw.hits.length).toBe(FIELDS.filter((f) => f.group === 'hardware').length + 1)
  })

  it('finds each of the four blocks that are not in FIELDS', () => {
    expect(ids('measure the jog')).toContain('jogMeasure')
    expect(ids('ייצוא סאמפלים')).toContain('samplerBank')
    expect(ids('אוזניות')).toContain('system')
    expect(ids('פרטיות')).toContain('legal')
    expect(PANEL_ENTRIES.map((p) => p.id)).toEqual(['jogMeasure', 'samplerBank', 'genreCoverage', 'mixPairs', 'gridCheck', 'system', 'legal'])
  })

  it('groups results by tab, in screen order', () => {
    const r = searchSettings('jog')
    expect(r.groups.map((g) => g.section)).toEqual(['hardware', 'feel'])
    expect(r.hits).toEqual(r.groups.flatMap((g) => g.hits))
  })

  it('keeps highlights in place after a character that lowercases to two', () => {
    expect(normalize('İx').map).toEqual([0, 0, 1])
  })

  it('returns nothing for a word nothing has', () => {
    expect(searchSettings('zzzqx').hits).toEqual([])
  })

  it('every suggestion shown under "no results" finds something', () => {
    for (const s of SEARCH_SUGGESTIONS) expect(ids(s).length, s).toBeGreaterThan(0)
  })

  it('splits a query on spaces and punctuation, keeping ± and %', () => {
    expect(tokenize('  Jog,  ±8% ')).toEqual(['jog', '±8%'])
  })
})
