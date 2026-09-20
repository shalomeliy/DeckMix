import { describe, expect, it } from 'vitest'
import { analysisCacheKey } from '@/core/analysis-cache'

describe('analysisCacheKey', () => {
  it('is the bare hash when no tag tempo was used', () => {
    expect(analysisCacheKey('abc', null)).toBe('abc')
  })

  it('separates the same bytes analysed around different tag tempos', () => {
    expect(analysisCacheKey('abc', 100)).not.toBe(analysisCacheKey('abc', 128))
    expect(analysisCacheKey('abc', 100)).not.toBe(analysisCacheKey('abc', null))
  })
})
