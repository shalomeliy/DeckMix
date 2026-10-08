import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 08/10: the owner opened the app with the controller plugged in; "Start audio engine" stayed greyed out and MIDI stayed idle, with no message.
 * `start()` set `busy` and only cleared it on the happy path, so a throw — or a browser call that never answered — left the button disabled for good.
 */
describe('Start audio engine cannot stay disabled without a word', () => {
  const bar = readFileSync('src/app/components/TopBar.tsx', 'utf8')
  const start = bar.slice(bar.indexOf('async function start()'), bar.indexOf('async function startUnsafe()'))

  it('start() clears busy in a finally and names the failure', () => {
    expect(start).toMatch(/try\s*\{[\s\S]*startUnsafe\(\)[\s\S]*catch[\s\S]*setNotice[\s\S]*finally\s*\{\s*setBusy\(false\)/)
  })

  it('every browser call it waits on has a timeout', () => {
    const body = bar.slice(bar.indexOf('async function startUnsafe()'), bar.indexOf('async function pickOutput'))
    expect(body).toMatch(/withTimeout\(initAudio\(\)/)
    expect(body).toMatch(/withTimeout\(engine\.listOutputs\(\)/)
    expect(body).toMatch(/withTimeout\(midi\.init\(\)/)
  })

  it('a MIDI timeout reports MIDI only and brings the retry button back (status idle)', () => {
    expect(bar).toMatch(/setMidi\(\{ status: 'idle' \}\)[\s\S]*MIDI did not start/)
  })
})
