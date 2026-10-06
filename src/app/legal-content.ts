import { OSS_NOTICES } from '@/app/oss-notices.generated'

/**
 * Prose for Settings → Privacy & Terms (v0.8.7). Kept out of `Settings.tsx`
 * on purpose: that file is generated-from-`FIELDS` UI plumbing, and this is
 * unrelated prose that would otherwise dilute it (write-feature-spec,
 * 12/09).
 *
 * The user's original request listed cookie policy, refunds, form consent,
 * analytics, third parties and reviews — none of which exist in DeckMix
 * (no cookies, no payment, no forms that send data anywhere, no analytics,
 * no reviews — the one exception is the manual web search of v0.9.44, named in `EXEMPT` of the test; re-verify with `grep -rE "fetch\\(|analytics|cookie" src/`
 * before trusting this comment — `tests/repo/privacy-claims.test.ts` runs
 * that same grep on every `npm run check`). A page that claimed to guard
 * against them would be a false statement, not a protection. So this states
 * plainly what does not apply, the same way `COMPANION_EXT` in
 * `platform/source-fsaccess/library.ts` names what it hides instead of
 * omitting it.
 */

export const PRIVACY_KEPT_LOCALLY = [
  {
    what: 'Your library folder permission',
    why: 'So DeckMix can re-open the same folder next time without asking again. Revoke it any time from Chrome’s site settings.',
  },
  {
    what: 'A metadata cache for your tracks',
    why: 'Title, artist, BPM, key, genre, notes, and analysis results — read once from your files and reused so re-scanning a large library is fast.',
  },
  {
    what: 'Your settings',
    why: 'Everything on the other tabs in this screen: controller feel, display, output device, hint mode, and so on.',
  },
] as const

export const PRIVACY_NOT_APPLICABLE = [
  'Cookies — DeckMix sets none. There is no session to track across visits.',
  'Analytics or usage tracking — nothing about how you use the app is measured or sent anywhere.',
  'Third parties — nothing is sent to any other company on its own. The one exception is the "search the web" button on a track with no artist: when you press it, that file’s name (without its extension or brackets, nothing else) is sent to Apple’s public music search to ask who sings it.',
  'Refunds — DeckMix is not sold. There is nothing to buy and nothing to refund.',
  'Form consent — there are no forms that submit anything.',
  'Reviews — DeckMix does not collect or publish reviews of you or your library.',
] as const

export const PRIVACY_NEVER = [
  'Nothing you play, record, or store here ever leaves this computer. Your files, their contents and their paths are never sent anywhere.',
  'There is no DeckMix server. The only thing that ever goes out is a file’s name (without its extension or brackets), to Apple’s public music search, and only when you press "search the web" on that row.',
] as const

export const TERMS_TEXT = [
  'DeckMix is provided as-is, with no warranty of any kind, for your own personal use.',
  'The person running it is solely responsible for anything that happens during a live performance, including a mix that goes wrong, a lost or corrupted file, or hardware that misbehaves. DeckMix’s authors are not liable for any of it.',
] as const

export const TRADEMARK_NOTICE =
  'DeckMix is an independent project, built from scratch on the open web platform. It is not affiliated with, endorsed by, or sponsored by Pioneer DJ or its parent company AlphaTheta. Any product names mentioned (such as the DDJ-FLX4 controller this app talks to over Web MIDI) are the trademarks of their respective owners, named only to describe compatibility.'

export const COPYRIGHT_NOTICE =
  'You are solely responsible for the rights to any music you play or record with DeckMix. DeckMix does not check, and cannot check, whether you have the right to use a given track.'

export const ossNotices = OSS_NOTICES
export const ossNoticeCount = OSS_NOTICES.length
