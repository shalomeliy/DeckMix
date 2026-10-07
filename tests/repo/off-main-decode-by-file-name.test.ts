import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.58: the off-main decoder picks its format by the file's extension. v0.9.57 passed `track.name` — the title without the extension —
 * so no song was ever "an mp3", every one went down the old main-thread path, and the waveform kept jumping (found 07/10 by logging the
 * path each song took in the running app). The extension lives on the `File`, not on the track.
 */
describe('the off-main decoder is asked about the file name, not the track title', () => {
  const src = readFileSync('src/platform/source-fsaccess/library.ts', 'utf8')

  it('no offMainFormat/decodeInWorker call is given track.name', () => {
    expect(src).not.toMatch(/offMainFormat\(\s*track\.name/)
    expect(src).not.toMatch(/decodeInWorker\([^)]*track\.name/)
  })

  it('pcmForAnalysis asks about file.name', () => {
    expect(src).toMatch(/offMainFormat\(\s*file\.name\s*\)/)
  })
})
