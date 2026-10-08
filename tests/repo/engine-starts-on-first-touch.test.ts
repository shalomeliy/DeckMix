import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * v0.9.63b (owner, 08/10: "can you start the audio engine yourself the moment I plug the controller in?").
 * Chrome will not start audio before the page was touched, and a MIDI message does not count as a touch — so the sound cannot start by
 * itself. What can: MIDI connects on open, and the first click or key press anywhere starts the engine.
 */
describe('the engine starts on the first touch, the controller connects on open', () => {
  const bar = readFileSync('src/app/components/TopBar.tsx', 'utf8')

  it('MIDI is requested when the bar mounts, with a timeout and a named failure', () => {
    expect(bar).toMatch(/useEffect\(\(\) => \{[\s\S]*?midi\.init\(\)[\s\S]*?\}, \[\]\)/)
    expect(bar).toMatch(/MIDI did not start/)
  })

  it('a first pointerdown or keydown anywhere calls start(), and both listeners are removed again', () => {
    expect(bar).toMatch(/addEventListener\('pointerdown', onFirstTouch, true\)/)
    expect(bar).toMatch(/addEventListener\('keydown', onFirstTouch, true\)/)
    expect(bar).toMatch(/removeEventListener\('pointerdown', onFirstTouch, true\)/)
    expect(bar).toMatch(/removeEventListener\('keydown', onFirstTouch, true\)/)
  })

  it('start() cannot run twice at once (the button click arrives after the same press was caught)', () => {
    expect(bar).toMatch(/if \(starting\.current\) return/)
    expect(bar).toMatch(/starting\.current = false/)
  })

  it('modifier keys, Escape and key repeats do not start it; the MIDI retry button shows even before the engine runs', () => {
    expect(bar).toMatch(/e\.repeat \|\| \['Shift', 'Control', 'Alt', 'Meta', 'Escape'\]/)
    expect(bar).toMatch(/midiState\.status === 'idle' && \(/)
  })

  it('the bar tells the owner a click anywhere is enough', () => {
    expect(bar).toMatch(/or click anywhere/)
  })
})
