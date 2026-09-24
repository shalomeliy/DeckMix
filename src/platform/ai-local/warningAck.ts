/**
 * One flag: has this browser profile already seen and dismissed the
 * "this can be slow, and sometimes won't answer at all" warning that
 * `AiControlBar.tsx` shows the first time someone turns the AI feature on
 * (v0.5.5, added 09/09 after it hung on Shalom's real machine once and
 * took ~60s-2min on the runs that did work). Shown once per browser, not
 * once ever — `idb-keyval`, same one-record shape as `mix-ratings-idb`.
 *
 * Not a Settings-screen control (CLAUDE.md v0.2.5's calibration-constant
 * rule doesn't apply — this isn't a tunable, it's a one-time
 * acknowledgement) and not a capability the app can detect and gate on
 * (there is no reliable "is this computer fast enough" test — see
 * `HANDOFF.md`), so a plain, honest heads-up is the whole feature.
 */
import { get, set } from 'idb-keyval'

const KEY = 'deckmix:ai-local:warningAcknowledged'

/** Never throws — a missing/blocked IndexedDB should just mean "show the warning again", not stop the feature from being usable at all. */
export async function hasAcknowledgedAiWarning(): Promise<boolean> {
  try {
    return (await get<boolean>(KEY)) ?? false
  } catch {
    return false
  }
}

export async function acknowledgeAiWarning(): Promise<void> {
  try {
    await set(KEY, true)
  } catch {
    // Best-effort — worst case the warning shows again next time, not a lost feature.
  }
}
