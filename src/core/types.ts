export type DeckId = 'A' | 'B'

export interface Track {
  id: string
  name: string
  /** relative path inside the chosen library folder */
  path: string
  kind: string
  /** lazily-resolved file handle from the File System Access API */
  handle: FileSystemFileHandle
  bpm?: number
  durationSec?: number
  /** from the file's tags (v0.1.7) — analysis overrides these when it runs */
  artist?: string
  title?: string
  album?: string
  /** display spelling of the musical key, e.g. `Am` */
  key?: string
  /** Camelot code for the key, e.g. `8A` — what harmonic matching compares */
  camelot?: string
  /**
   * `'detected'` when `key`/`camelot` came from the audio, not a tag
   * (v0.8.27) — the Key column marks it, and a tag read later replaces it.
   * Undefined means a tag, or no key at all.
   */
  keySource?: 'detected'
  /** Set with `keySource: 'detected'` when the audio barely picked this key over the next one (`UNCERTAIN_MARGIN`). */
  keyUncertain?: boolean
  /**
   * From the immediate parent folder at scan time (v0.3.2), overridden by a
   * manual pick from `core/genres.ts`'s `GENRES` list when the owner sets one.
   * Undefined means neither source produced a value — never a silent blank
   * mistaken for "no genre folder exists".
   */
  genre?: string
  /**
   * SHA-256 of the file's full content (v0.4.0) — the identity genre
   * overrides, hot cues and the analysis cache actually key on, not `id`
   * (which stays scan-relative-path-based, unchanged, for React/selection
   * stability). Filled in lazily: for free as a side effect of loading this
   * track to a deck or of the background analysis queue reaching it, or
   * on-demand for a single track (e.g. a genre edit from the library table
   * before either of those has happened). Undefined means "not yet
   * identified" — never treated as "this track has no identity".
   */
  contentHash?: string
  /** Where this track's background analysis is, driving the library row icon — never inferred from `bpm` (that already fills from tags before analysis runs). */
  analysisState?: 'queued' | 'analyzing' | 'analyzed' | 'failed'
  /** Set only when `analysisState` is `'failed'` — a short, named reason, shown in the row icon's tooltip. */
  analysisError?: string
  /**
   * The track's own similarity vector (v0.8.5 M3) — held directly on the
   * track, not re-read from `embeddingCache` per render: 25 floats
   * (`CLASSICAL_EMBEDDING_LENGTH`) is small enough that copying it here
   * costs nothing, the same call `bpm`/`durationSec` already make from the
   * analysis pass. Undefined means "no embedding yet", never "embedding is
   * a zero vector" — the "find similar" button stays disabled until this
   * is set.
   */
  embedding?: Float32Array
  /** Independent from `analysisState` — a track can finish BPM/waveform analysis (`'analyzed'`) well before its embedding backfill (M3) reaches it. */
  embeddingState?: 'queued' | 'embedding' | 'embedded' | 'failed'
  /** Set only when `embeddingState` is `'failed'`. */
  embeddingError?: string
  /**
   * Free-text note the owner typed on this row (v0.8.0) — same shape as
   * `genre`: not written by the scan itself, filled in at merge time from
   * `platform/track-meta-idb/store.ts`, keyed by `contentHash` (not `id`)
   * so it survives a rescan of an unmoved file.
   */
  note?: string
  /**
   * `Date.now()` the moment this track was last loaded to a deck (v0.8.0),
   * stamped from `controls.ts`'s `loadTrackToDeck` once `contentHash` is
   * known. Same merge shape as `note` — undefined means "never loaded since
   * this became trackable", not "loaded at time zero".
   */
  lastPlayedAt?: number
}

/**
 * One track loaded to a deck during the current page session (v0.8.3) — a
 * snapshot at load time, not a live reference by `contentHash`/`id`, so a
 * track later removed from the library (rescan, file moved) doesn't blank
 * out its own history row.
 */
export interface HistoryEntry {
  deckId: DeckId
  contentHash: string
  /** `track.title ?? track.name` at load time — same fallback `Library.tsx` already uses for display. */
  name: string
  artist: string | null
  loadedAtMs: number
}

