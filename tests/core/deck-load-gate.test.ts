import { describe, expect, it } from 'vitest'
import { beginDeckLoad, endDeckLoad, isDeckLoading } from '@/core/deck-load-gate'

describe('deck load gate', () => {
  it('stays loading until every load that began has ended', () => {
    expect(isDeckLoading()).toBe(false)
    beginDeckLoad()
    beginDeckLoad()
    endDeckLoad()
    expect(isDeckLoading()).toBe(true)
    endDeckLoad()
    expect(isDeckLoading()).toBe(false)
  })

  it('an extra end never makes the next load look finished', () => {
    endDeckLoad()
    beginDeckLoad()
    expect(isDeckLoading()).toBe(true)
    endDeckLoad()
  })
})
