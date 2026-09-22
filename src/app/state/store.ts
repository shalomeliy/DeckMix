import type { LibraryBoot } from '@/core/library-boot'
import { create } from 'zustand'
import type {
  ChannelState,
  DeckId,
  DeckState,
  HistoryEntry,
  MidiDeviceInfo,
  MidiStatus,
  MixerState,
  Track,
} from '@/core/types'
import type { AIToolCall } from '@/core/ports/ai'
import type { Capabilities } from '@/core/ports'
import { detectCapabilities } from '@/platform/capabilities'
import { emptySamplerSlot, SAMPLER_SLOT_COUNT, type SamplerSlot } from '@/core/sampler'
import { FX_TIME_STEPS } from '@/core/fx'
import type { SortDir, SortKey } from '@/core/library-sort'
import type { CrateRecord } from '@/platform/crates-idb/store'

/** Who put a message on screen, so only they can take it down. */
export type NoticeSource =
  | 'load'
  | 'output'
  | 'library'
  | 'quantize'
  | 'sync'
  | 'cues'
  | 'padMode'
  | 'ai'
  | 'sampler'
  | 'fx'
  | 'recording'
  | 'history'
  | 'mixRating'

/**
 * v0.5.5's natural-language control bar — see `controls.ts`'s AI section
 * for the state machine this drives. `model-loading`/`model-error` (phase
 * 2, `platform/ai-local/`) cover the one-time download a local model
 * needs before it can chat at all — distinct from `thinking` (the model is
 * loaded and generating a reply), so the bar can say which one is actually
 * happening instead of one generic "AI is busy" for both. `first-run-warning`
 * sits before all of them, once per browser (`warningAck.ts`) — there is no
 * reliable way to check "is this computer fast enough" ahead of time (see
 * `HANDOFF.md`, 09/09), so the honest version is telling the user plainly
 * that it can be slow or not answer at all, before the first download.
 */
export type AiPhase =
  | 'idle'
  | 'typing'
  | 'thinking'
  | 'confirm'
  | 'clarify'
  | 'decline'
  | 'model-loading'
  | 'model-error'
  | 'first-run-warning'

export interface AiState {
  /** Off by default — dark launch, no effect on anything else while off. */
  enabled: boolean
  phase: AiPhase
  input: string
  /** A validated real action awaiting explicit Go/Cancel — never runs on its own. */
  proposal: { summary: string; deckId?: DeckId; call: AIToolCall } | null
  clarifyQuestion: string | null
  declineReason: string | null
  /** Set while `phase === 'model-loading'` — 0..100, from the provider's own download/init progress. */
  loadProgressPct: number | null
  /** Set while `phase === 'model-error'` — why the model failed to load, shown as-is (not a generic "something went wrong"). */
  loadError: string | null
}

function emptyDeck(id: DeckId): DeckState {
  return {
    id,
    track: null,
    loading: false,
    playing: false,
    positionSec: 0,
    durationSec: 0,
    bpm: null,
    beatGrid: null,
    beatGridConfirmed: true,
    syncActive: false,
    tempo: 0,
    peaks: null,
    bands: null,
    hotCues: [],
    cuePointSec: 0,
    vinylMode: true,
    scratching: false,
    loopActive: false,
    loopBeats: 4,
    cueMonitor: false,
    padMode: 'hotcue',
    excellentMixPoints: [],
  }
}

function emptyChannel(): ChannelState {
  return { volume: 0.9, eqLow: 0, eqMid: 0, eqHigh: 0, filter: 0 }
}

/** One FX rack's state (v0.7.0). `effect` indexes `core/fx.ts`'s `FX_EFFECTS`, `time` is one of `FX_TIME_STEPS`. */
export interface FxState {
  effect: number
  wetDry: number
  time: number
  on: boolean
  route: 'channel' | 'master'
}

function emptyFx(): FxState {
  return { effect: 0, wetDry: 0.5, time: FX_TIME_STEPS[0], on: false, route: 'channel' }
}

export interface AppState {
  decks: Record<DeckId, DeckState>
  mixer: MixerState

  /**
   * The sampler bank (v0.6.0) — one global 16-slot bank, not per-deck; both
   * decks' pad grids reach the same slots in Sampler mode. `channel` is its
   * own mixer strip, wired straight to master (no crossfader — that's an
   * A/B control) and optionally the cue mix, the same split a deck's own
   * `faderGain`/`cueGain` already give it.
   */
  sampler: {
    slots: SamplerSlot[]
    channel: { volume: number; cueMonitor: boolean }
    /** which slot is currently recording from the master bus (v0.7.5), or `null` — `PadGrid.tsx`'s cue for the "Record"/"Recording…" state on a slot's own editor row. */
    armedSlot: number | null
  }

