import { describe, expect, it } from 'vitest'
import { PREMIUM_ENFORCED, PREMIUM_FEATURES, isPremiumUnlocked } from '@/core/premium'
import { FIELDS } from '@/core/settings'

/**
 * "Premium" is a label for now (owner, 08/10): nothing is locked and nothing charges. The repo is MIT and the app a static page, so a flag
 * in code could never protect anything anyway (docs/research/predecode-next-plan.md §5). This keeps the label from turning into a
 * half-working lock: flipping the flag, or labelling a feature on one side only, fails the gate.
 */
describe('premium is a label only', () => {
  it('does not enforce, and unlocks every feature', () => {
    expect(PREMIUM_ENFORCED).toBe(false)
    for (const f of PREMIUM_FEATURES) expect(isPremiumUnlocked(f)).toBe(true)
  })
  it('every premium feature has a Settings field that shows the label, and every labelled field is a premium feature', () => {
    const labelled = FIELDS.filter((f) => f.premium).map((f) => f.key as string)
    expect([...labelled].sort()).toEqual([...PREMIUM_FEATURES].sort())
  })
})
