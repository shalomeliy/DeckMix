/**
 * Which features carry the "Premium" label (v0.9.66, owner's idea 08/10). A label and nothing more: `PREMIUM_ENFORCED` is `false`,
 * so every feature is unlocked for everyone and nothing here talks to a server.
 *
 * Why it must stay honest: the repo is MIT and the app a static page, so a flag in code is one line away from `true` for anyone
 * who has the source. Real charging needs a licence key checked in the Tauri build or a server (`docs/research/predecode-next-plan.md`
 * §5), and that is a decision the owner has not made. `tests/repo/premium-label-only.test.ts` fails if the flag flips, or if a
 * feature is labelled here without a Settings field showing the label (or the other way round).
 */
export const PREMIUM_FEATURES = ['predecodeNext'] as const
export type PremiumFeature = (typeof PREMIUM_FEATURES)[number]

export const PREMIUM_ENFORCED = false

export function isPremiumUnlocked(_feature: PremiumFeature): boolean {
  return !PREMIUM_ENFORCED
}