  /** Two global FX racks (v0.7.0) — index 0 pairs with deck A, 1 with deck B when channel-routed. See `platform/audio-webaudio/engine.ts`'s `setFxRouting`. */
  fx: [FxState, FxState]

  /**
   * Master recording status only (v0.7.5) — the PCM itself lives in
   * `controls.ts`'s own module state, never here (this store holds
   * serializable state only). `savedState: 'unsaved'` has no timeout: the
   * spec is explicit that canceling the save dialog must never silently
   * drop a recording, so this stays true until the owner saves or discards.
   */
  recording: {
    active: 'master' | null
    startedAt: number | null
    bytesRecorded: number
    savedState: 'idle' | 'unsaved' | 'saved'
    trackBoundariesSec: number[]
  }

  /**
   * Every track loaded to a deck this page session, in load order (v0.8.3).
   * In-memory only — cleared on reload, same as `recording`/`activeTransition`
   * (Shalom's explicit decision, 13/09: the set history is scoped to the
   * live session, not persisted).
   *
   * Only ever selected as `s.history.length` (`TopBar.tsx`) or the whole
   * array read once when a screen opens (`SetHistory.tsx`) — never inside a
   * selector that also reads a frame-rate field. Same trap `Library.tsx`'s
   * now-playing selector already documents: reading `s.history` alongside
   * `positionSec`/`peaks` would re-render on every animation frame instead
   * of only on a new entry.
   */
  history: HistoryEntry[]

  /**
   * Which deck SYNC's phase-align locks the other deck to (v0.3.0). `null`
   * until a deck starts playing (auto-set from there) or the user overrides
   * it with a long-press on a deck's SYNC button.
   */
  masterDeckId: DeckId | null
  /**
   * Global, off-by-default. When on, CUE/hot cues/loops snap new points to
   * the active deck's beat grid (v0.3.0) — never on the branches that seek to
   * an *existing* point, only where a new one is being set.
   */
  quantize: boolean

  /**
   * Global SHIFT layer for the pad grids (v0.5.0) — a held modifier that
   * changes what a pad press does. Global, not per-deck: the FLX4 has one
   * physical SHIFT button for the whole controller, not one per side.
   */
  shiftHeld: boolean

  /**
   * Mix Assist's autonomous transition in progress (v0.4.6, step 7), or
   * `null` when none is running — this is the UI half only (which decks, so
   * Mixer.tsx can show its cancel button and the answer to "is one already
   * running"). The imperative half — the rAF-driven crossfade loop, the
   * saved pre-transition state to cancel back to — lives in `controls.ts`'s
   * own module-level state, same split as `masterDeckId` (serializable)
   * versus `ensureSyncLoop`'s subscription (imperative, not in the store).
   */
  activeTransition: {
    fromDeckId: DeckId
    toDeckId: DeckId
    /**
     * v0.5.4: the outgoing deck's own next candidate point ahead of where it
     * started the transition (`nextCandidateFrom`, `core/structure.ts`) —
     * shown on the outgoing deck (`Deck.tsx`) as a suggested exit point,
     * transparently, the moment the transition begins. `null` means the
     * heuristic genuinely found nothing ahead (a short track, or no analysis
     * yet) — shown as such, never guessed.
     */
    exitPointSec: number | null
  } | null

  /**
   * A transition just finished mixing out `fromDeckId` (v0.5.4) — the rating
   * prompt (`App.tsx`) asks whether the exit point worked, and only
   * "excellent" is written to `platform/mix-ratings-idb/store.ts`. `null`
   * once rated or dismissed; there is no queue — a second transition
   * finishing before this one is rated simply replaces it, the same "most
   * recent wins, nothing silently drops a *feature*" tradeoff `notice`
   * already makes for its own single slot.
   */
  pendingMixRating: {
    fromDeckId: DeckId
    contentHash: string | undefined
    trackName: string
    exitPointSec: number
    /** v0.8.14: the incoming deck's own track, for `markExcellentPair` — undefined when it hadn't been analyzed yet at rating time (see `mix-pairs-idb`'s doc comment). */
    toContentHash: string | undefined
    /** v0.8.14: the raw entry second `startAutoTransition` was called with (pre phase-alignment) — what a later "excellent match" replay seeks the incoming track to. */
    entrySec: number
  } | null

