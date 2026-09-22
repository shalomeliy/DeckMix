/**
 * Pure sampler math and slot shape (v0.6.0). No React, no DOM, no
 * AudioContext, no store — same split `padmodes.ts`/`beatgrid.ts` already
 * make. `platform/audio-webaudio/sampler.ts` owns the actual voices;
 * `controls.ts` owns everything that needs the engine or the store.
 */

export type SamplerMode = 'oneShot' | 'loop' | 'gated'

const SAMPLER_MODES: readonly SamplerMode[] = ['oneShot', 'loop', 'gated']

export function isSamplerMode(v: unknown): v is SamplerMode {
  return typeof v === 'string' && (SAMPLER_MODES as readonly string[]).includes(v)
}

/**
 * One global bank, not per-deck (ROADMAP.md v0.6.0: "בנק סאמפלים"). Reached
 * from either deck's pad grid in Sampler mode — 8 pads show slots 0-7,
 * holding the existing global SHIFT layer (v0.5.0) shows 8-15, so no new
 * hardware binding is needed to reach all 16 from an 8-pad controller.
 */
export const SAMPLER_SLOT_COUNT = 16

export interface SamplerSlot {
  /** this session's live `Track.id` — null when nothing is loaded, or a saved bank slot hasn't been re-resolved against the current library yet */
  trackId: string | null
  /** last-known display name — kept even while `trackId` is null so a not-yet-resolved saved slot still shows what belongs there, never a blank pad */
  trackName: string | null
  /** content hash (the same v0.4.0 identity `genre-overrides-idb`/`cues-idb` key on) — what a saved bank restores a slot by, never a scan-relative path */
  contentHash: string | undefined
  /** set instead of `contentHash` when this slot's audio came from a live recording (v0.7.5), not a library file — mutually exclusive with `contentHash` for an occupied slot. Keys the raw bytes in `platform/sampler-recordings-idb/store.ts`. */
  recordingId: string | undefined
  /** the loaded sample's own tempo, snapshotted at load time from the track's tag/analysis — undefined means unknown, never guessed */
  bpm: number | undefined
  mode: SamplerMode
  /** 0..1, this slot's own fader — independent of the sampler channel's overall mixer volume */
  gain: number
  /** when on and both this slot's and the master deck's BPM are known, playback rate is scaled to match the master's current tempo (`samplerSyncRate`) */
  syncEnabled: boolean
  /** a voice is currently sounding — transient UI state, never persisted (see `platform/sampler-idb/store.ts`) */
  playing: boolean
}

/**
 * A slot holds audio either from a library track (`trackId`) or a live
 * recording (`recordingId`, v0.7.5) — never neither while occupied. Every
 * "is this pad occupied" check in the UI and `controls.ts` goes through
 * this, not a bare `slot.trackId != null`, so a recorded slot (which has no
 * `trackId` — there is no library `Track` behind it) reads as occupied too.
 */
export function isSamplerSlotOccupied(slot: SamplerSlot): boolean {
  return slot.trackId != null || slot.recordingId != null
}

export function emptySamplerSlot(): SamplerSlot {
  return {
    trackId: null,
    trackName: null,
    contentHash: undefined,
    recordingId: undefined,
    bpm: undefined,
    mode: 'oneShot',
    gain: 0.85,
    syncEnabled: false,
    playing: false,
  }
}

/**
 * Playback rate for a triggered or already-playing slot. `1` (no change)
 * whenever sync is off, or either BPM is unknown — a slot that cannot
 * compute a real ratio must play at its own natural speed, never guess one
 * (this project's central rule: a missing capability degrades visibly, and
 * the UI reads `syncEnabled && !bpm` off this same pair of facts to show
 * that the toggle is on but has nothing to lock to). Never zero or negative
 * — a corrupt or absurd tag reads the same as "unknown" rather than
 * silencing or reversing the sample.
 */
export function samplerSyncRate(
  masterBpm: number | null,
  slotBpm: number | undefined,
  syncEnabled: boolean,
): number {
  if (!syncEnabled || !masterBpm || !slotBpm) return 1
  const rate = masterBpm / slotBpm
  return isFinite(rate) && rate > 0 ? rate : 1
}

/**
 * The file names a "collect and copy" bank export (v0.8.9,
 * `platform/sampler-bank-fsaccess/store.ts`) writes: one JSON manifest plus
 * one WAV per recorded slot, all sharing an owner-chosen base name. Pure and
 * DOM-free on purpose, same reasoning as `core/recording.ts`'s
 * `segmentFileNames` — the platform layer's export (writing them) and import
 * (looking for them) both derive from this one function, so the two can
 * never name things differently, and it stays testable without a real
 * file system.
 */
export function manifestFileNames(base: string, recordingIds: string[]): { jsonName: string; wavNames: string[] } {
  return {
    jsonName: `${base}.json`,
    wavNames: recordingIds.map((id) => `${base}-rec-${id}.wav`),
  }
}
