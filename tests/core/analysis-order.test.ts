import { describe, expect, it } from 'vitest'
import { deckTrackNeeds, takeNextForAnalysis } from '@/core/analysis-order'

describe('takeNextForAnalysis', () => {
  it('takes a track that needs analysis first ahead of queue order', () => {
    const q = ['a', 'b', 'c']
    expect(takeNextForAnalysis(q, (x) => x === 'c')).toBe('c')
    expect(q).toEqual(['a', 'b'])
  })

  it('falls back to queue order when nothing is urgent — never skips a track', () => {
    const q = ['a', 'b']
    const out = [takeNextForAnalysis(q, () => false), takeNextForAnalysis(q, () => false)]
    expect(out).toEqual(['a', 'b'])
    expect(takeNextForAnalysis(q, () => false)).toBeUndefined()
  })

  it('re-asks at every pick, so a need that appears mid-queue is honoured', () => {
    const q = ['a', 'b', 'c']
    const urgent = new Set<string>()
    expect(takeNextForAnalysis(q, (x) => urgent.has(x))).toBe('a')
    urgent.add('c')
    expect(takeNextForAnalysis(q, (x) => urgent.has(x))).toBe('c')
    expect(takeNextForAnalysis(q, (x) => urgent.has(x))).toBe('b')
  })
})

// v0.9.49: a song loaded onto a deck while 239 rows were queued read "vocal: not analysed yet" — its strip waited for the whole library.
describe('deckTrackNeeds', () => {
  const ready = { state: 'ready' as const, timeline: null }
  const emb = new Float32Array(25)
  it('asks for the strip and the fingerprint of a freshly analysed deck track', () => {
    expect(deckTrackNeeds({ analysisState: 'analyzed', contentHash: 'h' })).toEqual({ vocal: true, embedding: true })
  })
  it('asks only for what is missing, and for nothing when both are there', () => {
    expect(deckTrackNeeds({ analysisState: 'analyzed', contentHash: 'h', vocal: ready })).toEqual({ vocal: false, embedding: true })
    expect(deckTrackNeeds({ analysisState: 'analyzed', contentHash: 'h', vocal: ready, embedding: emb })).toBeNull()
  })
  it('redoes a strip a genre change left queued, or a cancelled pass left half done', () => {
    for (const state of ['queued', 'analysing'] as const)
      expect(deckTrackNeeds({ analysisState: 'analyzed', contentHash: 'h', vocal: { state, timeline: null }, embedding: emb })).toEqual({ vocal: true, embedding: false })
  })
  it('waits while the track has no identity or no BPM pass yet', () => {
    expect(deckTrackNeeds({ analysisState: 'analyzed' })).toBeNull()
    expect(deckTrackNeeds({ analysisState: 'queued', contentHash: 'h' })).toBeNull()
  })
})
