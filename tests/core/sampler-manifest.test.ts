import { describe, expect, it } from 'vitest'
import { manifestFileNames } from '@/core/sampler'

/**
 * `manifestFileNames` (v0.8.9) is deliberately pure and DOM-free, same
 * reasoning as `core/recording.ts`'s `segmentFileNames` — the platform
 * layer's export (writing these names) and import (looking for them) both
 * derive from this one function, so the two can never drift apart. The rest
 * of `platform/sampler-bank-fsaccess/store.ts` is real File System Access
 * I/O, verified manually (v0.8.9's own verification notes), not simulated
 * in jsdom — same as `recorder-fsaccess/writer.ts` having no test file.
 */
describe('manifestFileNames', () => {
  it('names the JSON manifest after the base name alone', () => {
    expect(manifestFileNames('soundgrid-sampler-bank', []).jsonName).toBe('soundgrid-sampler-bank.json')
  })

  it('names one WAV per recording id, prefixed by the base name', () => {
    const { wavNames } = manifestFileNames('bank', ['abc', 'def'])
    expect(wavNames).toEqual(['bank-rec-abc.wav', 'bank-rec-def.wav'])
  })

  it('an empty recording list produces no WAV names', () => {
    expect(manifestFileNames('bank', []).wavNames).toEqual([])
  })

  it('a different base name changes every file name it produces', () => {
    const a = manifestFileNames('bank-one', ['x'])
    const b = manifestFileNames('bank-two', ['x'])
    expect(a.jsonName).not.toBe(b.jsonName)
    expect(a.wavNames).not.toEqual(b.wavNames)
  })
})
