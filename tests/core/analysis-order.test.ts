import { describe, expect, it } from 'vitest'
import { takeNextForAnalysis } from '@/core/analysis-order'

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
