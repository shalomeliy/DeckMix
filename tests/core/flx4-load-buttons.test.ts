import { describe, expect, it } from 'vitest'
import { bindingKey } from '@/core/mapping/mapping'
import { FLX4_MAPPING } from '@/platform/transport-webmidi/mappings/flx4'

/** 08/10: the owner pressed LOAD on deck 1 and the app logged `note ch7 #70 = 127` (channel 6, note 0x46) — a binding the preset did not have. */
describe('FLX4 LOAD buttons', () => {
  it('deck 1 LOAD (measured: channel 6, note 0x46) loads deck A', () => {
    expect(FLX4_MAPPING.bindings[bindingKey('note', 6, 0x46)]).toMatchObject({ action: 'load', deck: 'A' })
  })
  it('deck 2 LOAD (Pioneer layout, not yet measured: note 0x47) loads deck B', () => {
    expect(FLX4_MAPPING.bindings[bindingKey('note', 6, 0x47)]).toMatchObject({ action: 'load', deck: 'B' })
  })
})
