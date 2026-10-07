import { describe, expect, it } from 'vitest'
import { analysisFingerprint, bootLatency, libraryAnalysisSettled } from '@/core/analysis-latency'

const NOW = analysisFingerprint({ analyzer: 6, embedder: 2, vocal: 5 })

describe('sound cushion while the library analyses (v0.9.52)', () => {
  it('a new analysis version boots on Balanced instead of the default', () => {
    const before = analysisFingerprint({ analyzer: 6, embedder: 2, vocal: 4 })
    expect(bootLatency('interactive', before, NOW)).toEqual({ hint: 'balanced', cushioned: true })
  })

  it('a session that never finished (nothing settled) boots cushioned, stored setting or not', () => {
    expect(bootLatency(null, null, NOW)).toEqual({ hint: 'balanced', cushioned: true })
    expect(bootLatency('interactive', null, NOW)).toEqual({ hint: 'balanced', cushioned: true })
  })

  it('once the analysis settled on these versions, the owner gets his own setting back', () => {
    expect(bootLatency('interactive', NOW, NOW)).toEqual({ hint: 'interactive', cushioned: false })
    expect(bootLatency(null, NOW, NOW)).toEqual({ hint: 'interactive', cushioned: false })
  })

  it('a profile he picked himself is never touched', () => {
    expect(bootLatency('playback', null, NOW)).toEqual({ hint: 'playback', cushioned: false })
    expect(bootLatency('balanced', null, NOW)).toEqual({ hint: 'balanced', cushioned: false })
  })

  it('every version that re-analyses moves the fingerprint', () => {
    const base = { analyzer: 6, embedder: 2, vocal: 5 }
    const all = [base, { ...base, analyzer: 7 }, { ...base, embedder: 3 }, { ...base, vocal: 6 }].map(analysisFingerprint)
    expect(new Set(all).size).toBe(4)
  })
})

describe('when the cushion may be declared over (v0.9.52)', () => {
  const emb = new Float32Array(1)
  const done = { analysisState: 'analyzed' as const, embedding: emb, vocal: { state: 'ready' as never, timeline: null } }
  it('every pass done on every row, failures included, is settled', () => {
    expect(libraryAnalysisSettled([done, { analysisState: 'failed' }, { ...done, embedding: undefined, embeddingState: 'failed' }])).toBe(true)
  })
  it('one row still queued for BPM is not — the Add files run that left the folder scan queued', () => {
    expect(libraryAnalysisSettled([done, { analysisState: 'queued' }])).toBe(false)
  })
  it('a row still waiting for similarity or its vocal strip is not', () => {
    expect(libraryAnalysisSettled([{ ...done, embedding: undefined }])).toBe(false)
    expect(libraryAnalysisSettled([{ ...done, vocal: undefined }])).toBe(false)
    expect(libraryAnalysisSettled([{ ...done, vocal: { state: 'queued', timeline: null } }])).toBe(false)
  })
})
