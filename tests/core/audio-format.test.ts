import { describe, expect, it } from 'vitest'
import { detectAudioFormat, extensionMismatch, id3TagLength, renamedWithExtension } from '@/core/audio-format'

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)))

describe('detectAudioFormat', () => {
  it('names the container formats from their signatures', () => {
    expect(detectAudioFormat(bytes([0, 0, 0, 24], 'ftypM4A '), false)).toBe('m4a')
    expect(detectAudioFormat(bytes('RIFF', [0, 0, 0, 0], 'WAVE'), false)).toBe('wav')
    expect(detectAudioFormat(bytes('fLaC', [0, 0, 0, 0]), false)).toBe('flac')
    expect(detectAudioFormat(bytes('OggS', [0, 0, 0, 0]), false)).toBe('ogg')
    expect(detectAudioFormat(bytes('FORM', [0, 0, 0, 0], 'AIFF'), false)).toBe('aiff')
    expect(detectAudioFormat(bytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), false)).toBe('webm')
  })
  it('does not call RIFF that is not WAVE a wav', () => {
    expect(detectAudioFormat(bytes('RIFF', [0, 0, 0, 0], 'AVI '), false)).toBeNull()
  })
  it('does not rename on a bare frame-sync: random bytes can start that way', () => {
    expect(detectAudioFormat(bytes([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), false)).toBeNull()
  })
  it('recognises mp3 behind an ID3 tag, and rejects a reserved layer', () => {
    expect(detectAudioFormat(bytes([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), true)).toBe('mp3')
    expect(detectAudioFormat(bytes([0xff, 0xf9, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), true)).toBeNull() // ADTS layer 00
  })
  it('returns null for text and for too-short input', () => {
    expect(detectAudioFormat(bytes('hello world!'), true)).toBeNull()
    expect(detectAudioFormat(bytes('fL'), true)).toBeNull()
  })
})

describe('id3TagLength', () => {
  it('reads the syncsafe size, with and without a footer', () => {
    expect(id3TagLength(bytes('ID3', [4, 0, 0, 0, 0, 2, 0]))).toBe(10 + 256)
    expect(id3TagLength(bytes('ID3', [4, 0, 0x10, 0, 0, 0, 5]))).toBe(10 + 5 + 10)
  })
  it('is 0 without a tag or with a size byte that is not syncsafe', () => {
    expect(id3TagLength(bytes('RIFF', [0, 0, 0, 0, 0, 0]))).toBe(0)
    expect(id3TagLength(bytes('ID3', [4, 0, 0, 0x80, 0, 0, 0]))).toBe(0)
  })
})

describe('extensionMismatch', () => {
  it('flags an M4A wearing .mp3 and suggests .m4a — the owner’s real case', () => {
    expect(extensionMismatch('mp3', 'm4a')).toEqual({ actual: 'm4a', suggestedExt: 'm4a' })
    expect(extensionMismatch('MP3', 'm4a')).toEqual({ actual: 'm4a', suggestedExt: 'm4a' })
  })
  it('accepts every extension of the right family', () => {
    for (const e of ['m4a', 'm4b', 'mp4']) expect(extensionMismatch(e, 'm4a')).toBeNull()
    for (const e of ['ogg', 'oga', 'opus']) expect(extensionMismatch(e, 'ogg')).toBeNull()
    for (const e of ['aif', 'aiff']) expect(extensionMismatch(e, 'aiff')).toBeNull()
  })
  it('never flags content it could not name, or an extension it does not know', () => {
    expect(extensionMismatch('mp3', null)).toBeNull()
    expect(extensionMismatch('aac', 'm4a')).toBeNull()
  })
})

describe('renamedWithExtension', () => {
  it('swaps only the extension, keeping Hebrew and punctuation in the base', () => {
    expect(renamedWithExtension('סטטיק - בלנסיאגה.mp3', 'm4a')).toBe('סטטיק - בלנסיאגה.m4a')
    expect(renamedWithExtension('Vorozhyla - Korolova, Rokston.mp3', 'm4a')).toBe('Vorozhyla - Korolova, Rokston.m4a')
  })
  it('refuses extensions outside the fixed table and names without a base', () => {
    expect(renamedWithExtension('a.mp3', '../x')).toBeNull()
    expect(renamedWithExtension('a.mp3', 'exe')).toBeNull()
    expect(renamedWithExtension('.mp3', 'm4a')).toBeNull()
    expect(renamedWithExtension('noext', 'm4a')).toBeNull()
  })
})
