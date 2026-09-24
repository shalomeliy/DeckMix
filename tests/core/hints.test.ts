import { describe, expect, it } from 'vitest'
import { HINT_BASE, gestureTable, hint, type HintId } from '@/core/hints.ts'
import { FLX4_LABELS, flx4Label } from '@/core/mapping/flx4-labels.ts'
import type { ControlAction } from '@/core/mapping/mapping.ts'
import { FLX4_MAPPING } from '@/platform/transport-webmidi/mappings/flx4.ts'

const ids = Object.keys(HINT_BASE) as HintId[]

describe('hint text', () => {
  it('gives every registered control a non-empty explanation', () => {
    for (const id of ids) {
      expect(hint(id).trim().length, `${id} has an empty hint`).toBeGreaterThan(0)
    }
  })

  it('appends the FLX4 line only for hints that name a ControlAction', () => {
    for (const id of ids) {
      const spec = HINT_BASE[id]
      const text = hint(id)
      if ('action' in spec && spec.action) {
        expect(text, `${id} names an action but its hint has no FLX4 line`).toContain('Also on FLX4:')
      } else {
        // The project's central rule applied here: a control with no hardware
        // equivalent must not have one invented for it just to look consistent.
        // (Prose can still mention the FLX4 by name, e.g. "reconnect to the
        // DDJ-FLX4" — only the generated "Also on FLX4:" claim is forbidden.)
        expect(text, `${id} has no action but its hint claims a hardware control`).not.toContain(
          'Also on FLX4:',
        )
      }
    }
  })
})

describe('FLX4 label drift', () => {
  // core/ cannot import platform/ (layering), so this is the one place the
  // hand-authored labels in flx4-labels.ts are checked against the real
  // mapping — the source of truth for which actions the FLX4 preset actually
  // binds. A new binding that lands without a label would otherwise ship a
  // Hint mode line silently missing its hardware half.
  const actionsInMapping = new Set<ControlAction>(
    Object.values(FLX4_MAPPING.bindings).map((b) => b.action),
  )

  it('has an FLX4_LABELS entry for every action the real mapping binds', () => {
    for (const action of actionsInMapping) {
      expect(flx4Label(action, 0), `${action} is bound on the FLX4 but has no label`).not.toBeNull()
    }
  })

  it('does not label an action that has no binding on the FLX4', () => {
    for (const action of Object.keys(FLX4_LABELS) as ControlAction[]) {
      expect(actionsInMapping.has(action), `${action} is labelled but not bound in FLX4_MAPPING`).toBe(
        true,
      )
    }
  })

  it('gives the hotcue label a pad number that reflects its param', () => {
    // v0.5.0: the physical pad's label can no longer promise "Hot Cue mode" —
    // the same 8 notes now mean different things depending on the deck's
    // pad-grid mode (`core/types.ts`'s `PadMode`).
    expect(flx4Label('hotcue', 0)).toBe('Pad 1 (mode-dependent — Hot Cue, Loop, Beat Jump or Sampler)')
    expect(flx4Label('hotcue', 7)).toBe('Pad 8 (mode-dependent — Hot Cue, Loop, Beat Jump or Sampler)')
  })

  it('gives the padMode label a button number that reflects its param', () => {
    expect(flx4Label('padMode', 0)).toBe('Pad-mode button 1 (Hot Cue / Loop / Beat Jump / Sampler)')
    expect(flx4Label('padMode', 3)).toBe('Pad-mode button 4 (Hot Cue / Loop / Beat Jump / Sampler)')
  })
})

describe('gesture table (v0.8.24)', () => {
  it('prints hidden gestures in the hint itself — Shift+click deleting a cue is on screen', () => {
    expect(hint('pads.hotcue')).toContain('Shift+click a set pad')
    expect(hint('pads.hotcue')).toContain('delete the cue')
  })

  it('fills the Keys screen FLX4 column only from flx4Label, never typed', () => {
    for (const row of gestureTable()) {
      if (row.flx4 == null) continue
      const labels = Object.keys(FLX4_LABELS).flatMap((a) =>
        Array.from({ length: 8 }, (_, p) => flx4Label(a as ControlAction, p)),
      )
      expect(labels, `${row.does}: FLX4 text not from flx4Label`).toContain(row.flx4)
    }
  })

  it('lists a shared gesture once, and every place in order', () => {
    const rows = gestureTable()
    expect(rows.filter((r) => r.mouse === 'Double-click a knob')).toHaveLength(1)
    expect([...new Set(rows.map((r) => r.place))]).toEqual(['Deck', 'Pads', 'Mixer', 'Library'])
  })
})
