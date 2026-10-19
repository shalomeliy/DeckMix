import type { LibraryBoot } from '@/core/library-boot'
import type { MisnamedFile } from '@/core/audio-format'
import type { SampleKind, SampleMarkTag } from '@/core/sound/sample-marks'
import type { VocalManualTag } from '@/core/sound/vocal-manual'
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
import { decksFollowLibraryKeys } from '@/core/tag-merge'
import type { ColumnFilters } from '@/core/library-filter'
import type { SearchColumn } from '@/core/library-search'
import type { SortDir, SortKey } from '@/core/library-sort'
import type { CrateRecord } from '@/platform/crates-idb/store'

/** Who put a message on screen, so only they can take it down. */
export type NoticeSource =
  | 'load'
  | 'output'
  | 'library'
  | 'quantize'
  | 'sync'
  | 'keylock'
  | 'cues'
  | 'grid'
  | 'padMode'
  | 'ai'
  | 'sampler'
  | 'fx'
  | 'layout'
  | 'recording'
  | 'history'
  | 'mixRating'
  | 'tagging'
  | 'tempo'

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
    audibleEndSec: 0,
    bpm: null,
    beatGrid: null,
    beatGridConfirmed: true,
    barOneUnsure: false,
    bpmOrigin: null,
    baseRate: 1,
    tempoByHand: false,
    syncActive: false,
    tempo: 0,
    peaks: null,
    bands: null,
    hotCues: [],
    cuePointSec: 0,
    vinylMode: true,
    keyLock: false,
    keySyncShift: null,
    scratching: false,
    loopActive: false,
    loopRange: null,
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

