import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPredecoded,
  getPredecodeStatus,
  hasPredecoded,
  putPredecoded,
  setPredecodeStatus,
  slotOccupied,
  takePredecoded,
} from '@/platform/audio-webaudio/predecode-slot'

const buf = (n: number) => ({ length: n }) as unknown as AudioBuffer

describe('the one-slot store', () => {
  beforeEach(() => {
    clearPredecoded()
    setPredecodeStatus({ state: 'idle' })
  })

  it('a hit hands the buffer over once and empties the slot', () => {
    putPredecoded('k1', buf(1), 'hash1')
    const got = takePredecoded('k1')
    expect(got?.contentHash).toBe('hash1')
    expect(slotOccupied()).toBe(false)
    expect(takePredecoded('k1')).toBeNull()
  })

  it('a miss keeps what is held — a load of another song must not throw a good decode away', () => {
    putPredecoded('k1', buf(1), undefined)
    expect(takePredecoded('other')).toBeNull()
    expect(hasPredecoded('k1')).toBe(true)
  })

  it('putting a second song replaces the first: never two held', () => {
    putPredecoded('k1', buf(1), undefined)
    putPredecoded('k2', buf(2), undefined)
    expect(hasPredecoded('k1')).toBe(false)
    expect(hasPredecoded('k2')).toBe(true)
  })

  it('clearing empties the slot and drops a ready/decoding status but keeps a skipped or failed one visible', () => {
    putPredecoded('k1', buf(1), undefined)
    setPredecodeStatus({ state: 'ready', name: 'x', megabytes: 1 })
    clearPredecoded()
    expect(slotOccupied()).toBe(false)
    expect(getPredecodeStatus().state).toBe('idle')
    setPredecodeStatus({ state: 'failed', name: 'y', why: 'boom' })
    clearPredecoded()
    expect(getPredecodeStatus().state).toBe('failed')
  })

  it('taking the held song clears its ready status', () => {
    putPredecoded('k1', buf(1), undefined)
    setPredecodeStatus({ state: 'ready', name: 'x', megabytes: 1 })
    takePredecoded('k1')
    expect(getPredecodeStatus().state).toBe('idle')
  })
})
