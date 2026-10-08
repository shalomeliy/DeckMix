import { describe, expect, it } from 'vitest'
import {
  PREDECODE_MAX_BYTES,
  PREDECODE_MAX_SEC,
  PREDECODE_MIN_DEVICE_GB,
  decodedBytes,
  predecodeKey,
  predecodeSkipReason,
} from '@/core/predecode'

describe('predecodeSkipReason: a refusal always carries a sentence for the screen', () => {
  it('allows an ordinary song', () => {
    expect(predecodeSkipReason({ sizeBytes: 9 * 1048576, durationSec: 300, deviceMemoryGb: 8 })).toBeNull()
  })
  it('allows a song whose duration is not known yet when the file is small', () => {
    expect(predecodeSkipReason({ sizeBytes: 10 * 1048576 })).toBeNull()
  })
  it('refuses a song over the length limit, by name of the limit', () => {
    const why = predecodeSkipReason({ sizeBytes: 1000, durationSec: PREDECODE_MAX_SEC + 1 })
    expect(why).toMatch(/12/)
  })
  it('refuses a file over the size limit when the duration is unknown', () => {
    expect(predecodeSkipReason({ sizeBytes: PREDECODE_MAX_BYTES + 1 })).toMatch(/MB/)
  })
  it('refuses on a computer reporting little memory, and not when it does not report', () => {
    expect(predecodeSkipReason({ sizeBytes: 1000, deviceMemoryGb: PREDECODE_MIN_DEVICE_GB - 1 })).toMatch(/memory/)
    expect(predecodeSkipReason({ sizeBytes: 1000, deviceMemoryGb: undefined })).toBeNull()
    expect(predecodeSkipReason({ sizeBytes: 1000, deviceMemoryGb: PREDECODE_MIN_DEVICE_GB })).toBeNull()
  })
})

describe('predecodeKey: any change is a miss', () => {
  const base = predecodeKey('t1', 1000, 5, 48000)
  it('same file, same rate → same key', () => expect(predecodeKey('t1', 1000, 5, 48000)).toBe(base))
  it.each([
    ['another track', predecodeKey('t2', 1000, 5, 48000)],
    ['file size changed', predecodeKey('t1', 1001, 5, 48000)],
    ['file modified', predecodeKey('t1', 1000, 6, 48000)],
    ['another sample rate', predecodeKey('t1', 1000, 5, 44100)],
  ])('%s → different key', (_n, k) => expect(k).not.toBe(base))
})

describe('decodedBytes', () => {
  it('matches the 219 s stereo 48 kHz song measured on the owner PC (80 MB)', () => {
    expect(Math.round(decodedBytes(219 * 48000, 2) / 1048576)).toBe(80)
  })
})