  library: {
    folderName: string | null
    tracks: Track[]
    scanning: boolean
    scanMsg: string
    query: string
    selectedId: string | null
    /** files the scan walked past, by extension — never skip silently */
    skipped: Record<string, number>
    /** tracks whose parent folder matched no known genre, by folder name (v0.3.2) */
    unrecognizedGenre: Record<string, number>
    supported: boolean
    /**
     * Which of the startup situations we are in (v0.2.6). An empty track list
     * is never on its own enough: this is what turns "nothing here" into a
     * sentence, and it is the reason the panel can tell a first visit from a
     * revoked permission from a folder that was renamed.
     */
    boot: LibraryBoot
    /** the browser's own words when a scan failed, so `failed` can quote them */
    bootDetail: string | null
    /** listed tracks whose file could not be read — counted, never swallowed */
    unreadable: number
    /** which column the table is sorted by (v0.8.0) — null means scan order, today's default */
    sortKey: SortKey | null
    sortDir: SortDir
    /**
     * The crate currently narrowing the table (v0.8.1) — null means "whole
     * library". Lives on `library`, not `crates`, because it is view state
     * for *this* table, not data about the crate itself; `controls.ts`'s
     * `filteredTracks()` is the single place that reads it.
     */
    activeCrateId: string | null
  }

  /**
   * Named track groupings, independent of the on-disk folder structure
   * (v0.8.1). Loaded once at boot from `platform/crates-idb/store.ts` (see
   * `App.tsx`), then kept in sync optimistically by every `controls.ts`
   * crate action — the same "update the store now, persist in the
   * background" shape `library.tracks` itself uses for genre/note edits.
   */
  crates: Map<string, CrateRecord>

  midi: {
    status: MidiStatus
    devices: MidiDeviceInfo[]
    lastMessage: string | null
    /**
     * What the app DID with the last jog message, including "nothing, because".
     * The jog has three silent exits — no track, deck not playing, already
     * scratching — and a rim that does nothing looks identical to a rim that is
     * not connected. That ambiguity cost a whole debugging round on real
     * hardware, which is exactly what "never skip silently" exists to prevent.
     */
    lastJog: string | null
    learning: string | null
  }

  output: {
    devices: { deviceId: string; label: string }[]
    currentId: string | null
    multichannel: boolean
    sinkSupported: boolean
  }

  audioReady: boolean

  /**
   * Whether the deck's scratch engine is running. False means the AudioWorklet
   * could not be loaded and the decks fell back to AudioBufferSourceNode, which
   * plays correctly but cannot reverse or hold the read pointer. `scratchError`
   * carries the reason, and the UI states both — a deck that answers a scratch
   * with a seek and says nothing is the failure this project forbids.
   */
  scratchReady: boolean
  scratchError: string | null

  /**
   * Whether the Bit Crusher/Roll worklet (v0.8.13, planned as v0.7.1) is
   * available. Store-mirrored, unlike Reverb's `reverbAvailable` (read
   * directly off the engine): this resolves asynchronously, possibly after
   * React's first render, so the FX cycle-button must be reactive to it —
   * see `Mixer.tsx`'s `isFxEffectAvailable`.
   */
  fxWorkletReady: boolean
  fxWorkletError: string | null

  /** what this machine supports, resolved once at boot (v0.1.6) */
  capabilities: Capabilities

  /**
   * One line telling the user something the app just refused or changed on its
   * own, and why.
   *
   * Added in v0.2.5 for the first setting that makes the app say no: "Lock a
   * playing deck" turns a load into a refusal, and a load that silently does
   * nothing is indistinguishable from a broken button. Anything that declines,
   * degrades or substitutes belongs here rather than in a `console.warn`.
   */
  notice: { text: string; tone: 'warn' | 'info'; source: NoticeSource } | null

  /** v0.5.5 natural-language control — see `AiState`. */
  ai: AiState