/** What the "check the 1" bar needs to draw: which deck, which song, how many are left, and whether the song is ready to be answered. */
export interface BarOneQueueState {
  deckId: DeckId
  name: string
  phase: 'loading' | 'ready'
  remaining: number
  checked: number
  skipped: number
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
     * transparently, the moment the transition begins. Fixed 23/09: used to
     * be `null` when the heuristic found nothing ahead, which silently
     * skipped the rating prompt too (`controls.ts`'s `finishTransition`) —
     * now falls back to the live position, so it's always a real number.
     */
    exitPointSec: number
    /**
     * v0.8.14: clicked, but still waiting for the outgoing deck's next yellow
     * (bar) line before the incoming deck starts — up to one bar. Shown by
     * `Mixer.tsx`, so a mix that hasn't audibly started yet doesn't look like
     * a click that did nothing.
     */
    waitingForBar: boolean
    /**
     * v0.8.16: an excellent-pair replay waiting for the outgoing deck to reach
     * the second it mixed out at last time — possibly minutes away, so the
     * cancel button names it instead of "next bar". `null` for every other
     * transition.
     */
    waitingUntilSec: number | null
    /** v0.9.15: a vocal handoff — its bass swap, on the outgoing deck's seconds (v0.9.63: halfway through the run-in; B sings at `endSec`). `null` otherwise. */
    handoffSec: number | null
    /** v0.9.17: `waitingUntilSec` is a phrase start of the outgoing deck (an energy point or a Mix-in pad), not an excellent pair's exit second. */
    onPhrase: boolean
    /** The vocal swap (`core/vocal-swap-mix.ts`) rides on the handoff fields; this only picks its name on screen. `handoffSec` is then where B's voice comes in. */
    swap?: boolean
    /**
     * v0.9.33, the countdown on the cancel button: where the mix ends. `endSec` is on the outgoing deck's own seconds (a handoff or a swap,
     * which follow its position); `endAtClock` is the audio clock's second (a plain transition, which runs on wall time and only knows
     * its end once it has started). `null` when not known yet — a plain transition still waiting for its bar line.
     */
    endSec?: number | null
    endAtClock?: number | null
    /** v0.9.33: the incoming deck has joined but is held at zero on the crossfader until its kicks sit on the outgoing deck's (`core/kick-lock.ts`). */
    aligning?: boolean
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
  /**
   * v0.8.17: bumped when `markExcellentPair` has saved. The strip's pair list
   * (`Library.tsx`) reloads when a deck's track changes; without this, a pair
   * rated while both tracks stay loaded didn't show until one was swapped.
   */
  excellentPairsRev: number

  pendingMixRating: {
    fromDeckId: DeckId
    contentHash: string | undefined
    trackName: string
    exitPointSec: number
    /** v0.8.14: the incoming deck's own track, for `markExcellentPair` — undefined when it hadn't been analyzed yet at rating time (see `mix-pairs-idb`'s doc comment). */
    toContentHash: string | undefined
    /** v0.8.17: the incoming track's library id, saved with the pair — see `ExcellentFollowUp.toTrackId`. */
    toTrackId: string | undefined
    /** v0.8.14: the raw entry second `startAutoTransition` was called with (pre phase-alignment) — what a later "excellent match" replay seeks the incoming track to. */
    entrySec: number
    /** v0.8.16: where the outgoing deck actually was at the join — what a replay waits for. Not `exitPointSec`, which is a structure guess made at the click. */
    joinedFromSec: number
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
    /** v0.9.59: files whose content is not what their extension says — the owner decides, one by one, in the "wrong extension" dialog */
    misnamed: MisnamedFile[]
    /** v0.9.59: content the check could not name, and files it could not open — counted, so "none misnamed" is never a guess */
    misnamedUnverified: string[]
    misnamedUnreadable: string[]
    /** v0.9.59: the check has run for this scan (before it, an empty list means "not looked yet") */
    misnamedChecked: boolean
    /** v0.9.59: the "wrong extension" dialog is open (the decks' keyboard is blocked while it is, like the other panels) */
    misnamedOpen: boolean
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
    /** v0.9.41: the tag pass has finished — only then does "no artist" mean the file has none */
    tagsRead: boolean
    /**
     * v0.9.41: the hash pass is over, so every track the owner already answered
     * (keyed by content hash) carries his answer. Before it, a rejected name is
     * offered again and an accepted artist reads as missing — and "✓ all" would
     * overwrite his own answers with them (change-reviewer, 06/10).
     */
    hashesRead: boolean
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
    /**
     * v0.8.25: the column the search box is limited to (the "BPM ▸" tag), or
     * `null` for the plain all-fields search. See `core/library-search.ts`.
     */
    queryColumn: SearchColumn | null
    /**
     * v0.9.24: the genres the table is limited to (the ▾ in the Genre header),
     * or `null` for every genre. `''` stands for "no genre", so a track with
     * none can be picked out too instead of only ever being filtered away.
     */
    genreFilter: string[] | null
    /**
     * v0.9.36: the ▾ filters on every other column (`core/library-filter.ts`).
     * `{}` is "no column filter"; an empty one is never stored.
     */
    columnFilters: ColumnFilters
    /**
     * v0.8.25: the ids of the rows the table actually draws, in order —
     * written by `Library.tsx`, read by `moveSelection`. Mix Only, "hide
     * played" and "more like this" narrow the table inside the component, so
     * until this the arrow keys walked a different list and the highlight
     * jumped onto rows that weren't on screen.
     */
    visibleIds: string[] | null
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
  /** v0.9.10b: the owner's hand-made vocal marks by content hash (loaded when a track reaches a deck), and the mark each deck has open — pressed "started", not yet "ended". */
  vocalManual: Record<string, VocalManualTag>
  vocalMarkOpen: Record<DeckId, { contentHash: string; startSec: number; kind?: 'voice' | 'none'; afterVoice?: boolean } | null>
  /** v0.9.30 stage 1 experiment: the owner's sample marks by content hash, the mark each deck has open, and the song each deck has band frames ready for (candidates need them). */
  sampleMarks: Record<string, SampleMarkTag>
  sampleMarkOpen: Record<DeckId, { contentHash: string; startSec: number; kind: SampleKind } | null>
  sampleFramesFor: Record<DeckId, string | null>
  /** v0.9.70: the "check the 1" queue, null when it is not running. Only what the screen needs; the song list lives in controls.ts. */
  barOneQueue: BarOneQueueState | null
  /** v0.9.73: content hashes that carry an owner-saved grid (= his "1" was checked). `null` until read, or when the read failed (said on screen). */
  ownerCheckedHashes: ReadonlySet<string> | null
  /** The song (hash) whose candidates failed to compute, so the lane says so instead of "computing" forever. */
  sampleFramesFailed: Record<DeckId, string | null>
  /**
   * v0.8.20: the result of moving data saved before the rename to `deckmix:` keys.
   * It gets its own slot instead of `notice`, because `notice` holds one
   * message and the latest one wins. Startup writes several others (a missing
   * audio device, genre orphans, sampler slots) within seconds, and a "could
   * not be moved" warning replaced before anyone reads it is a silent loss.
   */
  storageNotice: { text: string; tone: 'warn' | 'info' } | null

  /**
   * v0.9.34: the owner pulled the track list up. The decks then drop their
   * pads, platter and tall tempo fader (the FLX4 has all three in hardware) and
   * the mixer folds its master row beside the crossfader, so the list gets the
   * height they gave up. Pads alone would free nothing: the platter column
   * beside them is just as tall.
   */
  libraryExpanded: boolean

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
  setVocalManual: (contentHash: string, tag: VocalManualTag | null) => void
  setVocalMarkOpen: (deckId: DeckId, open: AppState['vocalMarkOpen'][DeckId]) => void
  setSampleMarks: (contentHash: string, tag: SampleMarkTag | null) => void
  setSampleMarkOpen: (deckId: DeckId, open: AppState['sampleMarkOpen'][DeckId]) => void
  setBarOneQueue: (q: BarOneQueueState | null) => void
  setOwnerCheckedHashes: (s: ReadonlySet<string> | null) => void
  setSampleFramesFor: (deckId: DeckId, contentHash: string | null) => void
  setSampleFramesFailed: (deckId: DeckId, contentHash: string | null) => void
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
  excellentPairsRev: 0,
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
    misnamed: [],
    misnamedUnverified: [],
    misnamedUnreadable: [],
    misnamedChecked: false,
    misnamedOpen: false,
    supported: true,
    boot: 'checking',
    bootDetail: null,
    unreadable: 0,
    tagsRead: false,
    hashesRead: false,
    sortKey: null,
    sortDir: 'asc',
    activeCrateId: null,
    queryColumn: null,
    genreFilter: null,
    columnFilters: {},
    visibleIds: null,
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
  vocalManual: {},
  vocalMarkOpen: { A: null, B: null },
  sampleMarks: {},
  sampleMarkOpen: { A: null, B: null },
  barOneQueue: null,
  ownerCheckedHashes: null,
  sampleFramesFor: { A: null, B: null },
  sampleFramesFailed: { A: null, B: null },
  storageNotice: null,
  libraryExpanded: false,
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
  // Every library write passes here — the tag pass, the background queue, a
  // deck's own analysis — so this is the one place a deck's copy of its track
  // can keep up with the key the library learns later (v0.8.35). Each writer
  // remembering to also patch the decks is how the gap opened in the first
  // place.
  setLibrary: (patch) =>
    set((s) => {
      const library = { ...s.library, ...patch }
      if (!patch.tracks) return { library }
      const decks = decksFollowLibraryKeys(s.decks, patch.tracks)
      return decks === s.decks ? { library } : { library, decks }
    }),
  setMidi: (patch) => set((s) => ({ midi: { ...s.midi, ...patch } })),
  setOutput: (patch) => set((s) => ({ output: { ...s.output, ...patch } })),
  setNotice: (notice) => set({ notice }),
  setVocalManual: (contentHash, tag) =>
    set((s) => {
      const next = { ...s.vocalManual }
      if (tag) next[contentHash] = tag
      else delete next[contentHash]
      return { vocalManual: next }
    }),
  setVocalMarkOpen: (deckId, open) => set((s) => ({ vocalMarkOpen: { ...s.vocalMarkOpen, [deckId]: open } })),
  setSampleMarks: (contentHash, tag) =>
    set((s) => {
      const next = { ...s.sampleMarks }
      if (tag) next[contentHash] = tag
      else delete next[contentHash]
      return { sampleMarks: next }
    }),
  setBarOneQueue: (q) => set({ barOneQueue: q }),
  setOwnerCheckedHashes: (s) => set({ ownerCheckedHashes: s }),
  setSampleMarkOpen: (deckId, open) => set((s) => ({ sampleMarkOpen: { ...s.sampleMarkOpen, [deckId]: open } })),
  setSampleFramesFor: (deckId, contentHash) => set((s) => ({ sampleFramesFor: { ...s.sampleFramesFor, [deckId]: contentHash } })),
  setSampleFramesFailed: (deckId, contentHash) => set((s) => ({ sampleFramesFailed: { ...s.sampleFramesFailed, [deckId]: contentHash } })),
  clearNotice: (source) => set((s) => (s.notice?.source === source ? { notice: null } : {})),
}))
