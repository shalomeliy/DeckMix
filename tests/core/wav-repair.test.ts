import { describe, expect, it } from 'vitest'
import { repairWav } from '@/core/wav-repair'

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
const chunk = (id: string, body: number[]) => [...ascii(id), ...u32(body.length), ...body, ...(body.length & 1 ? [0] : [])]
function wav(...chunks: number[][]): Uint8Array {
  const body = chunks.flat()
  return Uint8Array.from([...ascii('RIFF'), ...u32(4 + body.length), ...ascii('WAVE'), ...body])
}
const fmt = chunk('fmt ', [1, 0, 2, 0, 0x44, 0xac, 0, 0, 0x10, 0xb1, 2, 0, 4, 0, 16, 0])
const data = chunk('data', [1, 2, 3, 4, 5, 6, 7, 8])

describe('repairWav', () => {
  it('drops the empty LIST the owner\'s two House WAVs end with, and fixes the RIFF size', () => {
    const out = repairWav(wav(chunk('JUNK', new Array(28).fill(0)), fmt, data, chunk('LIST', [])))!
    expect(out).not.toBeNull()
    expect(out).toEqual(wav(chunk('JUNK', new Array(28).fill(0)), fmt, data))
  })
  it('leaves a healthy WAV alone', () => {
    expect(repairWav(wav(fmt, data, chunk('LIST', ascii('INFO'))))).toBeNull()
  })
  it('keeps the pad byte of an odd-sized chunk in step, and drops an empty LIST in the middle', () => {
    const odd = chunk('data', [1, 2, 3])
    expect(repairWav(wav(fmt, chunk('LIST', []), odd, chunk('LIST', [])))).toEqual(wav(fmt, odd))
  })
  it('does not run past a chunk that claims more bytes than the file has', () => {
    const b = wav(fmt, data)
    new DataView(b.buffer).setUint32(12 + fmt.length + 4, 1000, true)
    expect(repairWav(b)).toBeNull()
  })
  it('leaves anything that is not RIFF/WAVE alone', () => {
    expect(repairWav(Uint8Array.from(ascii('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000')))).toBeNull()
  })
})