export interface HotCue {
  index: number
  positionSec: number
  label: string
  color: string
  /**
   * `Date.now()` at creation — lets v0.4.7's auto-save (`saveMixEntryHotCue`,
   * `controls.ts`) pick which pad to evict when all 8 are full ("oldest
   * created", not lowest index). Cues restored from before this field
   * existed read as `undefined`; every read site treats that as "oldest of
   * all" (`?? 0`), never as "can't compare" — a missing timestamp here isn't
   * a degraded feature the way a missing analysis is, just an ordering hint.
   */
  createdAt?: number
  /**
   * v0.5.3: set only by `saveMixEntryHotCue` — the precise signal that this
   * pad re-triggers a full automatic transition on press
   * (`shouldTriggerMixEntry`, `core/hotcues.ts`), now that a label alone
   * can't tell the difference: manual rename (`renameHotCue`, `PadGrid.tsx`)
   * also produces a non-ordinal label, on purpose, without making the pad a
   * mix-entry trigger. Absent on cues saved before this field existed —
   * `loadTrackToDeck` (`controls.ts`) backfills it once at load time using
   * the old label-based heuristic, which was exact back when a non-ordinal
   * label had only one possible cause.
   */
  kind?: 'mixEntry'
}

export interface BeatGrid {
  /**
   * Seconds from track start to the grid's own beat 0 — the first yellow (bar)
   * line. Folded into one bar, [0, 4·60/bpm), since v0.8.23; a detected grid
   * lands inside the first beat because detection only finds beats, not bars.
   */
  offsetSec: number
  bpm: number
}

/**
 * What the pad grid does right now (v0.5.0). Per-deck — each deck's pad
 * grid is a physically independent surface on the FLX4, so the two decks
 * can legitimately sit in different modes at once. `sampler` (real engine,
 * v0.6.0 — `core/sampler.ts`) reaches one *global* 16-slot bank shared by
 * both decks, not a per-deck bank: 8 pads show slots 0-7, the existing
 * SHIFT layer shows 8-15.
 */
export type PadMode = 'hotcue' | 'loop' | 'beatJump' | 'sampler'

export interface DeckState {
  id: DeckId
  track: Track | null
  loading: boolean
  playing: boolean
  /** playhead position in seconds */
  positionSec: number
  durationSec: number
  /** detected / edited bpm of the loaded track */
  bpm: number | null
  /**
   * Detected/edited beat grid (v0.3.0) — phase (`offsetSec`) plus the same
   * number as `bpm`, always written together. `null` until a track is loaded
   * or detection found nothing to say (too short/quiet to show a periodicity).
   */
  beatGrid: BeatGrid | null
  /**
   * Whether `beatGrid` has been checked or edited by the user. False means
   * detection found it but wasn't confident, or found nothing at all — shown
   * in the UI, never silently trusted. `true` with no track loaded (nothing
   * to warn about).
   */
  beatGridConfirmed: boolean
  /** locked to the master deck's phase via SYNC (v0.3.0) */
  syncActive: boolean
  /** tempo fader value, -1..1 mapped to +/- range (see TEMPO_RANGE) */
  tempo: number
  /** normalised waveform peaks for rendering (min/max interleaved) */
  peaks: Float32Array | null
  /** per-bucket low/mid/high energy, 3 per bucket — colours the waveform */
  bands: Float32Array | null
  hotCues: HotCue[]
  /** temp cue point set with the CUE button */
  cuePointSec: number
  /** vinyl mode: stop and start spin down and up instead of cutting */
  vinylMode: boolean
  /** a hand is on the platter right now */
  scratching: boolean
  loopActive: boolean
  loopBeats: number
  cueMonitor: boolean
  /** which pad-grid mode this deck's pads are in (v0.5.0). Not persisted — resets to 'hotcue' on app reload, but survives a track load on the same deck. */
  padMode: PadMode
  /**
   * v0.5.4: seconds (rounded) this track's own exit points were previously
   * rated "excellent" (`platform/mix-ratings-idb/store.ts`), loaded once at
   * track-load time. Lets the exit-point indicator (`Deck.tsx`) mark a
   * repeat candidate instead of treating every load as the first.
   */
  excellentMixPoints: number[]
}

export interface ChannelState {
  /** 0..1 line fader */
  volume: number
  /** -1..1 -> -26dB..+26dB per band */
  eqLow: number
  eqMid: number
  eqHigh: number
  /** -1..1 color/filter knob, 0 = bypass */
  filter: number
}

export interface MixerState {
  /** -1 (full A) .. +1 (full B) */
  crossfader: number
  masterVolume: number
  /** headphone cue: 0 = cue only, 1 = master only */
  cueMix: number
  cueVolume: number
  channels: Record<DeckId, ChannelState>
}

export type MidiStatus = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied'

export interface MidiDeviceInfo {
  id: string
  name: string
  manufacturer: string
}