  patchDeck: (id: DeckId, patch: Partial<DeckState>) => void
  patchChannel: (id: DeckId, patch: Partial<ChannelState>) => void
  patchMixer: (patch: Partial<Omit<MixerState, 'channels'>>) => void
  patchAi: (patch: Partial<AiState>) => void
  patchSamplerSlot: (index: number, patch: Partial<SamplerSlot>) => void
  patchSamplerChannel: (patch: Partial<AppState['sampler']['channel']>) => void
  patchSampler: (patch: Partial<Pick<AppState['sampler'], 'armedSlot'>>) => void
  patchRecording: (patch: Partial<AppState['recording']>) => void
  appendHistoryEntry: (entry: HistoryEntry) => void
  patchFx: (rack: 0 | 1, patch: Partial<FxState>) => void
  set: <K extends keyof AppState>(key: K, value: AppState[K]) => void
  setLibrary: (patch: Partial<AppState['library']>) => void
  setMidi: (patch: Partial<AppState['midi']>) => void
  setOutput: (patch: Partial<AppState['output']>) => void
  setNotice: (notice: AppState['notice']) => void
  /**
   * Clear the notice only if it came from `source`.
   *
   * A plain `setNotice(null)` throws away whoever else's message is up there,
   * and the one that was being lost is the one that matters most: "the audio
   * device you last used is not connected" is set at startup and was wiped by
   * the first track load, before it could be read.
   */
  clearNotice: (source: NoticeSource) => void
}

export const useStore = create<AppState>((set) => ({
  decks: { A: emptyDeck('A'), B: emptyDeck('B') },
  masterDeckId: null,
  quantize: false,
  shiftHeld: false,
  activeTransition: null,
  pendingMixRating: null,
  mixer: {
    crossfader: 0,
    masterVolume: 0.85,
    cueMix: 0.5,
    cueVolume: 0.7,
    channels: { A: emptyChannel(), B: emptyChannel() },
  },
  sampler: {
    slots: Array.from({ length: SAMPLER_SLOT_COUNT }, emptySamplerSlot),
    channel: { volume: 0.85, cueMonitor: false },
    armedSlot: null,
  },
  fx: [emptyFx(), emptyFx()],
  recording: { active: null, startedAt: null, bytesRecorded: 0, savedState: 'idle', trackBoundariesSec: [] },
  history: [],
  library: {
    folderName: null,
    tracks: [],
    scanning: false,
    scanMsg: '',
    query: '',
    selectedId: null,
    skipped: {},
    unrecognizedGenre: {},
    supported: true,
    boot: 'checking',
    bootDetail: null,
    unreadable: 0,
    sortKey: null,
    sortDir: 'asc',
    activeCrateId: null,
  },
  crates: new Map(),
  midi: { status: 'idle', devices: [], lastMessage: null, lastJog: null, learning: null },
  output: { devices: [], currentId: null, multichannel: false, sinkSupported: false },
  audioReady: false,
  scratchReady: false,
  scratchError: null,
  fxWorkletReady: false,
  fxWorkletError: null,
  capabilities: detectCapabilities(),
  notice: null,
  ai: {
    enabled: false,
    phase: 'idle',
    input: '',
    proposal: null,
    clarifyQuestion: null,
    declineReason: null,
    loadProgressPct: null,
    loadError: null,
  },

  patchDeck: (id, patch) =>
    set((s) => ({ decks: { ...s.decks, [id]: { ...s.decks[id], ...patch } } })),
  patchChannel: (id, patch) =>
    set((s) => ({
      mixer: {
        ...s.mixer,
        channels: { ...s.mixer.channels, [id]: { ...s.mixer.channels[id], ...patch } },
      },
    })),
  patchMixer: (patch) => set((s) => ({ mixer: { ...s.mixer, ...patch } })),
  patchAi: (patch) => set((s) => ({ ai: { ...s.ai, ...patch } })),
  patchSamplerSlot: (index, patch) =>
    set((s) => ({
      sampler: {
        ...s.sampler,
        slots: s.sampler.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)),
      },
    })),
  patchSamplerChannel: (patch) =>
    set((s) => ({ sampler: { ...s.sampler, channel: { ...s.sampler.channel, ...patch } } })),
  patchSampler: (patch) => set((s) => ({ sampler: { ...s.sampler, ...patch } })),
  patchRecording: (patch) => set((s) => ({ recording: { ...s.recording, ...patch } })),
  appendHistoryEntry: (entry) => set((s) => ({ history: [...s.history, entry] })),
  patchFx: (rack, patch) =>
    set((s) => ({
      fx: rack === 0 ? [{ ...s.fx[0], ...patch }, s.fx[1]] : [s.fx[0], { ...s.fx[1], ...patch }],
    })),
  set: (key, value) => set({ [key]: value } as Partial<AppState>),
  setLibrary: (patch) => set((s) => ({ library: { ...s.library, ...patch } })),
  setMidi: (patch) => set((s) => ({ midi: { ...s.midi, ...patch } })),
  setOutput: (patch) => set((s) => ({ output: { ...s.output, ...patch } })),
  setNotice: (notice) => set({ notice }),
  clearNotice: (source) => set((s) => (s.notice?.source === source ? { notice: null } : {})),
}))
