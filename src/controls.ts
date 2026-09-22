import { pcmFromAudioBuffer } from '@/platform/analyzer-js/analyze'
import { analysisCache } from '@/platform/analyze-cache-idb/store'
import { analyzerWorker } from '@/platform/analyzer-worker'
import { engine } from '@/platform/audio-webaudio/engine'
import type { RecorderTap } from '@/platform/audio-webaudio/recorder-tap'
import {
  buildCueSheet,
  detectRecordingGap,
  estimateSecondsRemaining,
  MASTER_RECORDING_MAX_SEC,
  mergeChunks,
  SAMPLER_CAPTURE_MAX_SEC,
  segmentFileNames,
  splitByTrackBoundaries,
} from '@/core/recording'
import { encodeWav } from '@/core/wav'
import { saveMasterRecording, saveSplitMasterRecording } from '@/platform/recorder-fsaccess/writer'
import { formatSetHistory } from '@/core/set-history'
import { saveSetHistoryText } from '@/platform/history-export-fsaccess/writer'
import {
  BEATGRID_NUDGE_SEC,
  HOT_CUE_COLORS,
  RECENTLY_REMOVED_WINDOW_SEC,
  syncTempoFor,
  tempoToRate,
  TRANSITION_CROSSFADE_SEC,
} from '@/core/constants'
import { beatJumpTargetSec, loopRollReturnSec, LOOP_BEATS_STEPS } from '@/core/padmodes'
import {
  bpmFromTaps,
  doubleGrid,
  halveGrid,
  phaseDeltaSec,
  quantizeToGrid,
  setDownbeatAt,
  shiftGrid,
} from '@/core/beatgrid'
import { crossfadeProgress, phaseAlignedEntrySec } from '@/core/transition'
import { findTransitionCandidates, nextCandidateFrom } from '@/core/structure'
import { setGenreOverrideByHash } from '@/platform/genre-overrides-idb/store'
import {
  setLastPlayed as persistLastPlayedByHash,
  setTrackNote as persistTrackNoteByHash,
} from '@/platform/track-meta-idb/store'
import {
  deleteCrateRecord,
  saveCrate,
  type CrateRecord,
} from '@/platform/crates-idb/store'
import { matchesQuery } from '@/core/library-search'
import { sortTracks } from '@/core/library-sort'
import { getCues, putCues } from '@/platform/cues-idb/store'
import { getTempo, putTempo } from '@/platform/tempo-idb/store'
import { getExcellentPoints, markExcellent } from '@/platform/mix-ratings-idb/store'
import { markExcellentPair } from '@/platform/mix-pairs-idb/store'
import { clock } from '@/platform/clock-audio'
import { readTagBpm, readTrackData } from '@/platform/source-fsaccess/library'
import { analysisCacheKey } from '@/core/analysis-cache'
import { hashBytes, hashFile } from '@/platform/source-fsaccess/hash'
import { settings } from '@/platform/settings-idb/store'
import { DEFAULTS, FIELD_BY_KEY, secPerRev, type Settings } from '@/core/settings'
import { isOrdinalLabel, moveHotCue as moveHotCuePure, pickHotCueSlot, shouldTriggerMixEntry } from '@/core/hotcues'
import { AI_TOOL_CATALOG, validateToolCall } from '@/core/ai/toolCatalog'
import {
  isSamplerMode,
  isSamplerSlotOccupied,
  samplerSyncRate,
  SAMPLER_SLOT_COUNT,
  type SamplerMode,
} from '@/core/sampler'
import {
  deleteRecordingBlob,
  getRecordingBlob,
  saveRecordingBlob,
} from '@/platform/sampler-recordings-idb/store'
import {
  exportSamplerBankToFile,
  getSamplerBank,
  importSamplerBankFromFile,
  saveSamplerBank,
  type StoredSamplerBank,
} from '@/platform/sampler-idb/store'
import {
  exportSamplerBankWithRecordings,
  importSamplerBankWithRecordings,
} from '@/platform/sampler-bank-fsaccess/store'
import { getFxBank, saveFxBank, type StoredFxBank } from '@/platform/fx-idb/store'
import { useStore, type FxState } from '@/app/state/store'
import type { AIMessage, AIToolCall } from '@/core/ports/ai'
import type { BeatGrid, DeckId, PadMode, Track } from '@/core/types'
import { aiLocalProvider } from '@/platform/ai-local'
import {
  acknowledgeAiWarning as acknowledgeAiWarning_idb,
  hasAcknowledgedAiWarning,
} from '@/platform/ai-local/warningAck'

/**
 * The control surface shared by the on-screen UI and the MIDI mapping layer.
 * Every user-facing action goes through here so a knob turn and a mouse drag
 * stay in sync.
 */

/**
 * The user's settings, held in a plain local and refreshed on change.
 *
 * **Not read from the store per call, and that is a performance decision with
 * a scar behind it.** The FLX4 sends ~670 jog messages a second and every one
 * lands in `jogTurn`; the first version of the jog readout did per-message work
 * and could plausibly have starved the render loop that draws the playhead.
 * A subscription costs one assignment per *change* instead of a lookup per
 * *tick*, and the port is documented to be used exactly this way.
 */
let cfg: Settings = DEFAULTS
settings.subscribe((v) => {
  const prev = cfg
  cfg = v
  // Two of these values are baked into an audio node the moment a knob or a
  // fader is moved, so changing them on the screen would otherwise do nothing
  // until the user happened to touch that control again — a setting that
  // appears to apply and does not. Re-apply from the store's current knob
  // positions instead. Only on an actual change: this runs on every write.
  if (v.eqDb !== prev.eqDb || v.tempoRange !== prev.tempoRange) {
    const { decks, mixer } = useStore.getState()
    for (const id of ['A', 'B'] as DeckId[]) {
      const deck = engine.decks[id]
      if (v.eqDb !== prev.eqDb) {
        deck.setEq('low', mixer.channels[id].eqLow)
        deck.setEq('mid', mixer.channels[id].eqMid)
        deck.setEq('high', mixer.channels[id].eqHigh)
      }
      if (v.tempoRange !== prev.tempoRange) deck.setTempo(decks[id].tempo)
    }
  }
})

export async function initAudio() {
  await engine.resume()
  const state = useStore.getState()
  if (!state.audioReady) {
    engine.setMasterVolume(state.mixer.masterVolume)
    engine.setCueVolume(state.mixer.cueVolume)
    engine.setCueMix(state.mixer.cueMix)
    engine.setCrossfader(state.mixer.crossfader)
    ;(['A', 'B'] as DeckId[]).forEach((id) => {
      const ch = state.mixer.channels[id]
      engine.decks[id].setVolume(ch.volume)
    })
    engine.setSamplerVolume(state.sampler.channel.volume)
    engine.setSamplerCueMonitor(state.sampler.channel.cueMonitor)
    engine.sampler.onSlotEnded = (index) => {
      useStore.getState().patchSamplerSlot(index, { playing: false })
    }
    useStore.setState({ audioReady: true })
    syncScratchState()
    syncFxWorkletState()
    void restoreSamplerBankMeta()
    // A recorded slot (v0.7.5) has no library file to wait for — unlike a
    // contentHash-linked slot, it doesn't need `Library.tsx`'s scan to
    // resolve. Firing this here too, silently, means a recording restores
    // on boot even before any scan runs (or when there's no saved library
    // folder at all) — `resolveSamplerSlots` itself is a no-op for anything
    // still unresolved, same `silent: true` shape `Library.tsx`'s own early
    // calls already use.
    void resolveSamplerSlots({ silent: true })
    void restoreFxBank()
  }
}

/** Copy the engine's scratch availability into the store for the TopBar pill. */
function syncScratchState() {
  useStore.setState({
    scratchReady: engine.scratchAvailable,
    scratchError: engine.scratchError,
  })
}

// Subscribed at module scope, deliberately not inside initAudio's first-run
// block. A worklet can die mid-render hours after boot, and anything wired only
// on the first initialisation is not wired at all if audio was already running
// — which is the same one-shot mistake that left the pill dead in the first place.
engine.onScratchStateChange = syncScratchState

/**
 * Copy the engine's Bit Crusher/Roll worklet availability into the store, so
 * `Mixer.tsx`'s FX cycle-button can react to it — a one-shot call after
 * `engine.resume()` (which already awaits `ensureFxWorklet`), not a
 * persistent subscription like `syncScratchState`: no post-boot failure path
 * for this worklet has been identified, so there is nothing later to react to.
 */
function syncFxWorkletState() {
  useStore.setState({
    fxWorkletReady: engine.fxWorkletAvailable,
    fxWorkletError: engine.fxWorkletError,
  })
}

// ————————————————————————————————————————————————————————————————
// Mix Assist (v0.4.6), build step 9 — the 30s "don't suggest it right back"
// window. Module-level like `activeTransition` below, not the store: this is
// bookkeeping for the suggestion list, not UI state anything renders
// directly, and a `Map` with real timestamps has no reason to be
// serializable. Library.tsx reads `recentlyRemovedTrackIds()` on its own
// periodic tick so an id ages back out on its own, without this file having
// to schedule anything.
// ————————————————————————————————————————————————————————————————

const recentlyRemovedAt = new Map<string, number>()

function markRecentlyRemoved(trackId: string) {
  recentlyRemovedAt.set(trackId, Date.now())
}

/** Track ids still inside the window — and a free place to drop anything that's aged out, so the map never grows unbounded. */
export function recentlyRemovedTrackIds(nowMs: number = Date.now()): Set<string> {
  const ids = new Set<string>()
  for (const [id, at] of recentlyRemovedAt) {
    if (nowMs - at < RECENTLY_REMOVED_WINDOW_SEC * 1000) ids.add(id)
    else recentlyRemovedAt.delete(id)
  }
  return ids
}

export async function loadTrackToDeck(deckId: DeckId, track: Track) {
  await initAudio()
  const { patchDeck, setNotice, clearNotice } = useStore.getState()

  // Loading over a deck that is playing cuts a live track mid-set, and the
  // gesture that does it — double-click, or a LOAD button — is one keystroke
  // away from the one that loads the other deck. Refusing is the default, and
  // the refusal is spoken: a load that quietly does nothing looks like a dead
  // button, which is the failure mode this project treats as a bug.
  if (settings.values.lockPlayingDeck && engine.decks[deckId].playing) {
    setNotice({
      // The field's own label, not a copy of it. The first version of this
      // message hard-coded "Lock a playing deck"; the label was then reworded
      // and the message went on pointing at a control that no longer had that
      // name — a direction that sends the user looking for something they will
      // not find is its own small lie. tests/core/settings.test.ts fails if a
      // notice ever names a field that is not in the schema.
      text: `Deck ${deckId} is playing — load refused. Settings › Feel › ${FIELD_BY_KEY.get('lockPlayingDeck')?.label} turns this off.`,
      tone: 'warn',
      source: 'load',
    })
    return
  }
  // Only this function's own message is cleared. It used to clear the notice
  // outright, which threw away whatever else was up there — the
  // "your audio device is not connected" warning is set at startup and was
  // wiped by the first track load, before the owner could read it.
  clearNotice('load')
  // A track swap on either side of a running autonomous transition would
  // pull the buffer out from under a live crossfade — `lockPlayingDeck`
  // (when the user has it on) already refuses this for whichever deck is
  // currently `playing`, but a transition can involve a deck this check
  // doesn't cover on its own, so cancel outright rather than let the load
  // proceed underneath it.
  if (activeTransition && (deckId === activeTransition.fromDeckId || deckId === activeTransition.toDeckId)) {
    cancelTransition()
  }
  patchDeck(deckId, { loading: true })
  let buffer: AudioBuffer
  let contentHash: string | undefined
  try {
    const data = await readTrackData(track)
    // Hashed from the raw file bytes, *before* decode — `decodeAudioData`
    // neuters its input `ArrayBuffer` per spec (its `byteLength` becomes 0
    // once decoding starts), so hashing `data` after `engine.decode(data)`
    // would silently hash an empty buffer and give every track the same
    // "identity". Caught on its own: a hash failure degrades to "not yet
    // identified" (`contentHash` stays `undefined`) rather than blocking
    // playback — the track still loads either way.
    try {
      contentHash = await hashBytes(data)
    } catch (hashErr) {
      console.error('hash failed', hashErr)
    }
    buffer = await engine.decode(data)
  } catch (err) {
    console.error('load failed', err)
    patchDeck(deckId, { loading: false })
    // Every call site fires this with `void` (mouse, keyboard, MIDI) and none
    // attaches its own `.catch` — a decode failure (corrupt file, or a file
    // whose extension matches but Chromium can't actually decode) used to
    // become only an unhandled rejection in the console while the UI looked
    // idle. Surface it the same way setTrackGenre surfaces its own async
    // failure, and stop re-throwing: nothing downstream was ever catching it.
    setNotice({
      text: `"${track.name}" didn't load — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'load',
    })
    return
  }
  const durationSec = buffer.duration
  // v0.8.0: stamped only once decode succeeded, not right after the hash —
  // a track that hashes fine but fails to decode never actually played.
  // No `contentHash` means no key to stamp against, so that part degrades
  // silently (same as the hash failure above) — but a write failure below
  // is surfaced via the notice banner, same as setTrackGenre/setTrackNote's
  // own async-persist failures: found by independent review that the
  // first version of this only logged to console, which nobody using the
  // app ever sees, and is exactly the silent-skip CLAUDE.md forbids.
  if (contentHash) {
    // Optimistic, same as setTrackGenre/setTrackNote — the Library table's
    // "Last played" column reflects this load immediately rather than only
    // after the next rescan re-merges it from track-meta-idb.
    const stampedAt = Date.now()
    const { library, setLibrary, appendHistoryEntry } = useStore.getState()
    setLibrary({
      tracks: library.tracks.map((t) => (t.id === track.id ? { ...t, lastPlayedAt: stampedAt } : t)),
    })
    // v0.8.3: every successful load — including a quick re-check load —
    // becomes a history entry. Deliberately not deduplicated (Shalom's own
    // decision, 13/09): the list shows everything that was actually loaded,
    // in full, and any trimming before sharing is his own judgment call.
    appendHistoryEntry({
      deckId,
      contentHash,
      name: track.title ?? track.name,
      artist: track.artist ?? null,
      loadedAtMs: stampedAt,
    })
    void persistLastPlayedByHash(contentHash, stampedAt).catch((err) => {
      setNotice({
        text: `"${track.name}" loaded, but its "last played" time wasn't saved: ${err instanceof Error ? err.message : String(err)}`,
        tone: 'warn',
        source: 'library',
      })
    })
  }
  // A hash failure above leaves `contentHash` `undefined` — "not yet
  // identified", same as a track whose analysis hasn't reached it yet. Its
  // cue bank simply isn't found, the same shape as a first-ever load.
  const storedCues = contentHash ? await getCues(contentHash) : null
  // v0.5.3: cues saved before `HotCue.kind` existed never set it — but back
  // then a non-ordinal label had exactly one cause (`saveMixEntryHotCue`),
  // so that's still a reliable one-time signal now that a label alone can't
  // tell a saved mix-in pad apart from a manually renamed plain one.
  // Recomputed on every load rather than rewritten into storage — cheap,
  // deterministic, and no separate migration script needed for one field.
  const hotCues = (storedCues?.hotCues ?? []).map((c) =>
    c.kind == null && !isOrdinalLabel(c) ? { ...c, kind: 'mixEntry' as const } : c,
  )
  const cuePointSec = storedCues?.cuePointSec ?? 0
  // v0.8.6 kept the previous track's fader position when nothing was saved
  // ("like a physical fader"). Shalom found it wrong (20/09): the new track
  // showed the old track's tempo offset, so its own BPM never appeared. `null`
  // (never saved for this track, or hash unknown) now resets to 0 = the file's
  // own BPM; only a value saved for this exact track overrides that.
  const storedTempo = contentHash ? await getTempo(contentHash) : null
  // v0.5.4: same "not yet identified, not an error" treatment as `storedCues`.
  const excellentMixPoints = contentHash ? await getExcellentPoints(contentHash) : []
  // "First cue point" (Settings › Feel › On track load) means this saved CUE
  // point — the one thing `onLoadPlayhead` had nothing to read before this
  // version (core/settings.ts's `pending` note on the field, now resolved).
  const startSec = cfg.onLoadPlayhead === 'firstCue' ? cuePointSec : 0
  // Load the deck the moment decode finishes — never wait on analysis to let
  // the owner hear the track (v0.4.0: a not-yet-analyzed or failed-analysis
  // track still plays, per the owner's explicit decision; see
  // workshop-output/FEATURE_SPEC.md). `deck.load` only ever *copies* channel
  // samples out (`copyFromChannel` inside the worklet player), so `buffer`'s
  // own data is still fully intact and readable afterward — this is what
  // makes it safe to hand `buffer` to the deck first and extract PCM for
  // analysis second, below.
  // Mix Assist (v0.4.6): whatever this deck held before is now "just came
  // off a deck" — read before the overwrite below replaces it. Skipped when
  // it's the same track reloading onto itself: that one never left.
  const outgoingId = useStore.getState().decks[deckId].track?.id
  if (outgoingId && outgoingId !== track.id) markRecentlyRemoved(outgoingId)

  engine.decks[deckId].load(buffer)
  // Applied straight to the engine, not through `setTempo` — that function's
  // extra work (cancelling an active transition, rescheduling this same
  // persist, refreshing FX beat-sync time) is for a genuine fader touch, not
  // for re-applying a value that was already this track's saved tempo a
  // moment ago.
  engine.decks[deckId].setTempo(storedTempo ?? 0)
  if (startSec > 0) engine.decks[deckId].seek(startSec)
  patchDeck(deckId, {
    track: { ...track, contentHash, bpm: track.bpm ?? undefined, durationSec },
    loading: false,
    playing: false,
    positionSec: startSec,
    durationSec,
    bpm: track.bpm ?? null,
    beatGrid: null,
    beatGridConfirmed: false,
    syncActive: false,
    peaks: null,
    bands: null,
    tempo: storedTempo ?? 0,
    hotCues,
    cuePointSec,
    excellentMixPoints,
    loopActive: false,
  })
  // A (re)load can change this deck's bpm/tempo as much as touching the
  // tempo fader does — found by change-reviewer (v0.8.6): loading a track
  // straight onto the deck that's already master silently left FX beat-sync
  // time computed against the old bpm until the fader or SYNC was next
  // touched. Guarded the same way setTempo already is.
  if (useStore.getState().masterDeckId === deckId) refreshFxTimeForMasterTempo()
  const { library, setLibrary } = useStore.getState()
  setLibrary({
    tracks: library.tracks.map((t) => (t.id === track.id ? { ...t, contentHash, durationSec } : t)),
  })

  // Analysis is best-effort from here: the track is already loaded and
  // playable, so a failure here means "no waveform/grid yet", never "the
  // load failed" — caught on its own, never re-thrown to this function's
  // caller (v0.4.0 acceptance criterion 3).
  try {
    // No hash (a hashing failure above) means "not yet identified" — analysis
    // still runs so this load gets its waveform/grid, it just can't be cached
    // or looked up by identity yet.
    const hintBpm = await readTagBpm(track)
    const cacheKey = contentHash ? analysisCacheKey(contentHash, hintBpm) : null
    let analysis = cacheKey ? await analysisCache.get(cacheKey) : null
    if (!analysis) {
      // `pcmFromAudioBuffer` only now, not before `deck.load` above: the
      // Worker path transfers (detaches) these channel buffers, and nothing
      // else needs to read `buffer` again after this point.
      const pcm = pcmFromAudioBuffer(buffer)
      analysis = await analyzerWorker.analyze(pcm, { hintBpm })
      if (cacheKey) await analysisCache.put(cacheKey, analysis)
    }
    // A fast second load on this same deck may have already replaced the
    // track this analysis was for — don't let a late result clobber it.
    if (useStore.getState().decks[deckId].track?.id !== track.id) return

    // A tag written by Serato still beats our own bpm guess — v0.1.7 measured
    // tag accuracy at 97% across the user's library, and detection is still
    // autocorrelation on an onset envelope, occasionally an octave off (see
    // core/beatgrid.ts). What v0.3.0 changes: detection is the *only* source
    // of phase (`offsetSec`) — tags carry no phase — so it always runs and its
    // grid is always kept, even when the tag wins on the bpm number itself.
    // Exception (20/09): a tag is usually a rounded label ("100") of a tempo
    // that is really 99.8 or 100.3, and a grid built on the rounded number
    // drifts a whole beat over a song. When our own refined estimate is within
    // 2% of the tag they are the same tempo, and the finer number is the one
    // that stays on the beats; a bigger gap is an octave/detection miss, where
    // the tag still wins as before.
    const detectedBpm = analysis.beatGrid?.bpm ?? null
    const tagAgrees =
      track.bpm != null && detectedBpm != null && Math.abs(detectedBpm - track.bpm) / track.bpm <= 0.02
    const bpm = tagAgrees ? detectedBpm : (track.bpm ?? analysis.bpm)
    const beatGrid: BeatGrid | null = analysis.beatGrid
      ? { bpm: bpm ?? analysis.beatGrid.bpm, offsetSec: analysis.beatGrid.offsetSec }
      : null
    patchDeck(deckId, {
      track: { ...track, contentHash, analysisState: 'analyzed', bpm: bpm ?? undefined, durationSec },
      bpm,
      // Unconfirmed whenever detection didn't produce a grid it trusts — never
      // a silently-assumed-fine grid. Cleared only by the user checking or
      // editing it (BeatGridPanel, v0.3.0 sub-step d).
      beatGridConfirmed: analysis.beatGridConfirmed,
      beatGrid,
      peaks: analysis.peaks,
      bands: analysis.bands,
    })
    // Analysis can settle on a different bpm than the tag-based value the
    // load above already refreshed FX against (e.g. no tag bpm at all) —
    // same guard, same reasoning.
    if (useStore.getState().masterDeckId === deckId) refreshFxTimeForMasterTempo()
    const { library: libAfter, setLibrary: setLibAfter } = useStore.getState()
    setLibAfter({
      tracks: libAfter.tracks.map((t) =>
        t.id === track.id ? { ...t, contentHash, analysisState: 'analyzed', bpm: bpm ?? t.bpm } : t,
      ),
    })
  } catch (err) {
    console.error('analysis failed', err)
    if (useStore.getState().decks[deckId].track?.id !== track.id) return
    const message = err instanceof Error ? err.message : String(err)
    patchDeck(deckId, {
      track: { ...track, contentHash, analysisState: 'failed', analysisError: message, durationSec },
    })
    const { library: libAfter, setLibrary: setLibAfter } = useStore.getState()
    setLibAfter({
      tracks: libAfter.tracks.map((t) =>
        t.id === track.id ? { ...t, contentHash, analysisState: 'failed', analysisError: message } : t,
      ),
    })
  }
}

/**
 * Mix Assist (v0.4.6): loading a suggested track is stricter than a manual
 * load — it must never land on a deck that already has *any* track on it,
 * even one that's merely paused (`loadTrackToDeck`'s own
 * `lockPlayingDeck` guard only refuses a deck that's actively playing). A
 * thin wrapper rather than a change to `loadTrackToDeck` itself: manual
 * double-click/drag loading keeps behaving exactly as it does today: this
 * only tightens the one new path a suggestion click takes.
 *
 * `awayFromDeck` is the deck the suggestion was matched against (`MixMatch.
 * deck`) — the suggestion belongs on the *other* deck, never on the one
 * already playing the track it was matched to.
 */
export function loadSuggestionToDeck(track: Track, awayFromDeck: DeckId) {
  const target: DeckId = awayFromDeck === 'A' ? 'B' : 'A'
  const { decks, setNotice } = useStore.getState()
  if (decks[target].track) {
    setNotice({
      text: `Deck ${target} already has a track loaded — unload it before loading a suggestion there.`,
      tone: 'warn',
      source: 'load',
    })
    return
  }
  void loadTrackToDeck(target, track)
}

/**
 * v0.8.14: a click on the "Excellent matches" strip (`Library.tsx`) — unlike
 * `loadSuggestionToDeck` above, this doesn't just load the track, it replays
 * the whole mix that was rated excellent last time: load, seek to the entry
 * point that worked, then `startAutoTransition` immediately. Composes three
 * already-existing pieces rather than new async infrastructure:
 * `loadSuggestionToDeck`'s free-deck check, `loadTrackToDeck`'s own in-line
 * await of analysis (so its promise resolving already means "beatGrid is
 * ready or failed"), and `startAutoTransition` unchanged.
 *
 * Shalom's explicit call (22/09): starts immediately on click, no waiting for
 * the live outgoing deck to reach the exit point it used last time — only the
 * *entry* point is replayed, the exit point is still `startAutoTransition`'s
 * own live "next candidate ahead" heuristic, same as a manual transition.
 *
 * `fromHashAtClick` guards the one gap `startAutoTransition`'s own
 * preconditions don't cover: loading + analyzing the incoming track can take
 * a second or two, and nothing else here checks *which* track is still on
 * the outgoing deck by the time that finishes. Without this check, swapping
 * the outgoing deck's track mid-load would still fire the transition, using
 * an entry point calibrated for a pairing that's no longer playing.
 * `phaseAlignedEntrySec` (inside `startAutoTransition`) would keep that
 * technically safe — no bad seek — but the *pairing* itself would be wrong,
 * and Shalom chose to refuse and say so rather than proceed regardless.
 */
export async function startExcellentPairTransition(
  fromDeckId: DeckId,
  fromHashAtClick: string,
  toTrack: Track,
  entrySec: number,
) {
  const target: DeckId = fromDeckId === 'A' ? 'B' : 'A'
  const { decks, setNotice } = useStore.getState()
  if (decks[target].track) {
    setNotice({
      text: `Deck ${target} already has a track loaded — unload it before starting an excellent-match mix there.`,
      tone: 'warn',
      source: 'mixRating',
    })
    return
  }
  await loadTrackToDeck(target, toTrack)
  if (useStore.getState().decks[fromDeckId].track?.contentHash !== fromHashAtClick) {
    useStore.getState().setNotice({
      text: `Deck ${fromDeckId} is playing a different track now — mix not started.`,
      tone: 'warn',
      source: 'mixRating',
    })
    return
  }
  startAutoTransition(fromDeckId, target, entrySec)
}

/**
 * First deck to start playing becomes master by default (v0.3.0) — the
 * automatic half of "auto + manual override". A no-op once a master already
 * exists, whether set this way or by an explicit long-press. Deliberately not
 * wired to `cuePlayPreview`'s hold-to-preview: a momentary CUE-hold is not
 * "starting to play" in the sense a DJ means it.
 */
function maybeAutoMaster(deckId: DeckId) {
  if (useStore.getState().masterDeckId == null) useStore.setState({ masterDeckId: deckId })
}

/**
 * Stopping the outgoing deck mid-transition used to cancel the transition,
 * and a cancel pauses the incoming deck too — one PAUSE press silenced both
 * decks. Refused instead, and named: CANCEL TRANSITION is the one way back,
 * and it leaves the outgoing deck playing.
 */
function blockStopOfOutgoingDeck(deckId: DeckId): boolean {
  if (!activeTransition || deckId !== activeTransition.fromDeckId) return false
  useStore.getState().setNotice({
    text: `Deck ${deckId} is fading out in a transition — press CANCEL TRANSITION to stop it, or wait for it to finish.`,
    tone: 'warn',
    source: 'sync',
  })
  return true
}

export function togglePlay(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  if (deck.playing && blockStopOfOutgoingDeck(deckId)) return
  // Captured before the guard: cancelling pauses+repositions the *incoming*
  // deck by itself (cancelTransition's own restore), and this is a *toggle* —
  // calling deck.togglePlay() afterward would see it now paused and flip it
  // right back to playing, undoing the very pause the user pressed for. The
  // outgoing deck is untouched by a cancel, so its own toggle below still
  // runs normally.
  const wasIncomingDeckOfTransition = activeTransition?.toDeckId === deckId
  cancelTransitionIfEitherDeckTouched(deckId)
  if (wasIncomingDeckOfTransition) return
  deck.togglePlay()
  useStore.getState().patchDeck(deckId, { playing: deck.playing })
  if (deck.playing) maybeAutoMaster(deckId)
}

export function play(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack || deck.playing) return
  deck.play()
  useStore.getState().patchDeck(deckId, { playing: true })
  maybeAutoMaster(deckId)
}

export function pause(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.playing) return
  if (blockStopOfOutgoingDeck(deckId)) return
  cancelTransitionIfEitherDeckTouched(deckId)
  deck.pause()
  useStore.getState().patchDeck(deckId, { playing: false })
}

/**
 * Persist the current cue bank + CUE point for whatever track is on this deck
 * (v0.4.0). A no-op when the track has no `contentHash` yet (hash failed, or
 * hasn't been computed — see `loadTrackToDeck`): the edit still applies on
 * screen, it just isn't identified well enough to save yet. A write failure
 * is surfaced, not swallowed — the central rule this whole project is built
 * around — because a cue that looks set but silently isn't saved is worse
 * than one the user never tried to set.
 */
function persistCues(deckId: DeckId) {
  const { decks, setNotice } = useStore.getState()
  const st = decks[deckId]
  const hash = st.track?.contentHash
  if (!hash) return
  void putCues(hash, { hotCues: st.hotCues, cuePointSec: st.cuePointSec }).catch((err) => {
    setNotice({
      text: `Cue point set on screen but not saved: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'cues',
    })
  })
}

/** CUE button: if playing, stop and jump to cue point; if stopped, set cue point here. */
export function cue(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const st = useStore.getState().decks[deckId]
  if (deck.playing) {
    if (blockStopOfOutgoingDeck(deckId)) return
    cancelTransitionIfEitherDeckTouched(deckId)
    deck.pause()
    deck.seek(st.cuePointSec)
    useStore.getState().patchDeck(deckId, { playing: false, positionSec: st.cuePointSec })
  } else if (Math.abs(deck.position - st.cuePointSec) > 0.05) {
    deck.seek(st.cuePointSec)
    useStore.getState().patchDeck(deckId, { positionSec: st.cuePointSec })
  } else {
    useStore.getState().patchDeck(deckId, { cuePointSec: quantizeIfOn(deckId, deck.position) })
    persistCues(deckId)
  }
}

/** Hold CUE to preview from the cue point. Call release() when the button lifts. */
export function cuePlayPreview(deckId: DeckId): () => void {
  const deck = engine.decks[deckId]
  const st = useStore.getState().decks[deckId]
  if (!deck.hasTrack) return () => {}
  cancelTransitionIfEitherDeckTouched(deckId)
  deck.seek(st.cuePointSec)
  deck.play()
  useStore.getState().patchDeck(deckId, { playing: true })
  return () => {
    deck.pause()
    deck.seek(st.cuePointSec)
    useStore.getState().patchDeck(deckId, { playing: false, positionSec: st.cuePointSec })
  }
}

export function seekDeck(deckId: DeckId, sec: number) {
  engine.decks[deckId].seek(sec)
  useStore.getState().patchDeck(deckId, { positionSec: sec })
}

/**
 * Platter grabbed. Both the on-screen platter and a jog-wheel touch land here,
 * which is the point of this module: one path, so a mouse drag and a finger on
 * the FLX4 cannot drift apart.
 */
export function beginScratch(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  cancelTransitionIfEitherDeckTouched(deckId)
  deck.beginScratch()
  useStore.getState().patchDeck(deckId, { scratching: true, playing: deck.playing })
}

/** Rate in playback multiples while held: 1 = forward at speed, negative = back. */
export function scratchRate(deckId: DeckId, rate: number) {
  engine.decks[deckId].scratchRate(rate)
}

export function endScratch(deckId: DeckId) {
  const deck = engine.decks[deckId]
  deck.endScratch()
  useStore.getState().patchDeck(deckId, { scratching: false, playing: deck.playing })
}

/**
 * Jog-wheel ticks from a controller.
 *
 * The same wheel does two jobs, decided by whether the platter is being
 * touched — which is why the touch sensor is its own binding. Held: the wheel
 * is the record, and ticks become a scratch rate. Not held: the wheel is the
 * rim of a running deck, and ticks become a pitch bend that decays back.
 *
 * Ticks are converted to a rate over elapsed time rather than used directly,
 * so how fast the wheel is turned decides the rate, not how often the
 * controller happens to report.
 */
const jogState: Record<string, { time: number; rate: number }> = {}

/**
 * Ticks per revolution, smoothing and platter speed all live in Settings now
 * (`jogTicksPerRev`, `jogSmoothing`, `platterRpm`). They were hard-coded here
 * through v0.2.4, and changing one cost a full code -> commit -> push -> pull
 * -> restart round trip on hardware only the owner has. That round trip is what
 * v0.2.5 exists to remove.
 */
const JOG_MAX_RATE = 8
/**
 * Bend strength per tick when the platter is not held.
 *
 * Recalibrated 30/08 after the FLX4's decode was fixed, because this number was
 * silently tuned against the broken one. Every jog message used to arrive as
 * `ticks = 63`, so `63 * 0.012 = 0.756` clamped to the 0.5 ceiling — **every
 * touch of the rim jumped straight to the maximum ±50% bend**. It felt like it
 * worked; it was the bug, at full volume. With one message now correctly worth
 * one tick, the same constant gave 1.2% and the rim felt dead.
 *
 * Deliberately per-tick and not rate-based: `ticks` per message already grows
 * with speed (the FLX4 sends 65/66/67 for 1/2/3 ticks), and a rate would have to
 * divide by `JOG_TICKS_PER_REV`, which is still unmeasured. This value is
 * independent of that one, so it does not move when that number is finally set.
 *
 * It is a **feel** value — the ceiling below is the real safety net. Tune it here.
 *
 * 0.05 -> 0.10 on the owner's verdict after trying it on the FLX4: "very slow".
 * That lands the useful range where the commercial tools sit, because ticks per
 * message already scale with how hard the wheel is turned — the FLX4 sends
 * 65/66/67 for 1/2/3 ticks, so an easy nudge is ~10% and a hard shove ~30%,
 * with the ±0.5 clamp still catching a genuine spin.
 *
 * The default is `BEND_PER_TICK` in `core/constants.ts`; the live value is
 * `cfg.bendPerTick`, and the ±0.5 clamp below stays in code because it is the
 * safety net, not the preference.
 */

/**
 * Say what the jog just did — including when it did nothing, and why.
 *
 * Throttled, and that is not a nicety. The FLX4 sends ~670 jog messages per
 * revolution, so a store write per message is hundreds of React re-renders a
 * second, all of them to retype one line of text in the top bar. The first
 * version of this readout did exactly that and could plausibly have starved the
 * render loop that draws the playhead — a diagnostic that breaks the thing it
 * is diagnosing is worse than none. 10 Hz is faster than anyone reads.
 */
const JOG_REPORT_MS = 100
let lastJogReport = { at: 0, text: '' }

function reportJog(deckId: DeckId, what: string) {
  const text = `${deckId}: ${what}`
  const now = performance.now()
  if (text === lastJogReport.text && now - lastJogReport.at < JOG_REPORT_MS) return
  lastJogReport = { at: now, text }
  useStore.getState().setMidi({ lastJog: text })
}

/**
 * Jog measurement, for the Settings screen's "Measure" button.
 *
 * `JOG_TICKS_PER_REV` is a property of the controller and was never measurable
 * from here: three hand counts on the FLX4 gave 696 / 673 / 669, all lower
 * bounds, because counting revolutions by hand undercounts. This intercepts the
 * tick stream **before** bend and scratch, so a measuring turn moves the number
 * and not the deck — a wheel that scratched while being measured would be
 * counted through a moving track, which is how the earlier counts went wrong.
 */
let jogMeasure: {
  deckId: DeckId
  ticks: number
  onTick: (total: number) => void
  lastPaint: number
} | null = null

export function beginJogMeasure(deckId: DeckId, onTick: (total: number) => void): () => number {
  jogMeasure = { deckId, ticks: 0, onTick, lastPaint: 0 }
  return () => {
    const total = jogMeasure?.ticks ?? 0
    jogMeasure = null
    // The exact count comes from here, not from the throttled readout, so the
    // saved value is never the one a dropped repaint happened to show.
    onTick(total)
    return total
  }
}

export function jogTurn(deckId: DeckId, ticks: number) {
  if (jogMeasure && jogMeasure.deckId === deckId) {
    // Absolute value: a hand that wobbles back a tick mid-turn has still
    // travelled that tick, and signed accumulation would quietly subtract it.
    jogMeasure.ticks += Math.abs(ticks)
    // Throttled for the same reason the jog readout is (see JOG_REPORT_MS): the
    // FLX4 sends ~670 messages a second and each one arrives in its own MIDI
    // event, so an unthrottled setState here is ~670 React renders a second
    // during the one gesture whose smoothness the measurement depends on.
    const now = performance.now()
    if (now - jogMeasure.lastPaint >= JOG_REPORT_MS) {
      jogMeasure.lastPaint = now
      jogMeasure.onTick(jogMeasure.ticks)
    }
    reportJog(deckId, `measuring — ${jogMeasure.ticks} ticks`)
    return
  }

  const deck = engine.decks[deckId]
  if (!deck.hasTrack) {
    reportJog(deckId, 'ignored — no track loaded')
    return
  }
  cancelTransitionIfEitherDeckTouched(deckId)

  if (!deck.scratching) {
    const amount = Math.max(-0.5, Math.min(0.5, ticks * cfg.bendPerTick))
    if (!deck.playing) {
      // The decision (30/08, with the owner): a stopped deck does nothing on the
      // rim — there is no speed to bend. It says so rather than looking broken.
      reportJog(deckId, `bend ${(amount * 100).toFixed(0)}% ignored — deck stopped`)
      return
    }
    deck.pitchBend(amount)
    reportJog(deckId, `bend ${amount > 0 ? '+' : ''}${(amount * 100).toFixed(0)}% (${ticks} ticks)`)
    return
  }

  const now = performance.now()
  const prev = jogState[deckId]
  const dt = prev ? (now - prev.time) / 1000 : 0
  if (dt <= 0) {
    jogState[deckId] = { time: now, rate: prev?.rate ?? 0 }
    return
  }
  const revs = ticks / cfg.jogTicksPerRev
  const instant = (revs * secPerRev(cfg.platterRpm)) / dt
  const smoothed = (prev?.rate ?? 0) + (instant - (prev?.rate ?? 0)) * cfg.jogSmoothing
  const rate = Math.max(-JOG_MAX_RATE, Math.min(JOG_MAX_RATE, smoothed))
  jogState[deckId] = { time: now, rate }
  deck.scratchRate(rate)
  reportJog(deckId, `scratch ${rate.toFixed(2)}x`)
}

/** Platter touch sensor: the hand landing on the record, and coming off it. */
export function jogTouch(deckId: DeckId, down: boolean) {
  // The Settings screen promises "the wheel will not move the deck while
  // measuring", and `jogTurn` alone did not keep it: the natural way to turn an
  // FLX4 wheel is by the top plate, which is the capacitive sensor, so a
  // measuring turn entered scratch mode at rate 0 and froze a live track for
  // the whole revolution. The ticks were counted correctly and the audio
  // stopped — the promise on screen has to cover the touch sensor too.
  if (jogMeasure && jogMeasure.deckId === deckId) return
  if (down) {
    jogState[deckId] = { time: performance.now(), rate: 0 }
    beginScratch(deckId)
  } else {
    delete jogState[deckId]
    endScratch(deckId)
  }
}

export function toggleVinylMode(deckId: DeckId) {
  const deck = engine.decks[deckId]
  const on = !deck.vinylMode
  deck.setVinylMode(on)
  useStore.getState().patchDeck(deckId, { vinylMode: on })
}

/**
 * Pitch bend held down and then let go — the keyboard's version of a hand on
 * the rim. Kept separate from `jogTurn`'s bend, which is per-tick and decays on
 * its own because a wheel tick has no release.
 *
 * No FLX4 control is bound to this: on the hardware the jog does the job. If a
 * button is ever mapped to it, it needs a `ControlAction` pair and a case in
 * `dispatch` — down and up, not one message.
 */
export function bendDeck(deckId: DeckId, amount: number) {
  cancelTransitionIfEitherDeckTouched(deckId)
  engine.decks[deckId].holdBend(amount)
}

export function releaseBend(deckId: DeckId) {
  engine.decks[deckId].releaseBend()
}

export function nudgeDeck(deckId: DeckId, deltaSec: number) {
  const deck = engine.decks[deckId]
  seekDeck(deckId, deck.position + deltaSec)
}

/**
 * Live bar/downbeat correction (v0.8.8) — jumps the deck by exactly one
 * whole beat (`60 / grid.bpm` seconds), forward or back. Deliberately NOT a
 * `BeatGrid` edit: `phaseDeltaSec`'s phase math (`core/beatgrid.ts`) folds
 * to a single beat period, so a whole-beat seek is invisible to it — SYNC
 * stays locked with no special-casing. This is what makes the shift safe:
 * it corrects which beat lines up as "one" without touching why SYNC
 * thinks it's already correct. `workshop-output/FEATURE_SPEC_BARSYNC.md`
 * has the full story — `estimateBeatGrid` can find beat phase, never bar
 * phase, so this exists as a live, by-ear correction instead.
 */
export function shiftDeckByBeat(deckId: DeckId, direction: 1 | -1) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const { decks, masterDeckId, setNotice } = useStore.getState()
  const st = decks[deckId]

  if (masterDeckId === deckId) {
    setNotice({
      text: `Deck ${deckId} is the master — shift the other deck instead.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  const grid = st.beatGrid
  if (!grid) {
    setNotice({
      text: `Deck ${deckId} has no beat grid yet — nothing to shift.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  if (st.loopActive) {
    setNotice({
      text: `Deck ${deckId} has an active loop — turn it off before shifting the beat.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  cancelTransitionIfEitherDeckTouched(deckId)
  const beatSec = 60 / grid.bpm
  seekDeck(deckId, deck.position + direction * beatSec)
}

/**
 * Touching the tempo fader breaks an active phase-lock (v0.3.0) — matches
 * real hardware, where grabbing the fader is how a DJ takes tempo back from
 * SYNC. `syncDeck`/`setMasterDeck` call this to *set* the matched tempo and
 * then set `syncActive: true` themselves right after, so that path is not
 * affected — only a caller that patches `tempo` alone, i.e. a manual touch.
 */
export function setTempo(deckId: DeckId, tempo: number, opts: { persist?: boolean } = {}) {
  // Safe against this same function's own internal callers (syncDeck /
  // setMasterDeck, re-matching the *incoming* or *outgoing* deck's tempo):
  // during an active transition those only ever target `toDeckId`, and by
  // the time `finishTransition` re-matches `fromDeckId` through
  // `setMasterDeck`, `activeTransition` is already cleared — so this only
  // ever fires for a genuine manual touch of the tempo fader.
  cancelTransitionIfOutgoingDeckTouched(deckId)
  const t = Math.max(-1, Math.min(1, tempo))
  engine.decks[deckId].setTempo(t)
  useStore.getState().patchDeck(deckId, { tempo: t, syncActive: false })
  if (useStore.getState().masterDeckId === deckId) refreshFxTimeForMasterTempo()
  // A tempo SYNC derived from whichever deck was master is that pairing's
  // number, not this track's — remembering it made the track come back later at
  // an unrelated offset. Only a hand-set fader value is worth keeping.
  if (opts.persist !== false) schedulePersistTempo(deckId)
}

const persistTempoTimers: Record<DeckId, number> = { A: 0, B: 0 }
/** Debounced like `schedulePersistSamplerBank` — a fader drag calls `setTempo` many times a second, and a write per tick would hammer IndexedDB for no benefit over the value it settles on. */
function schedulePersistTempo(deckId: DeckId) {
  window.clearTimeout(persistTempoTimers[deckId])
  persistTempoTimers[deckId] = window.setTimeout(() => void persistTempoForDeck(deckId), 400)
}

async function persistTempoForDeck(deckId: DeckId): Promise<void> {
  const { decks, setNotice } = useStore.getState()
  const deck = decks[deckId]
  const hash = deck.track?.contentHash
  if (!hash) return // not yet identified (fresh scan, or hashing failed) — nothing to key the write on
  try {
    await putTempo(hash, deck.tempo)
  } catch (err) {
    setNotice({
      text: `Tempo for "${deck.track?.title ?? deck.track?.name}" wasn't saved: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'load',
    })
  }
}

/**
 * Re-applies both racks' stored beat-time so a beat-synced Delay/Echo/Filter
 * follows the master deck's tempo instead of staying locked to the BPM it
 * happened to compute at when the time was last set — the product decision
 * recorded in `workshop-output/FEATURE_SPEC.md`. Originally wired only to
 * `setTempo` touching the current master deck, named here as a known gap
 * (HANDOFF.md): SYNC engaging on the very first press (no master existed
 * yet to read a BPM from) and the master deck being reassigned
 * (`setMasterDeck`) both change what `masterPlayingBpm()` returns just as
 * much as the tempo fader does, and neither called this. v0.8.6 wires both
 * — as an added call at the point each already changes `masterDeckId`, not
 * a change to the SYNC/transition logic itself, which is what the original
 * "risks regression" note was about.
 */
function refreshFxTimeForMasterTempo() {
  const { fx } = useStore.getState()
  const bpm = masterPlayingBpm()
  fx.forEach((rack, i) => engine.fx[i as 0 | 1].setTime(rack.time, bpm))
}

export function setHotCue(deckId: DeckId, index: number) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const { patchDeck, decks } = useStore.getState()
  const cues = decks[deckId].hotCues
  const existing = cues.find((c) => c.index === index)
  if (existing) {
    deck.seek(existing.positionSec)
    patchDeck(deckId, { positionSec: existing.positionSec })
  } else {
    const next = [
      ...cues,
      {
        index,
        positionSec: quantizeIfOn(deckId, deck.position),
        label: `${index + 1}`,
        color: HOT_CUE_COLORS[index % HOT_CUE_COLORS.length],
        createdAt: Date.now(),
      },
    ].sort((a, b) => a.index - b.index)
    patchDeck(deckId, { hotCues: next })
    persistCues(deckId)
  }
}

/**
 * The choke-point entry point for pressing a hot cue pad — UI (`PadGrid.tsx`)
 * and the FLX4's physical pads (`transport-webmidi/manager.ts:dispatch`,
 * `'hotcue'` case) both call this instead of `setHotCue` directly (v0.4.7,
 * fallback fixed v0.4.9).
 *
 * A pad saved by `saveMixEntryHotCue` carries `kind: 'mixEntry'` — pressing it
 * re-runs the *same* automatic transition a first click in
 * `TransitionPointsPanel` would have started, phase-aligned entry and all,
 * instead of just parking the playhead there for the DJ to hit Play by hand
 * (the exact gap the owner asked to close: "I'll give the command, you land
 * it on the right beat"). But only when a transition actually makes sense
 * right now (`shouldTriggerMixEntry`, `core/hotcues.ts`) — this deck isn't
 * already playing, and the other deck is. Outside that window a mix-in pad
 * must never become a dead button that's *worse* than a plain one, so it
 * falls through to the ordinary `setHotCue` seek instead, exactly like every
 * other pad. Once the window check passes, `startAutoTransition`'s own
 * further refusals (no beat grid, a transition already running) still apply
 * and still show their own notice — this only guards the cases where
 * attempting a transition was never the right call in the first place.
 *
 * Every other pad — a plain numbered one, or one manually renamed
 * (`renameHotCue`, v0.5.3) without ever going through `saveMixEntryHotCue` —
 * keeps doing exactly what `setHotCue` always did: jump-or-create. `kind` is
 * what draws that line now, not the label (`core/types.ts`'s own doc comment
 * on `HotCue.kind` says why a label-based check stopped being enough).
 */
export function pressHotCue(deckId: DeckId, index: number) {
  const { decks } = useStore.getState()
  const cue = decks[deckId].hotCues.find((c) => c.index === index)
  const otherDeckId: DeckId = deckId === 'A' ? 'B' : 'A'
  if (shouldTriggerMixEntry(cue, decks[deckId].playing, decks[otherDeckId].playing)) {
    startAutoTransition(otherDeckId, deckId, cue!.positionSec)
    return
  }
  setHotCue(deckId, index)
}

export function deleteHotCue(deckId: DeckId, index: number) {
  const { patchDeck, decks } = useStore.getState()
  patchDeck(deckId, {
    hotCues: decks[deckId].hotCues.filter((c) => c.index !== index),
  })
  persistCues(deckId)
}

/**
 * Drag a hot cue pad onto another pad — relocate onto an empty one, swap with
 * an occupied one (v0.4.0, `PadGrid.tsx`). Pure logic lives in
 * `core/hotcues.ts`; this is the choke-point wrapper that patches the store
 * and persists, same shape as `setHotCue`/`deleteHotCue`.
 */
export function moveHotCue(deckId: DeckId, fromIndex: number, toIndex: number) {
  const { patchDeck, decks } = useStore.getState()
  const cues = decks[deckId].hotCues
  const next = moveHotCuePure(cues, fromIndex, toIndex)
  if (next === cues) return
  patchDeck(deckId, { hotCues: next })
  persistCues(deckId)
}

/**
 * Auto-save a chosen mix-in point as a hot cue (v0.4.7) — called alongside
 * `startAutoTransition` when the DJ picks a point in `TransitionPointsPanel`,
 * never on its own. Uses the first empty pad, or evicts the pad with the
 * oldest `createdAt` when all 8 are full (`pickHotCueSlot`, `core/hotcues.ts`)
 * — always a visible overwrite in the Pad Grid, never a silent one.
 */
export function saveMixEntryHotCue(deckId: DeckId, positionSec: number, label: string) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const { patchDeck, decks } = useStore.getState()
  const cues = decks[deckId].hotCues
  const index = pickHotCueSlot(cues)
  const next = [
    ...cues.filter((c) => c.index !== index),
    {
      index,
      positionSec,
      label,
      color: HOT_CUE_COLORS[index % HOT_CUE_COLORS.length],
      createdAt: Date.now(),
      kind: 'mixEntry' as const,
    },
  ].sort((a, b) => a.index - b.index)
  patchDeck(deckId, { hotCues: next })
  persistCues(deckId)
}

/**
 * Manual rename (v0.5.3, `PadGrid.tsx`'s Alt-click): the label is whatever
 * `PadGrid.tsx` already composed (custom text plus the cue's own position,
 * same "caller formats, this just stores" split `saveMixEntryHotCue` above
 * already uses). `kind` is deliberately left untouched either way — renaming
 * a mix-entry pad doesn't turn it into a plain one, and renaming a plain pad
 * doesn't turn it into a mix-entry trigger; only `saveMixEntryHotCue` ever
 * sets that.
 */
export function renameHotCue(deckId: DeckId, index: number, label: string) {
  const { patchDeck, decks } = useStore.getState()
  const cues = decks[deckId].hotCues
  if (!cues.some((c) => c.index === index)) return
  patchDeck(deckId, { hotCues: cues.map((c) => (c.index === index ? { ...c, label } : c)) })
  persistCues(deckId)
}

export function toggleLoop(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const { patchDeck, decks } = useStore.getState()
  const st = decks[deckId]
  if (st.loopActive) {
    deck.clearLoop()
    patchDeck(deckId, { loopActive: false })
  } else {
    const bpm = st.bpm ?? 120
    const beatSec = 60 / bpm
    const start = quantizeIfOn(deckId, deck.position)
    deck.setLoop(start, start + beatSec * st.loopBeats)
    patchDeck(deckId, { loopActive: true })
  }
}

export function setLoopBeats(deckId: DeckId, beats: number) {
  const b = Math.max(0.25, Math.min(32, beats))
  const { patchDeck, decks } = useStore.getState()
  const st = decks[deckId]
  patchDeck(deckId, { loopBeats: b })
  if (st.loopActive && st.bpm) {
    const deck = engine.decks[deckId]
    const beatSec = 60 / st.bpm
    const start = deck.loopStart ?? deck.position
    deck.setLoop(start, start + beatSec * b)
  }
}

// ————————————————————————————————————————————————————————————————
// Pad modes (v0.5.0) — the pad grid does more than hot cues. `padMode` is
// per-deck (`DeckState`); `shiftHeld` is global — the FLX4 has one physical
// SHIFT button for the whole controller, not one per side. `pressPad` is
// the one choke-point entry both the UI (`PadGrid.tsx`) and MIDI
// (`transport-webmidi/manager.ts`'s `dispatch`) call — it interprets the
// same 8 physical pads differently depending on `decks[deckId].padMode`,
// the same way `pressHotCue` already interprets a plain vs. mix-entry cue.
// It always returns a release closure (a no-op outside Loop Roll) so
// callers never need to know which pad presses are hold gestures.
// ————————————————————————————————————————————————————————————————

/** Loop Roll in progress per deck — transient, not store state (same reasoning as `activeTransition`): nothing here is serializable or needs to trigger a render on its own. */
const loopRollByDeck: Partial<Record<DeckId, { entrySec: number; startedAtSec: number }>> = {}

/** Release an in-progress Loop Roll on this deck, if any — the track "catches up" to where it would be had it never looped. A safe no-op when there is none, so `setPadMode` and a plain pad release can both call it unconditionally. */
function releaseLoopRoll(deckId: DeckId) {
  const roll = loopRollByDeck[deckId]
  if (!roll) return
  delete loopRollByDeck[deckId]
  const deck = engine.decks[deckId]
  const tempo = useStore.getState().decks[deckId].tempo
  const rate = tempoToRate(tempo, settings.values.tempoRange)
  const elapsedSec = (engine.currentTime - roll.startedAtSec) * rate
  const target = loopRollReturnSec(roll.entrySec, elapsedSec, deck.duration)
  deck.clearLoop()
  deck.seek(target)
  useStore.getState().patchDeck(deckId, { positionSec: target })
}

/**
 * Switch a deck's pad-grid mode. A loop left running under Loop mode is
 * stopped, with a visible notice, before leaving it — a loop that keeps
 * playing behind a grid that no longer shows it is exactly the "changed
 * without being surfaced" failure CLAUDE.md's central rule forbids. An
 * in-progress Loop Roll is released the same way a normal release would.
 */
export function setPadMode(deckId: DeckId, mode: PadMode) {
  const { decks, patchDeck, setNotice } = useStore.getState()
  const st = decks[deckId]
  // Re-selecting the mode that's already active is a no-op — in particular,
  // it must never cut a Loop Roll short. A duplicate press can genuinely
  // arrive this way (a bouncing MIDI note, a stray click on the already-
  // active tab), and `releaseLoopRoll` below would otherwise fire on every
  // one of them even though the deck never actually left Loop mode.
  if (st.padMode === mode) return
  releaseLoopRoll(deckId)
  if (st.padMode === 'loop' && mode !== 'loop' && st.loopActive) {
    engine.decks[deckId].clearLoop()
    patchDeck(deckId, { loopActive: false })
    setNotice({
      text: `Loop stopped on deck ${deckId} — switched away from Loop mode.`,
      tone: 'warn',
      source: 'padMode',
    })
  }
  patchDeck(deckId, { padMode: mode })
}

/** The global SHIFT layer for pad presses — held down changes what a pad does (see `pressPad`). */
export function setShiftHeld(down: boolean) {
  useStore.setState({ shiftHeld: down })
}

/** Loop mode, no SHIFT: start/stop a plain loop at this pad's beat length — same mechanics as `toggleLoop`, a fixed length per pad instead of the current stepper value. */
function pressLoopPad(deckId: DeckId, beats: number) {
  const deck = engine.decks[deckId]
  const { patchDeck, decks } = useStore.getState()
  const st = decks[deckId]
  if (st.loopActive && st.loopBeats === beats) {
    deck.clearLoop()
    patchDeck(deckId, { loopActive: false })
    return
  }
  const bpm = st.bpm ?? 120
  const start = quantizeIfOn(deckId, deck.position)
  deck.setLoop(start, start + (60 / bpm) * beats)
  patchDeck(deckId, { loopActive: true, loopBeats: beats })
}

/** Loop mode, SHIFT+press: Loop Roll — loops while held, catches up to the natural position on release. Returns the release closure. */
function pressLoopRollPad(deckId: DeckId, beats: number): () => void {
  const deck = engine.decks[deckId]
  const bpm = useStore.getState().decks[deckId].bpm ?? 120
  const entrySec = quantizeIfOn(deckId, deck.position)
  loopRollByDeck[deckId] = { entrySec, startedAtSec: engine.currentTime }
  deck.setLoop(entrySec, entrySec + (60 / bpm) * beats)
  return () => releaseLoopRoll(deckId)
}

/** Beat Jump mode: jump forward, or backward with SHIFT, by this pad's beat distance. Refuses (with a notice, not a silent no-op) when there's no tempo to jump by — same shape as `syncDeck`'s "no tempo yet" guard. */
function pressBeatJumpPad(deckId: DeckId, beats: number, backward: boolean) {
  const deck = engine.decks[deckId]
  const { decks, setNotice, patchDeck } = useStore.getState()
  const st = decks[deckId]
  if (!st.bpm) {
    setNotice({
      text: `Deck ${deckId} has no tempo yet — Beat Jump needs one.`,
      tone: 'warn',
      source: 'padMode',
    })
    return
  }
  const target = beatJumpTargetSec(deck.position, st.bpm, beats, backward ? -1 : 1, deck.duration)
  deck.seek(target)
  patchDeck(deckId, { positionSec: target })
}

/**
 * The choke-point entry for every pad press, regardless of source — the
 * UI's `onMouseDown`/`onClick` and the FLX4's physical pads via
 * `manager.ts`'s `dispatch` both call this instead of a mode-specific
 * function directly. Always returns a release closure (a no-op for every
 * mode except Loop mode's SHIFT+press) so callers never need to know in
 * advance which pad presses are hold gestures and which are plain clicks.
 */
export function pressPad(deckId: DeckId, index: number): () => void {
  const { decks, shiftHeld } = useStore.getState()
  const mode = decks[deckId].padMode
  // Sampler is the one mode not gated on this deck holding a track — it
  // reaches the global bank (`core/sampler.ts`), not this deck's own player.
  if (mode === 'sampler') return pressSamplerPad(index + (shiftHeld ? 8 : 0))
  if (!engine.decks[deckId].hasTrack) return () => {}
  const beats = LOOP_BEATS_STEPS[index] ?? 1
  switch (mode) {
    case 'hotcue':
      pressHotCue(deckId, index)
      return () => {}
    case 'loop':
      if (shiftHeld) return pressLoopRollPad(deckId, beats)
      pressLoopPad(deckId, beats)
      return () => {}
    case 'beatJump':
      pressBeatJumpPad(deckId, beats, shiftHeld)
      return () => {}
    default:
      return () => {}
  }
}

// ————————————————————————————————————————————————————————————————
// Sampler bank (v0.6.0) — one global 16-slot bank, reached from either
// deck's pad grid in Sampler mode (`pressPad` above resolves the physical
// pad + SHIFT into an absolute slot index and calls `pressSamplerPad`).
// Loading is drag-and-drop from the library (`PadGrid.tsx`, same
// `application/x-soundgrid-track` payload `Deck.tsx`'s own drop zone
// reads) — recording a slot from the master bus is ROADMAP.md's other
// v0.6.0 load path and is deliberately not built here; see HANDOFF.md.
// ————————————————————————————————————————————————————————————————

let persistBankTimer = 0
/** Debounced — a gain knob drag fires many times a second, and a write per tick would hammer IndexedDB for no benefit over the value it settles on. */
function schedulePersistSamplerBank() {
  window.clearTimeout(persistBankTimer)
  persistBankTimer = window.setTimeout(() => void persistSamplerBank(), 400)
}

async function persistSamplerBank(): Promise<void> {
  const { sampler, setNotice } = useStore.getState()
  const bank: StoredSamplerBank = sampler.slots.map((s) =>
    s.contentHash || s.recordingId
      ? {
          contentHash: s.contentHash,
          recordingId: s.recordingId,
          trackName: s.trackName ?? '',
          bpm: s.bpm,
          mode: s.mode,
          gain: s.gain,
          syncEnabled: s.syncEnabled,
        }
      : null,
  )
  try {
    await saveSamplerBank(bank)
  } catch (err) {
    console.error('sampler bank save failed', err)
    setNotice({
      text: `Sampler bank didn't save — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'sampler',
    })
  }
}

// `initAudio()` only runs on the first user gesture (loading a deck,
// pressing a pad, the output picker) — but the library's own boot-time
// folder restore (`Library.tsx`) runs unattended, no gesture needed, and
// used to call `resolveSamplerSlots` before this had ever run. Every saved
// slot still had no `contentHash` to match against, so the whole bank came
// back silently empty on a plain page reload: no error, no notice, exactly
// the silent skip this project forbids. Guarded here (not at each call
// site) so `resolveSamplerSlots` can simply require it finished, from
// *either* trigger, without caring which one got there first.
let samplerBankMetaRestored: Promise<void> | null = null

/** Boot-time restore, metadata only (v0.6.0) — sets every saved slot's name/mode/gain/sync/bpm immediately so the bank looks right before the library has even scanned. The actual audio for each slot is loaded separately by `resolveSamplerSlots`, once tracks exist to match against. Idempotent: safe to call from both `initAudio()` and `resolveSamplerSlots()` — the second call is a no-op. */
export function restoreSamplerBankMeta(): Promise<void> {
  if (!samplerBankMetaRestored) {
    samplerBankMetaRestored = (async () => {
      const bank = await getSamplerBank()
      if (!bank.length) return
      const { patchSamplerSlot } = useStore.getState()
      bank.forEach((s, i) => {
        if (!s) return
        patchSamplerSlot(i, {
          trackName: s.trackName,
          contentHash: s.contentHash,
          recordingId: s.recordingId,
          bpm: s.bpm,
          mode: s.mode,
          gain: s.gain,
          syncEnabled: s.syncEnabled,
        })
        engine.sampler.setGain(i, s.gain)
      })
    })()
  }
  return samplerBankMetaRestored
}

/**
 * Re-resolves every saved-but-not-yet-loaded slot (`contentHash` set,
 * `trackId` still null) against the tracks currently on screen. Called
 * repeatedly during a scan (`Library.tsx`) as more tracks get an identity —
 * right after the synchronous scan, again on every analysis patch that
 * carries a fresh `contentHash`, and once more after the whole tag+analysis
 * pass settles — the same "post-scan enrichment pass" shape
 * `applyGenreOverrides` already uses, just repeated instead of one-shot.
 *
 * `silent` exists because most of those calls happen *before* the library
 * has finished getting identities: a slot with no match yet almost always
 * just means its track hasn't been hashed by the analysis queue yet, not
 * that it is genuinely missing. Reporting "couldn't be matched" on every
 * early call would flash a scary, wrong warning on every real scan (found
 * live: the exact "couldn't be matched" notice fired the instant a saved
 * bank existed, self-corrected a few seconds later, and read exactly like
 * the bug this function exists to fix). A slot that stays unresolved is
 * still always named in a notice — from the one call each scan makes with
 * `silent: false`, once every track that could get an identity has one.
 */
export async function resolveSamplerSlots(opts: { silent?: boolean } = {}): Promise<void> {
  // Metadata (`contentHash`/`recordingId` per slot) has to be in the store
  // before this can match anything — see `restoreSamplerBankMeta`'s doc
  // comment. A no-op once it has already run, from here or from `initAudio()`.
  await restoreSamplerBankMeta()
  const { sampler, library, setNotice } = useStore.getState()
  let unresolved = 0
  let recordingFailed = 0
  for (let i = 0; i < sampler.slots.length; i++) {
    const slot = sampler.slots[i]
    if (slot.trackId || engine.sampler.hasBuffer(i)) continue
    // A recorded slot (v0.7.5) resolves from its own stored blob, not from
    // the library scan this function otherwise exists for — it has no
    // `contentHash` to match against, and doesn't need one.
    if (slot.recordingId) {
      if (!(await loadSamplerSlotRecording(i, slot.recordingId))) recordingFailed++
      continue
    }
    if (!slot.contentHash) continue
    const track = library.tracks.find((t) => t.contentHash === slot.contentHash)
    if (!track) {
      unresolved++
      continue
    }
    await loadSamplerSlotAudio(i, track, { keepSavedSettings: true })
  }
  if (!opts.silent && (unresolved > 0 || recordingFailed > 0)) {
    const parts: string[] = []
    if (unresolved > 0) {
      parts.push(
        `${unresolved} sampler slot${unresolved === 1 ? '' : 's'} from your saved bank couldn't be matched to a file in this library — they'll fill in once the right folder is scanned.`,
      )
    }
    if (recordingFailed > 0) {
      parts.push(
        `${recordingFailed} sampler recording${recordingFailed === 1 ? '' : 's'} couldn't be loaded — the saved audio is missing or unreadable.`,
      )
    }
    setNotice({ text: parts.join(' '), tone: 'warn', source: 'sampler' })
  }
}

/**
 * Resolves a live-recorded slot (v0.7.5) from its stored WAV blob —
 * independent of library scanning, unlike `loadSamplerSlotAudio`'s
 * `contentHash`-matched path. Returns `false` rather than throwing on a
 * missing/corrupt blob so the caller can count and name the failure,
 * per this project's central rule.
 */
async function loadSamplerSlotRecording(index: number, recordingId: string): Promise<boolean> {
  await initAudio()
  const blob = await getRecordingBlob(recordingId)
  if (!blob) return false
  try {
    const data = await blob.arrayBuffer()
    const buffer = await engine.decode(data)
    engine.sampler.loadSlot(index, buffer)
    engine.sampler.setGain(index, useStore.getState().sampler.slots[index].gain)
    return true
  } catch (err) {
    console.error('sampler recording decode failed', err)
    return false
  }
}

/** Decode + load one slot's audio, shared by a fresh drag-drop load and a saved-bank resolve. `keepSavedSettings` is only true from `resolveSamplerSlots`: the saved mode/gain/sync/bpm are already on the slot from `restoreSamplerBankMeta` and must not be clobbered by the freshly re-scanned track's own tag values. */
async function loadSamplerSlotAudio(
  index: number,
  track: Track,
  opts: { keepSavedSettings: boolean } = { keepSavedSettings: false },
): Promise<void> {
  await initAudio()
  const { patchSamplerSlot, setNotice, clearNotice } = useStore.getState()
  clearNotice('sampler')
  // Dropping a library track onto a slot that held a live recording (v0.7.5)
  // replaces it — the old blob is now unreachable from any slot, so it's
  // deleted rather than left as an orphan in IndexedDB.
  const previousRecordingId = useStore.getState().sampler.slots[index].recordingId
  if (previousRecordingId) void deleteRecordingBlob(previousRecordingId)
  let buffer: AudioBuffer
  let contentHash: string | undefined
  try {
    const data = await readTrackData(track)
    // Hashed before decode — `decodeAudioData` neuters its input buffer per
    // spec, same ordering `loadTrackToDeck` uses and for the same reason.
    try {
      contentHash = await hashBytes(data)
    } catch (hashErr) {
      console.error('sampler slot hash failed', hashErr)
    }
    buffer = await engine.decode(data)
  } catch (err) {
    console.error('sampler slot load failed', err)
    setNotice({
      text: `"${track.name}" didn't load into sampler slot ${index + 1} — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'sampler',
    })
    return
  }
  engine.sampler.loadSlot(index, buffer)
  // A fresh `GainNode` defaults to 1.0, not this slot's own fader value —
  // without this, a brand-new drag-and-drop load plays at full volume while
  // the on-screen knob still reads its actual (often lower) value, until the
  // owner happens to nudge it once. Re-applying the slot's current gain
  // (whatever it already was — `clearSamplerSlot` deliberately preserves it
  // across a reload) is what keeps the engine and the store in agreement.
  engine.sampler.setGain(index, useStore.getState().sampler.slots[index].gain)
  patchSamplerSlot(index, {
    trackId: track.id,
    contentHash,
    recordingId: undefined,
    // A resolve-from-saved-bank must not clobber the name — `restoreSamplerBankMeta`
    // already put the saved (possibly renamed) `trackName` on this slot, and
    // overwriting it here with the track's own title would silently undo a
    // rename on every reload. A genuinely fresh drag-and-drop load has no
    // saved name to protect, so it takes the track's own title as before.
    ...(opts.keepSavedSettings ? {} : { trackName: track.title ?? track.name, bpm: track.bpm ?? undefined }),
    playing: false,
  })
  if (!opts.keepSavedSettings) schedulePersistSamplerBank()
}

/** Drag a library track onto a sampler pad — the only load path this version builds (see the section banner above). Replaces whatever was in the slot, same as dropping a track onto a deck. */
export async function loadSamplerSlot(index: number, track: Track): Promise<void> {
  await loadSamplerSlotAudio(index, track)
}

/**
 * Alt+click rename (`PadGrid.tsx`'s `SamplerPads`, same gesture
 * `renameHotCue` already uses) — the owner's own request. Unlike a hot cue,
 * a sample carries no position to re-append, so a blank save just falls
 * back to the loaded track's own title rather than leaving the pad unlabeled.
 */
export function renameSamplerSlot(index: number, name: string) {
  const { sampler, library, patchSamplerSlot } = useStore.getState()
  const slot = sampler.slots[index]
  if (!isSamplerSlotOccupied(slot)) return
  const trimmed = name.trim()
  const track = library.tracks.find((t) => t.id === slot.trackId)
  const fallback = (track && (track.title ?? track.name)) || slot.trackName || `Slot ${index + 1}`
  patchSamplerSlot(index, { trackName: trimmed || fallback })
  schedulePersistSamplerBank()
}

/** Empties a slot. The slot's own gain/mode/sync survive — a fader position on real gear doesn't reset when you eject the sample. A recorded slot's blob is deleted from IndexedDB too (v0.7.5) — otherwise it just sits there forever, an orphan nothing ever points to again. */
export function clearSamplerSlot(index: number) {
  engine.sampler.unloadSlot(index)
  const slot = useStore.getState().sampler.slots[index]
  if (slot.recordingId) void deleteRecordingBlob(slot.recordingId)
  useStore.getState().patchSamplerSlot(index, {
    trackId: null,
    trackName: null,
    contentHash: undefined,
    recordingId: undefined,
    bpm: undefined,
    playing: false,
  })
  schedulePersistSamplerBank()
}

/**
 * Live-record a free slot from the master bus (v0.7.5) — a second load path
 * alongside drag-and-drop, sharing the same `masterPostFx` tap the master
 * recording uses. Keyed by slot index so several slots (and a master
 * recording) can capture at once, each with its own tap and no shared state.
 */
const samplerCaptures = new Map<number, { tap: RecorderTap; chunks: Float32Array[][]; sampleRate: number }>()

/** No-op on an occupied slot or one already capturing — the spec's "never overwrite, empty slots only" rule, enforced here rather than trusted to the UI that calls it. */
export async function startSamplerCapture(index: number): Promise<void> {
  const slot = useStore.getState().sampler.slots[index]
  if (isSamplerSlotOccupied(slot) || samplerCaptures.has(index)) return
  await initAudio()
  const sampleRate = engine.ctx.sampleRate
  const tap = await engine.createMasterTap()
  const chunks: Float32Array[][] = []
  let frames = 0
  tap.onChunk = (chunk) => {
    chunks.push(chunk.channels)
    frames += chunk.frameCount
    // Same named-not-crashed cap as the master recording — a forgotten
    // "Stop" must not quietly turn a pad into an unbounded in-memory
    // buffer (found missing here, though present for master recording, in
    // change-reviewer's pass on this version).
    const bytesRecorded = frames * 2 * 2
    if (estimateSecondsRemaining(bytesRecorded, SAMPLER_CAPTURE_MAX_SEC, sampleRate, 2) <= 0) {
      void stopSamplerCapture(index)
      useStore.getState().setNotice({
        text: `Recording on sampler slot ${index + 1} stopped automatically after reaching the ${Math.round(SAMPLER_CAPTURE_MAX_SEC / 60)}-minute limit.`,
        tone: 'warn',
        source: 'sampler',
      })
    }
  }
  samplerCaptures.set(index, { tap, chunks, sampleRate })
  useStore.getState().patchSampler({ armedSlot: index })
}

/**
 * Stops the capture, loads it into the engine immediately (playable within
 * the same set, per spec), and persists the bytes so it survives a reload —
 * `sampler-idb/store.ts`'s existing bank only ever stored a `contentHash`,
 * which a live recording doesn't have.
 */
export async function stopSamplerCapture(index: number): Promise<void> {
  const capture = samplerCaptures.get(index)
  if (!capture) return
  samplerCaptures.delete(index)
  useStore.getState().patchSampler({ armedSlot: null })
  await capture.tap.stop()

  const totalFrames = capture.chunks.reduce((sum, chs) => sum + (chs[0]?.length ?? 0), 0)
  if (totalFrames === 0) return // nothing captured — leave the slot empty, not a zero-length "recording"

  const channels = mergeChunks(capture.chunks)
  const buffer = engine.sampler.buildBuffer(channels, capture.sampleRate)
  engine.sampler.loadSlot(index, buffer)
  engine.sampler.setGain(index, useStore.getState().sampler.slots[index].gain)

  const recordingId = crypto.randomUUID()
  const wavBytes = encodeWav(channels, capture.sampleRate)
  try {
    // Same generic-vs-SharedArrayBuffer strictness gap as
    // `recorder-fsaccess/writer.ts` — `core/wav.ts` always backs this with a
    // plain `ArrayBuffer`, so the cast is safe.
    await saveRecordingBlob(recordingId, new Blob([wavBytes as unknown as BlobPart], { type: 'audio/wav' }))
  } catch (err) {
    // The recording still plays for the rest of this session (already
    // loaded into the engine above) — only persistence failed, so this
    // degrades visibly rather than losing the take outright.
    console.error('sampler recording save failed', err)
    useStore.getState().setNotice({
      text: `Recording on sampler slot ${index + 1} will disappear on reload — it couldn't be saved (${err instanceof Error ? err.message : String(err)}).`,
      tone: 'warn',
      source: 'sampler',
    })
  }

  const existingRecordings = useStore.getState().sampler.slots.filter((s) => s.recordingId).length
  useStore.getState().patchSamplerSlot(index, {
    trackId: null,
    contentHash: undefined,
    recordingId,
    trackName: `Recording ${existingRecordings + 1}`,
    bpm: undefined,
    playing: false,
  })
  // Not the debounced scheduler used elsewhere for rapid UI drags (gain,
  // mode) — a fresh recording is a rare, deliberate, high-value event, and
  // the audio blob above is already durably saved. Persisting the bank
  // metadata immediately, not 400ms later, is what keeps "which slot points
  // to this blob" from being lost if the tab closes right after stopping.
  await persistSamplerBank()
}

export function setSamplerSlotMode(index: number, mode: SamplerMode) {
  const { sampler, patchSamplerSlot, setNotice } = useStore.getState()
  const slot = sampler.slots[index]
  if (slot.mode === mode) return
  // Leaving Loop while it's playing must stop it audibly and say so — the
  // same rule `setPadMode` already applies when a deck leaves Loop mode
  // with a loop running: a mode switch that keeps sounding behind a grid
  // that no longer shows it is exactly the silent-skip this project forbids.
  if (slot.mode === 'loop' && slot.playing) {
    engine.sampler.stopVoice(index)
    setNotice({
      text: `Sampler slot ${index + 1} stopped — switched away from Loop.`,
      tone: 'warn',
      source: 'sampler',
    })
    patchSamplerSlot(index, { mode, playing: false })
  } else {
    patchSamplerSlot(index, { mode })
  }
  schedulePersistSamplerBank()
}

export function setSamplerGain(index: number, v: number) {
  engine.sampler.setGain(index, v)
  useStore.getState().patchSamplerSlot(index, { gain: v })
  schedulePersistSamplerBank()
}

/**
 * Toggling Sync must reach whatever is already sounding, not just the next
 * press — turning it off mid-playback and leaving the voice at its last
 * synced rate would directly contradict `samplerSyncRate`'s own contract
 * ("a slot that cannot compute a real ratio plays at its own natural
 * speed"), and turning it on would otherwise only take effect on the next
 * trigger.
 */
export function setSamplerSyncEnabled(index: number, on: boolean) {
  const { sampler, decks, masterDeckId, patchSamplerSlot } = useStore.getState()
  const slot = sampler.slots[index]
  patchSamplerSlot(index, { syncEnabled: on })
  if (slot.playing) {
    const master = masterDeckId ? decks[masterDeckId] : null
    const masterBpm = master?.bpm ? master.bpm * tempoToRate(master.tempo, cfg.tempoRange) : null
    engine.sampler.setRate(index, samplerSyncRate(masterBpm, slot.bpm, on))
    if (on && slot.mode === 'loop') ensureSyncLoop()
  }
  schedulePersistSamplerBank()
}

/**
 * The choke-point for every sampler pad press, `index` already resolved to
 * an absolute 0-15 slot by `pressPad`. Always returns a release closure —
 * a no-op for One-shot/Loop, and Gated's actual stop — same shape as
 * `pressPad`'s own contract for Loop Roll.
 */
function pressSamplerPad(index: number): () => void {
  const { sampler, decks, masterDeckId, setNotice } = useStore.getState()
  const slot = sampler.slots[index]
  // Occupancy (`trackId` OR `recordingId`, v0.7.5) and the engine actually
  // holding a buffer for this index are set together, in
  // `loadSamplerSlotAudio`/`stopSamplerCapture`, and nowhere else — but
  // trusting that invariant here rather than checking it would let the pad
  // light up "playing" while producing no sound if it were ever violated,
  // exactly the visible-state-doesn't-match-reality failure this project's
  // central rule forbids.
  if (!isSamplerSlotOccupied(slot) || !engine.sampler.hasBuffer(index)) {
    setNotice({
      text: `Sampler slot ${index + 1} is empty — drag a track from the library onto it.`,
      tone: 'info',
      source: 'sampler',
    })
    return () => {}
  }
  const master = masterDeckId ? decks[masterDeckId] : null
  const masterBpm = master?.bpm ? master.bpm * tempoToRate(master.tempo, cfg.tempoRange) : null
  const rate = samplerSyncRate(masterBpm, slot.bpm, slot.syncEnabled)

  switch (slot.mode) {
    case 'oneShot':
      engine.sampler.trigger(index, false, rate)
      useStore.getState().patchSamplerSlot(index, { playing: true })
      return () => {}
    case 'loop':
      if (slot.playing) {
        engine.sampler.stopVoice(index)
        useStore.getState().patchSamplerSlot(index, { playing: false })
      } else {
        engine.sampler.trigger(index, true, rate)
        useStore.getState().patchSamplerSlot(index, { playing: true })
        if (slot.syncEnabled) ensureSyncLoop()
      }
      return () => {}
    case 'gated':
      engine.sampler.trigger(index, false, rate)
      useStore.getState().patchSamplerSlot(index, { playing: true })
      return () => {
        engine.sampler.stopVoice(index)
        useStore.getState().patchSamplerSlot(index, { playing: false })
      }
    default:
      return () => {}
  }
}

export function setSamplerChannelVolume(v: number) {
  engine.setSamplerVolume(v)
  useStore.getState().patchSamplerChannel({ volume: v })
}

export function toggleSamplerCueMonitor() {
  const on = !useStore.getState().sampler.channel.cueMonitor
  engine.setSamplerCueMonitor(on)
  useStore.getState().patchSamplerChannel({ cueMonitor: on })
}

/** The master deck's *playing* BPM (track BPM adjusted by its tempo fader), same computation `setSamplerSyncEnabled` uses — the app-wide reference tempo for anything beat-synced, FX included. */
function masterPlayingBpm(): number | null {
  const { decks, masterDeckId } = useStore.getState()
  const master = masterDeckId ? decks[masterDeckId] : null
  return master?.bpm ? master.bpm * tempoToRate(master.tempo, cfg.tempoRange) : null
}

export function setFxEffect(rack: 0 | 1, effect: number) {
  // A refused switch (Reverb unavailable) must not be recorded as selected
  // — the store would then claim an effect that isn't actually playing.
  if (engine.fx[rack].setEffect(effect)) {
    useStore.getState().patchFx(rack, { effect })
    schedulePersistFxBank()
  }
}

export function setFxWetDry(rack: 0 | 1, v: number) {
  engine.fx[rack].setWetDry(v)
  useStore.getState().patchFx(rack, { wetDry: v })
  schedulePersistFxBank()
}

export function setFxTime(rack: 0 | 1, fraction: number) {
  engine.fx[rack].setTime(fraction, masterPlayingBpm())
  useStore.getState().patchFx(rack, { time: fraction })
  schedulePersistFxBank()
}

export function toggleFxOn(rack: 0 | 1) {
  const on = !useStore.getState().fx[rack].on
  engine.fx[rack].setOn(on)
  useStore.getState().patchFx(rack, { on })
  schedulePersistFxBank()
}

export function setFxRoute(rack: 0 | 1, route: 'channel' | 'master') {
  engine.setFxRouting(rack, route)
  useStore.getState().patchFx(rack, { route })
  schedulePersistFxBank()
}

let persistFxBankTimer = 0
/** Debounced — dragging the wet/dry knob fires many times a second, same reasoning as `schedulePersistSamplerBank`. */
function schedulePersistFxBank() {
  window.clearTimeout(persistFxBankTimer)
  persistFxBankTimer = window.setTimeout(() => void persistFxBank(), 400)
}

async function persistFxBank(): Promise<void> {
  const { fx, setNotice } = useStore.getState()
  const bank = fx.map((r): StoredFxBank[number] => ({
    effect: r.effect,
    wetDry: r.wetDry,
    time: r.time,
    on: r.on,
    route: r.route,
  })) as StoredFxBank
  try {
    await saveFxBank(bank)
  } catch (err) {
    console.error('FX bank save failed', err)
    setNotice({
      text: `FX settings didn't save — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'fx',
    })
  }
}

let fxBankRestored: Promise<void> | null = null

/**
 * Boot-time restore (v0.7.0). Unlike the sampler bank, FX settings carry no
 * reference to a track — no library-scan resolution needed, so this is one
 * pass, not a two-phase meta-then-resolve restore. Idempotent, same shape
 * as `restoreSamplerBankMeta`.
 */
export function restoreFxBank(): Promise<void> {
  if (!fxBankRestored) {
    fxBankRestored = (async () => {
      const bank = await getFxBank()
      if (!bank) return
      const { patchFx } = useStore.getState()
      const bpm = masterPlayingBpm()
      bank.forEach((r, i) => {
        const rack = i as 0 | 1
        const patch: Partial<FxState> = { wetDry: r.wetDry, time: r.time, on: r.on, route: r.route }
        // Same refusal rule as a live setFxEffect click — a Reverb that
        // fails to rebuild on this boot must not be restored as "selected".
        if (engine.fx[rack].setEffect(r.effect)) patch.effect = r.effect
        engine.fx[rack].setWetDry(r.wetDry)
        engine.fx[rack].setTime(r.time, bpm)
        engine.fx[rack].setOn(r.on)
        engine.setFxRouting(rack, r.route)
        patchFx(rack, patch)
      })
    })()
  }
  return fxBankRestored
}

/** Save-as (ROADMAP.md v0.6.0's "export bank"). `'cancelled'` (the owner closed the dialog) is silent on purpose — everything else, including "this browser can't do this", is a notice. */
export async function exportSamplerBank(): Promise<void> {
  const { sampler, setNotice } = useStore.getState()
  // A recorded slot's actual audio (v0.7.5) lives in this browser's
  // IndexedDB, not in a portable file — including a bare `recordingId` in
  // the export would silently produce a slot no other machine (or a wiped
  // IndexedDB on this one) could ever resolve. Left out and counted,
  // rather than exported as a reference to nothing.
  const recordedCount = sampler.slots.filter((s) => s.recordingId).length
  const bank: StoredSamplerBank = sampler.slots.map((s) =>
    s.contentHash
      ? {
          contentHash: s.contentHash,
          recordingId: undefined,
          trackName: s.trackName ?? '',
          bpm: s.bpm,
          mode: s.mode,
          gain: s.gain,
          syncEnabled: s.syncEnabled,
        }
      : null,
  )
  try {
    const result = await exportSamplerBankToFile(bank)
    if (result === 'ok') {
      setNotice({
        text:
          recordedCount > 0
            ? `Sampler bank saved — ${recordedCount} recorded slot${recordedCount === 1 ? '' : 's'} weren't included (recordings don't travel in this file).`
            : 'Sampler bank saved.',
        tone: recordedCount > 0 ? 'warn' : 'info',
        source: 'sampler',
      })
    }
  } catch (err) {
    console.error('sampler bank export failed', err)
    setNotice({
      text: `Sampler bank export failed — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'sampler',
    })
  }
}

/**
 * Shared by both import paths (plain JSON and "collect and copy"): clears
 * every slot, drops entries a hand-edited or corrupted file could carry with
 * a `mode` that isn't one of the three real ones (leaving that pad looking
 * loaded but silently doing nothing on press — this project's central rule
 * forbids exactly that), saves, and resolves against the library/recordings.
 * Sanitized before it's saved, not just before it's applied, so a bad entry
 * doesn't survive round-trip through IndexedDB and come back valid-looking
 * on the next boot restore.
 */
async function applyImportedBank(bank: StoredSamplerBank): Promise<{ invalid: number }> {
  const { patchSamplerSlot } = useStore.getState()
  for (let i = 0; i < SAMPLER_SLOT_COUNT; i++) clearSamplerSlot(i)
  let invalid = 0
  const sanitized: StoredSamplerBank = bank.map((s, i) => {
    if (!s) return null
    if (!isSamplerMode(s.mode) || typeof s.gain !== 'number' || !isFinite(s.gain)) {
      invalid++
      return null
    }
    const gain = Math.max(0, Math.min(1, s.gain))
    patchSamplerSlot(i, {
      trackName: s.trackName,
      contentHash: s.contentHash,
      recordingId: s.recordingId,
      bpm: s.bpm,
      mode: s.mode,
      gain,
      syncEnabled: s.syncEnabled === true,
    })
    engine.sampler.setGain(i, gain)
    return { ...s, gain, syncEnabled: s.syncEnabled === true }
  })
  await saveSamplerBank(sanitized)
  await resolveSamplerSlots()
  return { invalid }
}

/** Import (ROADMAP.md v0.6.0's "import bank") — replaces every slot's settings, then resolves what it can against the current library exactly like a fresh boot restore. */
export async function importSamplerBank(): Promise<void> {
  const { setNotice } = useStore.getState()
  try {
    const bank = await importSamplerBankFromFile()
    if (bank === 'cancelled') return
    const { invalid } = await applyImportedBank(bank)
    setNotice({
      text:
        invalid > 0
          ? `Sampler bank imported — ${invalid} slot${invalid === 1 ? '' : 's'} in the file had invalid data and were left empty.`
          : 'Sampler bank imported.',
      tone: invalid > 0 ? 'warn' : 'info',
      source: 'sampler',
    })
  } catch (err) {
    console.error('sampler bank import failed', err)
    setNotice({
      text: `Sampler bank import failed — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'sampler',
    })
  }
}

/**
 * "Collect and copy" export (v0.8.9) — same JSON as `exportSamplerBank`, but
 * into a folder alongside the actual recorded audio, so a recorded slot
 * travels with the bank instead of being left out and only counted.
 */
export async function exportSamplerBankWithRecordingsToFolder(): Promise<void> {
  const { sampler, setNotice } = useStore.getState()
  const bank: StoredSamplerBank = sampler.slots.map((s) =>
    s.contentHash || s.recordingId
      ? {
          contentHash: s.contentHash,
          recordingId: s.recordingId,
          trackName: s.trackName ?? '',
          bpm: s.bpm,
          mode: s.mode,
          gain: s.gain,
          syncEnabled: s.syncEnabled,
        }
      : null,
  )
  try {
    const result = await exportSamplerBankWithRecordings(bank, getRecordingBlob)
    if (result.kind === 'cancelled') return
    const missing = result.total - result.collected
    setNotice({
      text:
        missing > 0
          ? `Sampler bank saved — ${result.collected} of ${result.total} recordings were collected (${missing} missing from storage).`
          : result.total > 0
            ? `Sampler bank + ${result.total} recording${result.total === 1 ? '' : 's'} saved.`
            : 'Sampler bank saved — no recordings in this bank.',
      tone: missing > 0 ? 'warn' : 'info',
      source: 'sampler',
    })
  } catch (err) {
    console.error('sampler bank + recordings export failed', err)
    setNotice({
      text: `Sampler bank export failed — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'sampler',
    })
  }
}

/** Inverse of `exportSamplerBankWithRecordingsToFolder` — restores both the bank layout and, for every recording the folder still has, its audio. */
export async function importSamplerBankWithRecordingsFromFolder(): Promise<void> {
  const { setNotice } = useStore.getState()
  try {
    const result = await importSamplerBankWithRecordings(saveRecordingBlob)
    if (result === 'cancelled') return
    const { invalid } = await applyImportedBank(result.bank)
    const parts: string[] = [
      `Sampler bank imported — ${result.recordingsFound} recording${result.recordingsFound === 1 ? '' : 's'} restored.`,
    ]
    if (result.recordingsMissing > 0) {
      parts.push(
        `${result.recordingsMissing} recording${result.recordingsMissing === 1 ? '' : 's'} named in the export weren't in the folder.`,
      )
    }
    if (invalid > 0) parts.push(`${invalid} slot${invalid === 1 ? '' : 's'} had invalid data and were left empty.`)
    setNotice({
      text: parts.join(' '),
      tone: result.recordingsMissing > 0 || invalid > 0 ? 'warn' : 'info',
      source: 'sampler',
    })
  } catch (err) {
    console.error('sampler bank + recordings import failed', err)
    setNotice({
      text: `Sampler bank import failed — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'sampler',
    })
  }
}

export function toggleCueMonitor(deckId: DeckId) {
  const deck = engine.decks[deckId]
  const on = !deck.cueMonitor
  deck.setCueMonitor(on)
  useStore.getState().patchDeck(deckId, { cueMonitor: on })
}

export function setChannelVolume(deckId: DeckId, v: number) {
  engine.decks[deckId].setVolume(v)
  useStore.getState().patchChannel(deckId, { volume: v })
}

export function setEq(deckId: DeckId, band: 'low' | 'mid' | 'high', v: number) {
  engine.decks[deckId].setEq(band, v)
  const key = band === 'low' ? 'eqLow' : band === 'mid' ? 'eqMid' : 'eqHigh'
  useStore.getState().patchChannel(deckId, { [key]: v })
}

export function setFilter(deckId: DeckId, v: number) {
  engine.decks[deckId].setFilter(v)
  useStore.getState().patchChannel(deckId, { filter: v })
}

export function setCrossfader(v: number) {
  // Not a spec'd cancel trigger by itself (ROADMAP.md only names the outgoing
  // deck stopping or its SYNC/tempo being touched) — this exists so a manual
  // drag mid-transition takes the fader over cleanly instead of fighting the
  // autonomous fade, which drives the crossfader every frame via
  // `engine.setCrossfader` directly and never through this function.
  if (activeTransition) cancelTransition()
  engine.setCrossfader(v)
  useStore.getState().patchMixer({ crossfader: v })
}

export function setMasterVolume(v: number) {
  engine.setMasterVolume(v)
  useStore.getState().patchMixer({ masterVolume: v })
}

export function setCueVolume(v: number) {
  engine.setCueVolume(v)
  useStore.getState().patchMixer({ cueVolume: v })
}

export function setCueMix(v: number) {
  engine.setCueMix(v)
  useStore.getState().patchMixer({ cueMix: v })
}

// ————————————————————————————————————————————————————————————————
// Recording (v0.7.5) — tap `masterPostFx`, accumulate PCM, write WAV. This
// first cut (PLAN.md step 4) is deliberately headless: no store, no UI, no
// save dialog — just proof the tap survives a real start-to-stop cycle
// before anything is built on top of it. `saveRecordedMaster`/UI wiring
// land in later steps of the same version.
// ————————————————————————————————————————————————————————————————

let masterRecordingTap: RecorderTap | null = null
/** One entry per delivered chunk, each `[left, right]` — kept as a list of chunks, not one growing array, so a mid-recording allocation failure loses only the newest chunk, not the whole take. */
let masterRecordingChunks: Float32Array[][] = []
let masterRecordingSampleRate = 0
let masterRecordingFrames = 0

export async function startRecordMaster(): Promise<void> {
  if (masterRecordingTap) return
  await initAudio()
  masterRecordingChunks = []
  masterRecordingFrames = 0
  masterRecordingSampleRate = engine.ctx.sampleRate
  const tap = await engine.createMasterTap()
  tap.onChunk = (chunk) => {
    masterRecordingChunks.push(chunk.channels)
    masterRecordingFrames += chunk.frameCount
    const bytesRecorded = masterRecordingFrames * 2 * 2 // stereo, 16-bit — matches what encodeWav will actually write
    useStore.getState().patchRecording({ bytesRecorded })
    // The cap is named, not a crash: hitting it stops the recording exactly
    // like a manual stop, with everything captured so far still there to
    // save. Never guessed at — `core/recording.ts`'s constant is the one
    // source of truth for "how long is too long".
    if (estimateSecondsRemaining(bytesRecorded, MASTER_RECORDING_MAX_SEC, masterRecordingSampleRate, 2) <= 0) {
      void stopRecordMaster()
      useStore.getState().setNotice({
        text: `Recording stopped automatically after reaching the ${Math.round(MASTER_RECORDING_MAX_SEC / 60)}-minute limit — everything up to that point is still here to save.`,
        tone: 'warn',
        source: 'recording',
      })
    }
  }
  masterRecordingTap = tap
  useStore.getState().patchRecording({
    active: 'master',
    startedAt: Date.now(),
    bytesRecorded: 0,
    savedState: 'idle',
    trackBoundariesSec: [],
  })
}

export async function stopRecordMaster(): Promise<void> {
  const tap = masterRecordingTap
  if (!tap) return
  masterRecordingTap = null
  await tap.stop()
  const totalFrames = masterRecordingChunks.reduce((sum, chs) => sum + (chs[0]?.length ?? 0), 0)
  const seconds = masterRecordingSampleRate ? totalFrames / masterRecordingSampleRate : 0
  console.log(
    `[recording] stopped — ${masterRecordingChunks.length} chunks, ${totalFrames} frames @ ${masterRecordingSampleRate}Hz (${seconds.toFixed(2)}s)`,
  )
  // The capture path itself can't tell if the AudioContext was ever
  // suspended (a backgrounded tab, QA risk from v0.7.5 — never reproduced,
  // never ruled out either): `RecorderTap` only ever sees the chunks it was
  // actually handed. Wall-clock time elapsed versus audio-time captured is
  // the one signal that can catch it after the fact, so this is checked on
  // every stop rather than left as a silent maybe.
  const startedAt = useStore.getState().recording.startedAt
  if (startedAt != null) {
    const wallClockSec = (Date.now() - startedAt) / 1000
    const gap = detectRecordingGap(wallClockSec, totalFrames, masterRecordingSampleRate)
    if (gap != null) {
      useStore.getState().setNotice({
        text: `Recording stopped — about ${gap.toFixed(0)}s of audio is missing compared to how long it ran. The browser may have suspended audio while the tab was in the background; check the file before relying on it.`,
        tone: 'warn',
        source: 'recording',
      })
    }
  }
  useStore.getState().patchRecording({ active: null, savedState: totalFrames > 0 ? 'unsaved' : 'idle' })
}

/**
 * Marks a track boundary at the current recording position (v0.7.5's own
 * dedicated control — not the per-deck hot cues, which are per-track and
 * don't span a whole set). Uses the exact frame count captured so far, not
 * wall-clock time, so it lines up exactly with `splitByTrackBoundaries`
 * regardless of any scheduling jitter between "now" and the last chunk.
 */
export function markRecordingTrackBoundary(): void {
  if (useStore.getState().recording.active !== 'master') return
  const sec = masterRecordingSampleRate ? masterRecordingFrames / masterRecordingSampleRate : 0
  useStore.getState().patchRecording({
    trackBoundariesSec: [...useStore.getState().recording.trackBoundariesSec, sec],
  })
}

/**
 * Encodes whatever is in the module-level buffer and opens the save dialog.
 * `'cancelled'` (the owner closed the dialog) leaves the buffer exactly as
 * it was — per the spec, canceling must never silently discard a
 * recording.
 */
export async function saveRecordedMaster(): Promise<'ok' | 'cancelled' | 'empty'> {
  if (masterRecordingChunks.length === 0) return 'empty'
  const channels = mergeChunks(masterRecordingChunks)
  const boundaries = useStore.getState().recording.trackBoundariesSec
  try {
    const result =
      boundaries.length === 0
        ? await saveMasterRecording(
            encodeWav(channels, masterRecordingSampleRate),
            `soundgrid-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`,
          )
        : await saveSplitRecording(channels, boundaries)
    if (result === 'ok') {
      masterRecordingChunks = []
      masterRecordingFrames = 0
      useStore.getState().patchRecording({ savedState: 'saved', bytesRecorded: 0, trackBoundariesSec: [] })
      useStore.getState().setNotice({
        text: boundaries.length === 0 ? 'Recording saved.' : `Recording saved — split into ${boundaries.length + 1} tracks.`,
        tone: 'info',
        source: 'recording',
      })
    }
    return result
  } catch (err) {
    console.error('[recording] save failed — recording kept in memory', err)
    useStore.getState().setNotice({
      text: `Recording couldn't be saved — it's still here, try again. (${err instanceof Error ? err.message : String(err)})`,
      tone: 'warn',
      source: 'recording',
    })
    throw err
  }
}

/**
 * Builds the shareable setlist text (v0.8.3) from every track loaded this
 * session and opens the save dialog — same `try`/`catch`/`setNotice` shape
 * as `saveRecordedMaster`. `'empty'` (nothing loaded yet) is checked before
 * the dialog even opens, so canceling and "nothing to export" stay visibly
 * different outcomes.
 */
export async function exportSetHistory(): Promise<'ok' | 'cancelled' | 'empty'> {
  const entries = useStore.getState().history
  if (entries.length === 0) return 'empty'
  const text = formatSetHistory(entries, new Date())
  try {
    const result = await saveSetHistoryText(text, `soundgrid-setlist-${new Date().toISOString().slice(0, 10)}.txt`)
    if (result === 'ok') {
      useStore.getState().setNotice({ text: 'Setlist saved.', tone: 'info', source: 'history' })
    }
    return result
  } catch (err) {
    console.error('[history] export failed', err)
    useStore.getState().setNotice({
      text: `Setlist couldn't be saved — try again. (${err instanceof Error ? err.message : String(err)})`,
      tone: 'warn',
      source: 'history',
    })
    throw err
  }
}

/** Slices the merged channels at each track boundary and writes one WAV per segment plus a cue sheet, all named from the same `segmentFileNames` list. */
async function saveSplitRecording(channels: Float32Array[], boundariesSec: number[]): Promise<'ok' | 'cancelled'> {
  const totalFrames = channels[0]?.length ?? 0
  const segments = splitByTrackBoundaries(totalFrames, boundariesSec, masterRecordingSampleRate)
  const names = segmentFileNames(segments.length)
  const files = segments.map((seg, i) => ({
    name: names[i],
    bytes: encodeWav(
      channels.map((ch) => ch.subarray(seg.startFrame, seg.endFrame)),
      masterRecordingSampleRate,
    ),
  }))
  const cueSheetText = buildCueSheet(segments, masterRecordingSampleRate)
  return saveSplitMasterRecording(files, cueSheetText)
}

/** Explicit discard — never called automatically. The owner's own "delete" action on an unsaved recording. */
export function discardRecordedMaster(): void {
  masterRecordingChunks = []
  masterRecordingFrames = 0
  useStore.getState().patchRecording({ savedState: 'idle', bytesRecorded: 0, trackBoundariesSec: [] })
}

// ————————————————————————————————————————————————————————————————
// Manual beat-grid correction (v0.3.0). No FLX4 control is bound to any of
// these: discovering which physical buttons are actually free needs the real
// hardware this remote session doesn't have, so guessing here would risk
// breaking a working mapping for no verifiable benefit. If one is ever
// mapped, it needs a `ControlAction` pair and a case in `dispatch`, the same
// as any other control — nothing here is exempt from the choke point, it is
// just not reachable from it yet.
// ————————————————————————————————————————————————————————————————

/** Mark the grid as looked at, edit or not — clears the "unconfirmed" pill. */
export function confirmBeatGrid(deckId: DeckId) {
  useStore.getState().patchDeck(deckId, { beatGridConfirmed: true })
}

export function toggleQuantize() {
  useStore.setState((s) => ({ quantize: !s.quantize }))
}

/**
 * `sec` snapped to `deckId`'s beat grid when quantize is on, unchanged when
 * it's off or the deck has no grid to snap to. The no-grid case is never a
 * silent no-op — the user asked for quantize and didn't get it, so they're
 * told, once, via the notice line (CLAUDE.md's central rule again).
 */
function quantizeIfOn(deckId: DeckId, sec: number): number {
  const { quantize, decks, setNotice } = useStore.getState()
  if (!quantize) return sec
  const grid = decks[deckId].beatGrid
  if (!grid) {
    setNotice({
      text: `Quantize is on but deck ${deckId} has no beat grid yet — this point was set exactly, not snapped.`,
      tone: 'warn',
      source: 'quantize',
    })
    return sec
  }
  return quantizeToGrid(sec, grid)
}

export function nudgeBeatGrid(deckId: DeckId, deltaSec: number = BEATGRID_NUDGE_SEC) {
  const { patchDeck, decks } = useStore.getState()
  const grid = decks[deckId].beatGrid
  if (!grid) return
  const next = shiftGrid(grid, deltaSec)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
}

/** Corrects an octave-low guess — see core/beatgrid.ts's halveGrid. */
export function halveBeatGrid(deckId: DeckId) {
  const { patchDeck, decks } = useStore.getState()
  const grid = decks[deckId].beatGrid
  if (!grid) return
  const next = halveGrid(grid)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
}

/** Corrects an octave-high guess — see core/beatgrid.ts's doubleGrid. */
export function doubleBeatGrid(deckId: DeckId) {
  const { patchDeck, decks } = useStore.getState()
  const grid = decks[deckId].beatGrid
  if (!grid) return
  const next = doubleGrid(grid)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
}

/**
 * Beat 0 is wherever the playhead sits right now, at the grid's current bpm
 * (or the plain tag/detected bpm if there was no grid yet at all — this is
 * also how a track with no detectable periodicity gets a first grid).
 */
export function setDownbeatHere(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const { patchDeck, decks } = useStore.getState()
  const bpm = decks[deckId].beatGrid?.bpm ?? decks[deckId].bpm
  if (!bpm) return
  const next = setDownbeatAt(bpm, deck.position)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
}

/** Per-deck tap timestamps for tapTempo, seconds since the page loaded. */
const tapTimesSec: Record<DeckId, number[]> = { A: [], B: [] }
/** A gap this long since the last tap starts a fresh tap sequence. */
const TAP_RESET_SEC = 2

/**
 * One call per tap (button press or key). Needs two taps to say anything;
 * every tap after that refines the estimate (core/beatgrid.ts's bpmFromTaps
 * rejects one fat-fingered interval on its own).
 */
export function tapTempo(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const now = performance.now() / 1000
  const taps = tapTimesSec[deckId]
  if (taps.length > 0 && now - taps[taps.length - 1] > TAP_RESET_SEC) taps.length = 0
  taps.push(now)
  if (taps.length > 8) taps.shift() // bound memory; recent taps matter most
  const bpm = bpmFromTaps(taps)
  if (bpm == null) return
  const { patchDeck, decks } = useStore.getState()
  const offsetSec = decks[deckId].beatGrid?.offsetSec ?? 0
  patchDeck(deckId, { beatGrid: { bpm, offsetSec }, bpm, beatGridConfirmed: true })
}

// ————————————————————————————————————————————————————————————————
// Phase-align SYNC + master deck (v0.3.0)
//
// Why an ongoing correction loop and not a one-shot nudge on the SYNC press:
// once tempo faders match, both decks share one AudioContext clock, so there
// is no drift *source* between them except that each deck's detected bpm has
// finite precision (rounded to 0.1, core/beatgrid.ts). A ~0.1bpm error at 128
// bpm is ~0.08% — over two minutes that is up to ~0.1s of accumulated drift,
// enough to fail the "stays in phase" bar. A single correction at press-time
// cannot chase an error that only reveals itself gradually.
//
// Why this lives here and not in platform/: it needs engine.decks (rate
// control) and useStore (grid/master/quantize state) together, which is
// exactly what every other function in this file already does. Putting it in
// platform/audio-webaudio/ would mean platform/ reaching into
// @/app/state/store — a second copy of the one documented, deliberate
// boundary violation (.dependency-cruiser.cjs) that transport-webmidi/
// manager.ts already carries, which CLAUDE.md is explicit must not happen.
// ————————————————————————————————————————————————————————————————

const SYNC_LOOP_INTERVAL_SEC = 1
/** Below this phase gap, a correction would be smaller than it's worth firing. */
const SYNC_PHASE_DEADBAND_SEC = 0.004

let syncLoopStarted = false
/** Subscribed once, ever — same lifetime as useRenderLoop's clock subscription. Each deck's own `syncActive` flag is what turns correction on and off, not this. */
function ensureSyncLoop() {
  if (syncLoopStarted) return
  syncLoopStarted = true
  let last = 0
  clock.subscribe((t) => {
    if (t - last < SYNC_LOOP_INTERVAL_SEC) return
    last = t
    runSyncCorrection()
    updateSyncedSamplerLoops()
  })
}

/**
 * Sampler tempo follow (v0.6.0): a playing, sync-enabled Loop-mode slot's
 * rate is recomputed against the master deck's *current* effective BPM
 * (tag bpm × tempo fader) on the same tick `runSyncCorrection` already runs
 * on — so nudging the master's tempo fader after a sampler loop started
 * keeps it matched, the "stays in sync with a playing deck" bar ROADMAP.md
 * sets for v0.6.0. No phase alignment: a one-shot sample has no beat grid to
 * lock a downbeat against, only a tempo to match.
 */
function updateSyncedSamplerLoops() {
  const { masterDeckId, decks, sampler } = useStore.getState()
  if (!masterDeckId) return
  const master = decks[masterDeckId]
  const masterBpm = master.bpm ? master.bpm * tempoToRate(master.tempo, cfg.tempoRange) : null
  if (!masterBpm) return
  sampler.slots.forEach((slot, i) => {
    if (slot.mode !== 'loop' || !slot.syncEnabled || !slot.playing || !slot.bpm) return
    engine.sampler.setRate(i, samplerSyncRate(masterBpm, slot.bpm, true))
  })
}

function runSyncCorrection() {
  const { decks, masterDeckId } = useStore.getState()
  if (!masterDeckId) return
  const master = decks[masterDeckId]
  for (const id of ['A', 'B'] as DeckId[]) {
    if (id === masterDeckId) continue
    const st = decks[id]
    if (!st.syncActive || !st.playing || !master.playing) continue
    if (!st.beatGrid || !master.beatGrid) continue
    const deck = engine.decks[id]
    const masterDeck = engine.decks[masterDeckId]
    const delta = phaseDeltaSec(deck.position, st.beatGrid, masterDeck.position, master.beatGrid)
    if (Math.abs(delta) < SYNC_PHASE_DEADBAND_SEC) continue
    deck.syncNudge(delta, SYNC_LOOP_INTERVAL_SEC)
  }
}

/**
 * SYNC: match tempo to the master deck (auto-resolved to the other deck if
 * none is set yet), then keep phase-locked to it until pressed again, the
 * tempo fader is touched (setTempo), or a new track loads (loadTrackToDeck) —
 * all three already patch `syncActive: false`. Pressing SYNC on the deck
 * that is already master is a no-op with a notice, not a silent nothing:
 * there is nothing beneath the master to lock to.
 */
export function syncDeck(deckId: DeckId) {
  if (!engine.decks[deckId].hasTrack) return
  // This function's own internal caller (`startAutoTransition`'s
  // seek-then-sync handoff) only ever targets the *incoming* deck, so this
  // can only cancel on a genuine manual SYNC tap on the outgoing deck.
  cancelTransitionIfOutgoingDeckTouched(deckId)
  const other: DeckId = deckId === 'A' ? 'B' : 'A'
  const { decks, masterDeckId, patchDeck, setNotice } = useStore.getState()
  const st = decks[deckId]

  if (st.syncActive) {
    patchDeck(deckId, { syncActive: false })
    return
  }

  // A stored master that is paused is stale while the other deck plays: master
  // is only ever assigned, never released, so a deck that led an earlier mix
  // kept the role after stopping. Left as is, SYNC on the loaded deck said
  // "already master" and did nothing, while SYNC on the playing deck retuned
  // it to the paused one — the reverse of what a DJ means.
  let resolvedMaster: DeckId = masterDeckId ?? other
  if (!decks[resolvedMaster].playing) {
    const otherOfMaster: DeckId = resolvedMaster === 'A' ? 'B' : 'A'
    if (decks[otherOfMaster].playing) resolvedMaster = otherOfMaster
  }
  if (resolvedMaster !== masterDeckId && masterDeckId != null && resolvedMaster !== deckId) {
    useStore.setState({ masterDeckId: resolvedMaster })
    refreshFxTimeForMasterTempo()
  }
  if (resolvedMaster === deckId) {
    setNotice({
      text: `Deck ${deckId} is already master — long-press SYNC on deck ${other} to make it master instead.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  // Checked and named separately — blaming the master deck for a gap that
  // was actually on this deck (or vice versa) sends the user troubleshooting
  // the wrong one.
  if (!st.bpm) {
    setNotice({
      text: `Deck ${deckId} has no tempo yet — nothing to sync from.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  const master = decks[resolvedMaster]
  if (!master.bpm || !master.beatGrid) {
    setNotice({
      text: `Deck ${resolvedMaster} has no tempo/grid yet — nothing to sync to.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }

  // First-ever SYNC press: no master existed yet, so `masterPlayingBpm()`
  // had nothing to read and FX beat-sync time was never set from a real
  // BPM. Now that one exists, give FX its first real value instead of
  // waiting for the master deck's tempo fader to be touched.
  if (masterDeckId == null) {
    useStore.setState({ masterDeckId: resolvedMaster })
    refreshFxTimeForMasterTempo()
  }
  const tempo = syncTempoFor(master.bpm, master.tempo, st.bpm, settings.values.tempoRange)
  setTempo(deckId, tempo, { persist: false })
  patchDeck(deckId, { syncActive: true })
  ensureSyncLoop()
}

/**
 * Explicit master override — SYNC long-press (v0.3.0). Always wins over the
 * automatic pick. A deck already phase-locked (syncActive) to the old master
 * is re-engaged against the new one rather than dropped: the point of
 * overriding master mid-mix is to keep mixing, not to have to press SYNC
 * again. The deck being promoted can't stay locked to what it used to follow.
 */
export function setMasterDeck(deckId: DeckId) {
  const { decks, patchDeck } = useStore.getState()
  useStore.setState({ masterDeckId: deckId })
  // The new master's BPM is (almost always) not the old master's — FX
  // beat-sync time was computed against the deck that just stopped being
  // master, and this is the one place that reassignment happens.
  refreshFxTimeForMasterTempo()
  if (decks[deckId].syncActive) patchDeck(deckId, { syncActive: false })

  const other: DeckId = deckId === 'A' ? 'B' : 'A'
  const st = decks[other]
  if (!st.syncActive) return
  const master = decks[deckId]
  const mine = st.bpm
  if (!master.bpm || !mine) return
  const tempo = syncTempoFor(master.bpm, master.tempo, mine, settings.values.tempoRange)
  setTempo(other, tempo, { persist: false })
  patchDeck(other, { syncActive: true })
  ensureSyncLoop()
}

// ————————————————————————————————————————————————————————————————
// Mix Assist (v0.4.6), build step 7 — the autonomous transition itself.
// ROADMAP.md flags this as the riskiest step in the version: it drives the
// live crossfader and a second deck's playback on a timer, unattended. The
// module-level `activeTransition` below is the imperative half (the running
// rAF-driven fade, the state to cancel back to) — same split as
// `ensureSyncLoop`'s own module-level subscription just above. The store's
// `activeTransition` field is only the serializable half Mixer.tsx reads to
// show its cancel button.
// ————————————————————————————————————————————————————————————————

interface ActiveTransition {
  fromDeckId: DeckId
  toDeckId: DeckId
  /** what the incoming deck looked like right before this transition touched it — what `cancelTransition` restores. */
  toPreState: { positionSec: number; playing: boolean }
  startedAtSec: number
  unsubscribe: () => void
  /** v0.5.4: the outgoing deck's own suggested exit point — see `AppState.activeTransition`'s own doc comment. Carried here too so `finishTransition` can raise the rating prompt without recomputing it. */
  exitPointSec: number | null
  /** v0.8.14: the raw `entrySec` this transition was called with, before `phaseAlignedEntrySec` re-aligns it — carried through to `pendingMixRating` for `markExcellentPair`, same split as `exitPointSec` above. */
  entrySec: number
}

let activeTransition: ActiveTransition | null = null

/**
 * For `setTempo`/`syncDeck` only: this file's own seek-then-sync handoff
 * calls both of those, but only ever on the *incoming* deck (`syncDeck`
 * internally calls `setTempo` too) — so a guard keyed on the outgoing deck
 * alone can see a manual touch there without ever seeing its own internal
 * calls and self-cancelling.
 */
function cancelTransitionIfOutgoingDeckTouched(deckId: DeckId) {
  if (activeTransition && deckId === activeTransition.fromDeckId) cancelTransition()
}

/**
 * For every other manual action this file itself never performs on *either*
 * transition deck through these same wrapper functions (`startAutoTransition`
 * drives the incoming deck through the raw engine object directly —
 * `toEngine.seek`/`toEngine.play`, never `ctl.play`/`ctl.togglePlay`) — so
 * both sides can be guarded with no self-cancel risk. ROADMAP.md: "any
 * change to the playing deck before the transition completes — the track
 * stops, or the user touches SYNC/pitch by hand — cancels automatically";
 * this applies it to the *incoming* deck too, since pausing/re-cueing/
 * scratching/bending the deck that's mid-join is just as much "taking the
 * mix back by hand" as doing it to the deck that was already playing.
 */
function cancelTransitionIfEitherDeckTouched(deckId: DeckId) {
  if (
    activeTransition &&
    (deckId === activeTransition.fromDeckId || deckId === activeTransition.toDeckId)
  ) {
    cancelTransition()
  }
}

/**
 * Seek-then-sync (ROADMAP.md v0.4.6): the incoming deck is aligned and
 * started while the crossfader still sits fully on the outgoing deck (so the
 * join is inaudible), then handed to the existing `syncDeck`/`ensureSyncLoop`
 * for continuous correction exactly like a manually-pressed SYNC would be.
 * From there a `clock`-driven loop (the same shared rAF source
 * `ensureSyncLoop` itself subscribes to) drives the crossfader through
 * `core/transition.ts`'s `crossfadeProgress` over `TRANSITION_CROSSFADE_SEC`,
 * via `engine.setCrossfader` — the exact equal-power law
 * `core/transition.ts`'s own `crossfadeGains` documents and
 * `tests/core/transition.test.ts` pins, so the autonomous fade sounds like
 * the same crossfader curve the user's hand already knows.
 *
 * Refuses (with a notice, never a silent no-op) rather than start a
 * transition it cannot phase-align or that would land on a deck that is not
 * cleanly available — a deck already mid-load, or already playing.
 */
/** `engine.setCrossfader`'s domain is -1 (A only) .. +1 (B only) — the extreme fully on `fromDeckId`. */
function crossfaderExtremeFor(fromDeckId: DeckId): number {
  return fromDeckId === 'A' ? -1 : 1
}

export function startAutoTransition(fromDeckId: DeckId, toDeckId: DeckId, entrySec: number) {
  const { decks, setNotice } = useStore.getState()
  if (activeTransition) {
    setNotice({ text: 'A transition is already running — cancel it before starting another.', tone: 'warn', source: 'sync' })
    return
  }
  const from = decks[fromDeckId]
  const to = decks[toDeckId]
  if (!from.playing || !to.track || to.playing || to.loading) {
    setNotice({
      text: `Can't start that transition — deck ${fromDeckId} isn't playing, or deck ${toDeckId} isn't a loaded, paused track.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  if (!from.beatGrid || !to.beatGrid) {
    setNotice({
      text: `Can't phase-align this transition — deck ${!from.beatGrid ? fromDeckId : toDeckId} has no beat grid yet.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  // v0.4.10: an unconfirmed grid is a guess, not a refusal reason — Shalom's
  // call (05/09): "like a blinking yellow light: it's a risk, but I'm doing
  // it" rather than blocking mid-set. Named explicitly so the DJ knows which
  // side to listen to, same as every other notice this function already
  // raises.
  const unconfirmed: DeckId[] = []
  if (!from.beatGridConfirmed) unconfirmed.push(fromDeckId)
  if (!to.beatGridConfirmed) unconfirmed.push(toDeckId)
  if (unconfirmed.length > 0) {
    setNotice({
      text: `Phase-aligning against an unconfirmed beat grid on deck ${unconfirmed.join(' and ')} — the join may drift more than usual until SYNC catches it up.`,
      tone: 'warn',
      source: 'sync',
    })
  }

  const fromEngine = engine.decks[fromDeckId]
  const toEngine = engine.decks[toDeckId]

  // Establish the join point explicitly rather than trust whatever the live
  // crossfader already happens to read — ROADMAP.md requires the incoming
  // deck to start while the crossfader "still sits fully" on the outgoing
  // one, and a manual nudge earlier (while only one deck was playing) could
  // otherwise leave it short of that extreme.
  const startExtreme = crossfaderExtremeFor(fromDeckId)
  engine.setCrossfader(startExtreme)

  // v0.4.10: `fromEngine.position` is read as late as possible — right next
  // to the seek it feeds — with no store write between the two. A `patchMixer`/
  // `patchDeck` call here is a synchronous Zustand notify to every listening
  // React component, at a cost that varies with whatever's on screen; with
  // `enterSec` computed *before* that write (the old order), `fromDeckId` kept
  // playing through the unpredictable delay and the join landed on a phase
  // that had already moved on. Measured on the real library (v0.4.6): 65.85ms
  // average, 280ms worst-case. The store writes below move after the seek/play
  // that actually needs the fresh position — `engine.setCrossfader` stays
  // before them, audio-graph-only, so the incoming deck is still silent when
  // it lands.
  const enterSec = phaseAlignedEntrySec(entrySec, to.beatGrid, fromEngine.position, from.beatGrid)
  toEngine.seek(enterSec)
  toEngine.play()
  useStore.getState().patchMixer({ crossfader: startExtreme })
  useStore.getState().patchDeck(toDeckId, { playing: true, positionSec: enterSec })
  // The reference this transition is built on is `fromDeckId`, regardless of
  // whatever `masterDeckId` happened to hold before — asserted explicitly so
  // `syncDeck`'s "already master" no-op branch (only reachable if `toDeckId`
  // happened to be a stale master from something it played earlier) can
  // never silently skip the handoff and leave phase drift uncorrected for
  // the rest of the fade.
  if (useStore.getState().masterDeckId !== fromDeckId) {
    useStore.setState({ masterDeckId: fromDeckId })
  }
  syncDeck(toDeckId)

  const startedAtSec = engine.currentTime
  const unsubscribe = clock.subscribe((t) => {
    const progress = crossfadeProgress(t - startedAtSec, TRANSITION_CROSSFADE_SEC)
    // engine.setCrossfader's own domain is -1 (A only) .. +1 (B only); this
    // maps `progress` onto whichever half of that range moves *away* from
    // `fromDeckId`, in either direction.
    const x = fromDeckId === 'A' ? -1 + 2 * progress : 1 - 2 * progress
    engine.setCrossfader(x)
    useStore.getState().patchMixer({ crossfader: x })
    if (progress >= 1) finishTransition()
  })

  // v0.5.4: the outgoing deck's own next candidate point, shown as a
  // suggested exit — the same heuristic `TransitionPointsPanel` already uses
  // for the *incoming* side, just read for whichever track is now playing
  // out. `null` when there's no analysis yet or nothing left ahead, never a
  // guess (`nextCandidateFrom`'s own doc comment, `core/structure.ts`).
  // `fromEngine.position`, not the `from.positionSec` store snapshot taken
  // at function entry — same freshness reason as `enterSec` two lines
  // above: candidates are 20s+ apart (`MIN_GAP_SEC`), so it would rarely
  // matter, but there is no reason to reintroduce the staleness that
  // comment already measured just to save one property read.
  const exitCandidates = from.bands ? findTransitionCandidates(from.bands, from.durationSec, from.beatGrid) : []
  const exitPointSec = from.bands ? (nextCandidateFrom(exitCandidates, fromEngine.position)?.sec ?? null) : null

  activeTransition = {
    fromDeckId,
    toDeckId,
    toPreState: { positionSec: to.positionSec, playing: to.playing },
    startedAtSec,
    unsubscribe,
    exitPointSec,
    entrySec,
  }
  useStore.setState({ activeTransition: { fromDeckId, toDeckId, exitPointSec } })
}

/**
 * Crossfade reached 100% (ROADMAP.md): the incoming deck becomes
 * master-sync automatically, and the cancel button disappearing (via
 * `activeTransition` clearing) is the only signal the transition ended.
 *
 * v0.5.4: also raises the rating prompt (`App.tsx`'s `TransitionRatingPrompt`)
 * for the exit point this transition actually used — only when one was found
 * (`exitPointSec` non-null) and the outgoing track carries a `contentHash` to
 * key a rating against. A cancelled transition (`cancelTransition` below)
 * never reaches here, so backing out of a mix never triggers a rating for
 * one that didn't happen.
 */
function finishTransition() {
  const t = activeTransition
  if (!t) return
  activeTransition = null
  t.unsubscribe()
  useStore.setState({ activeTransition: null })
  setMasterDeck(t.toDeckId)

  const fromTrack = useStore.getState().decks[t.fromDeckId].track
  if (t.exitPointSec != null && fromTrack) {
    const toTrack = useStore.getState().decks[t.toDeckId].track
    useStore.setState({
      pendingMixRating: {
        fromDeckId: t.fromDeckId,
        contentHash: fromTrack.contentHash,
        trackName: fromTrack.name,
        exitPointSec: t.exitPointSec,
        toContentHash: toTrack?.contentHash,
        entrySec: t.entrySec,
      },
    })
  }
}

/**
 * The cancel button (Mixer.tsx): fixed, prominent, no confirmation dialog.
 * Both decks return to exactly their pre-transition state — the outgoing
 * deck was never touched by this code, so only the crossfader (back to
 * fully on it) and the incoming deck (paused, seeked back) need restoring —
 * and no further automatic correction fires afterward: clearing
 * `syncActive` here is what keeps `runSyncCorrection`'s loop from touching
 * the incoming deck again once it is silent and paused.
 */
export function cancelTransition() {
  const t = activeTransition
  if (!t) return
  activeTransition = null
  t.unsubscribe()
  useStore.setState({ activeTransition: null })

  const toEngine = engine.decks[t.toDeckId]
  toEngine.pause()
  toEngine.seek(t.toPreState.positionSec)
  useStore.getState().patchDeck(t.toDeckId, {
    playing: t.toPreState.playing,
    positionSec: t.toPreState.positionSec,
    syncActive: false,
  })

  const x = crossfaderExtremeFor(t.fromDeckId)
  engine.setCrossfader(x)
  useStore.getState().patchMixer({ crossfader: x })
}

/**
 * The rating prompt's own three buttons (v0.5.4, `App.tsx`). Only
 * `'excellent'` is persisted (`platform/mix-ratings-idb/store.ts`'s own doc
 * comment says why 'bad'/'needs-work' aren't) — clears the prompt either way,
 * since "not now" and "rated" both mean there's nothing left to ask about
 * this transition. A missing `contentHash` (hash failed at load) degrades to
 * "can't remember this one" rather than throwing — the same "not yet
 * identified" treatment `loadTrackToDeck` already gives it everywhere else.
 * If the rated track is still loaded on the same deck, its live
 * `excellentMixPoints` is patched too, so the exit-point indicator picks up
 * the mark immediately without waiting for a reload.
 */
export function rateMixTransition(rating: 'bad' | 'needs-work' | 'excellent') {
  const { pendingMixRating, decks, patchDeck } = useStore.getState()
  if (!pendingMixRating) return
  useStore.setState({ pendingMixRating: null })
  if (rating !== 'excellent' || !pendingMixRating.contentHash) return
  void markExcellent(pendingMixRating.contentHash, pendingMixRating.exitPointSec).catch((err) => {
    console.error('markExcellent failed', err)
  })
  // v0.8.14: the pair only saves when both tracks are already identified —
  // the incoming track's hash can still be missing this soon after it took
  // over (analysis may still be running), and there is no later trigger that
  // would fill it in for this specific transition, so the gap is surfaced
  // rather than silently dropped.
  if (pendingMixRating.toContentHash) {
    void markExcellentPair(pendingMixRating.contentHash, pendingMixRating.toContentHash, pendingMixRating.entrySec).catch(
      (err) => {
        console.error('markExcellentPair failed', err)
      },
    )
  } else {
    useStore.getState().setNotice({
      text: "Pair not saved — the other track hasn't finished analyzing yet.",
      tone: 'info',
      source: 'mixRating',
    })
  }
  const deck = decks[pendingMixRating.fromDeckId]
  if (deck.track?.contentHash === pendingMixRating.contentHash) {
    const rounded = Math.round(pendingMixRating.exitPointSec)
    if (!deck.excellentMixPoints.includes(rounded)) {
      patchDeck(pendingMixRating.fromDeckId, { excellentMixPoints: [...deck.excellentMixPoints, rounded] })
    }
  }
}

export function selectedTrack(): Track | undefined {
  const { library } = useStore.getState()
  return library.tracks.find((t) => t.id === library.selectedId)
}

export function moveSelection(delta: number) {
  const { library, setLibrary } = useStore.getState()
  // sortedFilteredTracks(), not filteredTracks() — v0.8.0 lets the visible
  // table be sorted by any column; walking the unsorted list here would
  // move the highlight to whatever's next in scan order, not the row
  // actually above/below it on screen. Found by independent review, not
  // caught while building the sort feature itself.
  const list = sortedFilteredTracks()
  if (list.length === 0) return
  const idx = list.findIndex((t) => t.id === library.selectedId)
  const nextIdx = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + delta))
  setLibrary({ selectedId: list[nextIdx].id })
}

export function filteredTracks(): Track[] {
  const { library, crates } = useStore.getState()
  const base = library.tracks.filter((t) => matchesQuery(t, library.query))
  const crate = library.activeCrateId ? crates.get(library.activeCrateId) : undefined
  if (!crate) return base
  const members = new Set(crate.kind === 'manual' ? (crate.members ?? []) : (crate.materialized ?? []))
  return base.filter((t) => t.contentHash && members.has(t.contentHash))
}

/**
 * Select which crate narrows the table, or `null` for the whole library
 * (v0.8.1) — the one place this view-state action is dispatched from, per
 * the project's "every user action goes through controls.ts" rule, even
 * though the effect is a single-field store write.
 */
export function setActiveCrate(id: string | null) {
  useStore.getState().setLibrary({ activeCrateId: id })
}

/**
 * Select a track row (v0.8.7). `Library.tsx` used to write `selectedId`
 * straight to the store from its row's `onClick`, the one spot in that file
 * that skipped the "every user action goes through `controls.ts`" rule —
 * found while wiring the row up to the keyboard, which needed a function to
 * call from `onKeyDown` too.
 */
export function selectTrack(id: string) {
  useStore.getState().setLibrary({ selectedId: id })
}

/**
 * `filteredTracks()` plus the column sort (v0.8.0) — kept separate rather
 * than folded into it because `moveSelection` and Mix Assist's
 * recommendation matching both want the filter alone, unsorted, and never
 * cared about `library.sortKey` before this version existed.
 */
export function sortedFilteredTracks(): Track[] {
  const { library } = useStore.getState()
  return sortTracks(filteredTracks(), library.sortKey, library.sortDir)
}

/**
 * Manual genre pick — the choke point for this action, called from the
 * library table's dropdown. Updates the store immediately so the cell
 * reflects the choice with no round-trip wait, then persists it; a write
 * failure keeps the in-memory value (an edit that silently reverts on the
 * next render is worse than one that silently fails to survive a reload) and
 * surfaces through the existing notice banner rather than a swallowed catch.
 *
 * Persisted by content hash since v0.4.0, not `trackId` (a scan-relative
 * path) — this is what makes the override survive the file turning up in a
 * different genre folder later. Most tracks already have `contentHash` by
 * the time an owner gets around to overriding their genre (the background
 * queue reaches them first); the ones that don't — a pick made right after a
 * fresh scan, before that queue catches up — get a one-off single-file hash
 * here (`hashFile`, the same on-demand path `core/types.ts`'s own doc
 * comment names), and that hash is kept on the track so nothing re-hashes it
 * a second time later.
 */
export function setTrackGenre(trackId: string, genre: string) {
  const { library, setLibrary, setNotice } = useStore.getState()
  setLibrary({
    tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, genre } : t)),
  })
  void persistGenreOverride(trackId, genre).catch((err) => {
    setNotice({
      text: `Genre change applied but not saved: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'library',
    })
  })
}

async function persistGenreOverride(trackId: string, genre: string): Promise<void> {
  const track = useStore.getState().library.tracks.find((t) => t.id === trackId)
  if (!track) return // rescanned/removed since the click — nothing left to persist against
  let hash = track.contentHash
  if (!hash) {
    hash = await hashFile(track.handle)
    const { library, setLibrary } = useStore.getState()
    setLibrary({
      tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, contentHash: hash } : t)),
    })
  }
  await setGenreOverrideByHash(hash, genre)
}

/**
 * Manual note edit — same choke point/persistence shape as `setTrackGenre`
 * immediately above (optimistic store update, hash-keyed persistence,
 * failure surfaced through the notice banner rather than swallowed).
 */
export function setTrackNote(trackId: string, note: string) {
  const { library, setLibrary, setNotice } = useStore.getState()
  setLibrary({
    tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, note } : t)),
  })
  void persistTrackNote(trackId, note).catch((err) => {
    setNotice({
      text: `Note change applied but not saved: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'library',
    })
  })
}

async function persistTrackNote(trackId: string, note: string): Promise<void> {
  const track = useStore.getState().library.tracks.find((t) => t.id === trackId)
  if (!track) return // rescanned/removed since the edit — nothing left to persist against
  let hash = track.contentHash
  if (!hash) {
    hash = await hashFile(track.handle)
    const { library, setLibrary } = useStore.getState()
    setLibrary({
      tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, contentHash: hash } : t)),
    })
  }
  await persistTrackNoteByHash(hash, note)
}

/**
 * Crates (v0.8.1) — named track groupings, independent of the on-disk
 * folder structure. Same choke-point shape as `setTrackGenre`/`setTrackNote`
 * above: an optimistic, immediate store update, then an async persist whose
 * failure surfaces through the notice banner rather than a swallowed catch.
 */

function patchCrates(id: string, record: CrateRecord | null) {
  const { crates, set } = useStore.getState()
  const next = new Map(crates)
  if (record) next.set(id, record)
  else next.delete(id)
  set('crates', next)
}

function reportCrateFailure(err: unknown) {
  useStore.getState().setNotice({
    text: `Crate change applied but not saved: ${err instanceof Error ? err.message : String(err)}`,
    tone: 'warn',
    source: 'library',
  })
}

export function createCrate(name: string) {
  const record: CrateRecord = { id: crypto.randomUUID(), name, kind: 'manual', members: [] }
  patchCrates(record.id, record)
  void saveCrate(record).catch(reportCrateFailure)
}

export function renameCrate(id: string, name: string) {
  const record = useStore.getState().crates.get(id)
  if (!record) return
  const next = { ...record, name }
  patchCrates(id, next)
  void saveCrate(next).catch(reportCrateFailure)
}

/**
 * The caller (`CratesRail.tsx`) is responsible for confirming this with the
 * user first — `window.confirm`, since nothing in this app has needed a
 * confirmation dialog before now and one button doesn't earn a new
 * component. This function itself just does the (now-authorized) delete.
 */
export function deleteCrate(id: string) {
  patchCrates(id, null)
  void deleteCrateRecord(id).catch(reportCrateFailure)
}

/**
 * Add a track to a manual crate. Idempotent — a track already in `members`
 * produces no change, so dragging the same track onto the same crate twice
 * is a visible no-op, never a duplicate entry. Rejected for a smart crate:
 * its membership is entirely rule-derived (`refreshSmartCrate`), so a
 * manual pin here would create two competing sources of truth for the same
 * row — the caller (`CratesRail.tsx`) is expected not to offer this as a
 * drop target for a smart crate at all, but this function refuses too, in
 * case something else ever calls it directly.
 */
export function addTrackToCrate(crateId: string, track: Track) {
  const record = useStore.getState().crates.get(crateId)
  if (!record || record.kind !== 'manual') return
  if (!track.contentHash) {
    void persistTrackToCrateByFreshHash(crateId, track)
    return
  }
  if (record.members?.includes(track.contentHash)) return // already a member — no-op, not a duplicate
  const next = { ...record, members: [...(record.members ?? []), track.contentHash] }
  patchCrates(crateId, next)
  void saveCrate(next).catch(reportCrateFailure)
}

/**
 * Same on-demand-hash shape as `persistGenreOverride`/`persistTrackNote`
 * above: most tracks already have `contentHash` by the time a user drags
 * one into a crate (the background analysis queue reaches them first), but
 * a track dragged right after a fresh scan might not yet. One-off hash
 * here, kept on the track so nothing re-hashes it later, then the same
 * membership write `addTrackToCrate` does for a track that already had one.
 */
async function persistTrackToCrateByFreshHash(crateId: string, track: Track): Promise<void> {
  const current = useStore.getState().library.tracks.find((t) => t.id === track.id)
  if (!current) return // rescanned/removed since the drop — nothing left to attach to
  const hash = current.contentHash ?? (await hashFile(current.handle))
  if (!current.contentHash) {
    const { library, setLibrary } = useStore.getState()
    setLibrary({ tracks: library.tracks.map((t) => (t.id === track.id ? { ...t, contentHash: hash } : t)) })
  }
  addTrackToCrate(crateId, { ...current, contentHash: hash })
}

export function removeTrackFromCrate(crateId: string, hash: string) {
  const record = useStore.getState().crates.get(crateId)
  if (!record?.members) return
  const next = { ...record, members: record.members.filter((h) => h !== hash) }
  patchCrates(crateId, next)
  void saveCrate(next).catch(reportCrateFailure)
}

export function createSmartCrate(name: string, query: string) {
  // Empty until the first explicit refresh — never auto-filled at creation,
  // consistent with "a smart crate updates only on a refresh click."
  const record: CrateRecord = { id: crypto.randomUUID(), name, kind: 'smart', query, materialized: [] }
  patchCrates(record.id, record)
  void saveCrate(record).catch(reportCrateFailure)
}

/**
 * Re-runs the crate's saved query against the library as it stands *right
 * now* and freezes the result — never a live/derived view, so "only on a
 * refresh click" is a property of the stored data, not a rendering
 * discipline someone could accidentally break later.
 */
export function refreshSmartCrate(crateId: string) {
  const { crates, library } = useStore.getState()
  const record = crates.get(crateId)
  if (!record || record.kind !== 'smart' || record.query == null) return
  const materialized = library.tracks
    .filter((t) => t.contentHash && matchesQuery(t, record.query!))
    .map((t) => t.contentHash!)
  const next = { ...record, materialized, refreshedAt: Date.now() }
  patchCrates(crateId, next)
  void saveCrate(next).catch(reportCrateFailure)
}

// ————————————————————————————————————————————————————————————————
// Natural-language control (v0.5.5) — text only, no voice this version.
//
// The AI layer is a third caller of this same choke point, alongside the
// UI and MIDI: it never touches `engine`/the store directly, only the
// exported functions above (`play`, `pause`, `pressLoopPad` via `loop`,
// `pressHotCue`, `syncDeck`, `tapTempo`, `setFilter`, `setCrossfader`,
// `setChannelVolume`, `setEq`). `core/ai/toolCatalog.ts`'s
// `validateToolCall` is the gate: nothing the model returns reaches those
// functions unless it matches a real, existing tool exactly — a
// hallucinated or malformed call is rejected with a visible notice
// instead of silently no-op'ing, the gap MIDI dispatch still has today
// for an unrecognised binding.
//
// Every proposed action requires an explicit Go before it runs (workshop-
// output/FEATURE_SPEC.md — a live-mixing tool has no "high confidence"
// tier that skips confirmation). An unconfirmed proposal expires on its
// own rather than sitting stale forever, with a visible notice that it
// was cancelled — never a silent disappearance.
//
// `activeAiProvider` is the one place phase 2 (the real local WebGPU/WASM
// model, `platform/ai-local/`) swaps in for the mock — nothing else in
// this section changes when that happens. Flipped 09/09 once `ai-local`
// existed; **not** verified end-to-end against a real model in this
// session (the container's network policy blocks the model host) — see
// `platform/ai-local/index.ts`'s own doc comment and `HANDOFF.md`.
// `mockAiProvider` stays imported and exported from `platform/ai-mock` for
// `tests/core/ai-translate.test.ts`, which deliberately keeps testing
// against it rather than a non-deterministic real model.
// ————————————————————————————————————————————————————————————————

const activeAiProvider = aiLocalProvider
let aiModelLoaded = false

/**
 * How long an unconfirmed AI proposal stays on screen before it auto-cancels.
 * Tunable here, not in Settings (CLAUDE.md v0.2.5 — a calibration constant,
 * not a preference). Was 8000 through phase 1, tuned against the instant,
 * deterministic mock provider — fine when `confirm` appears the moment
 * someone presses Enter, because their attention is already on the screen.
 * Against the real local model (phase 2, slow, CPU-only) `thinking` itself
 * can run several seconds first, so by the time `confirm` actually renders
 * the person has drifted; Shalom's real machine (09/09) hit exactly this —
 * a correct proposal ("Play deck A") expired before he reacted to it
 * appearing. 20000 gives real reaction time without being unreasonable.
 */
const AI_PROPOSAL_EXPIRY_MS = 20000

let aiAutoIdleTimer: ReturnType<typeof setTimeout> | null = null

function clearAiAutoIdle() {
  if (aiAutoIdleTimer != null) {
    clearTimeout(aiAutoIdleTimer)
    aiAutoIdleTimer = null
  }
}

/** Returns to idle on its own after `AI_PROPOSAL_EXPIRY_MS` — `withNotice` distinguishes "an actionable proposal went stale" (needs telling) from "a clarify/decline message's own text already said what happened" (doesn't). */
function scheduleAiAutoIdle(withNotice: boolean) {
  clearAiAutoIdle()
  aiAutoIdleTimer = setTimeout(() => {
    aiAutoIdleTimer = null
    const { patchAi, setNotice } = useStore.getState()
    patchAi({ phase: 'idle', proposal: null, clarifyQuestion: null, declineReason: null })
    if (withNotice) {
      setNotice({ text: 'AI proposal expired — nothing was done.', tone: 'warn', source: 'ai' })
    }
  }, AI_PROPOSAL_EXPIRY_MS)
}

function describeAiProposal(call: AIToolCall): string {
  const a = call.args as Record<string, unknown>
  switch (call.name) {
    case 'play':
      return `Play deck ${a.deck}`
    case 'pause':
      return `Pause deck ${a.deck}`
    case 'loop':
      return `Loop ${a.beats} beats, deck ${a.deck}`
    case 'jumpToHotCue':
      return `Jump to cue ${Number(a.index) + 1}, deck ${a.deck}`
    case 'syncDeck':
      return `Sync deck ${a.deck}`
    case 'tapTempo':
      return `Tap tempo, deck ${a.deck}`
    case 'setTempo':
      return `Nudge tempo fader to ${a.amount}, deck ${a.deck}`
    case 'setFilter':
      return `Filter ${a.amount}, deck ${a.deck}`
    case 'setCrossfader':
      return `Crossfader to ${a.position}`
    case 'setChannelVolume':
      return `Volume ${a.level}, deck ${a.deck}`
    case 'setEq':
      return `EQ ${a.band} ${a.amount}, deck ${a.deck}`
    default:
      return call.name
  }
}

/** Runs the real `controls.ts` function a validated tool call names — the only place an AI-sourced call turns into an actual action. */
function runAiToolCall(call: AIToolCall) {
  const a = call.args as Record<string, unknown>
  switch (call.name) {
    case 'play':
      play(a.deck as DeckId)
      break
    case 'pause':
      pause(a.deck as DeckId)
      break
    case 'loop':
      pressLoopPad(a.deck as DeckId, a.beats as number)
      break
    case 'jumpToHotCue':
      pressHotCue(a.deck as DeckId, a.index as number)
      break
    case 'syncDeck':
      syncDeck(a.deck as DeckId)
      break
    case 'tapTempo':
      tapTempo(a.deck as DeckId)
      break
    case 'setTempo':
      setTempo(a.deck as DeckId, a.amount as number)
      break
    case 'setFilter':
      setFilter(a.deck as DeckId, a.amount as number)
      break
    case 'setCrossfader':
      setCrossfader(a.position as number)
      break
    case 'setChannelVolume':
      setChannelVolume(a.deck as DeckId, a.level as number)
      break
    case 'setEq':
      setEq(a.deck as DeckId, a.band as 'low' | 'mid' | 'high', a.amount as number)
      break
  }
}

/**
 * Turns the natural-language feature on or off. Off by default — dark
 * launch, no effect on anything else while off. Turning it on shows the
 * one-time "this can be slow, and sometimes won't answer at all" warning
 * first (`first-run-warning`, once per browser — `warningAck.ts`) unless
 * already acknowledged, in which case it starts the model load right away
 * (not lazily on first command) so the loading state has its own visible
 * phase instead of hiding inside `thinking` the first time someone
 * actually types something.
 */
export function toggleAiControl(on: boolean) {
  clearAiAutoIdle()
  const { patchAi } = useStore.getState()
  patchAi({
    enabled: on,
    phase: 'idle',
    input: '',
    proposal: null,
    clarifyQuestion: null,
    declineReason: null,
    loadProgressPct: null,
    loadError: null,
  })
  if (!on) return
  void hasAcknowledgedAiWarning().then((acknowledged) => {
    if (!useStore.getState().ai.enabled) return // turned back off while this was in flight
    if (acknowledged) void ensureAiModelLoaded()
    else useStore.getState().patchAi({ phase: 'first-run-warning' })
  })
}

/** The one-time warning's "I understand, try it" button — starts the model load it was blocking. */
export function acknowledgeAiWarning() {
  void acknowledgeAiWarning_idb().then(() => void ensureAiModelLoaded())
}

/**
 * Runs the active provider's `load()` once (providers with nothing to load
 * — BYO-key, self-hosted — simply omit it, so this is a no-op for them).
 * A failure lands in `model-error` with the real reason shown, never a
 * silent "AI just doesn't respond" — the failure this container's own
 * blocked network policy actually produces (see `HANDOFF.md`) is exactly
 * the case this exists to surface, not paper over.
 */
async function ensureAiModelLoaded(): Promise<boolean> {
  if (aiModelLoaded) return true
  if (!activeAiProvider.load) {
    aiModelLoaded = true
    return true
  }
  const { patchAi } = useStore.getState()
  patchAi({ phase: 'model-loading', loadProgressPct: 0, loadError: null })
  try {
    await activeAiProvider.load((pct) => useStore.getState().patchAi({ loadProgressPct: pct }))
    aiModelLoaded = true
    // Only return to idle if nothing else (a command typed while loading) has already moved the phase on.
    if (useStore.getState().ai.phase === 'model-loading') patchAi({ phase: 'idle', loadProgressPct: null })
    return true
  } catch (err) {
    patchAi({ phase: 'model-error', loadError: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** Live-updates the input box and puts the bar in `typing` state — no AI call yet, that only happens on submit. */
export function setAiInput(text: string) {
  const { ai, patchAi } = useStore.getState()
  patchAi({ input: text, phase: text.trim() && ai.phase === 'idle' ? 'typing' : ai.phase })
}

/**
 * The choke-point entry for a natural-language command: builds the
 * request, calls the active `AIProvider`, validates whatever it returns,
 * and lands on `confirm` (a real action, awaiting Go), `clarify` (the
 * model asked a question instead of guessing) or `decline` (the request
 * needs a capability that doesn't exist yet) — never runs anything by
 * itself.
 */
export async function submitAiCommand(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return
  const { patchAi, setNotice } = useStore.getState()
  clearAiAutoIdle()

  if (!(await ensureAiModelLoaded())) return // already left in `model-error`, with the real reason shown

  patchAi({ phase: 'thinking', input: trimmed })

  const msgs: AIMessage[] = [{ role: 'user', content: trimmed }]
  let call: AIToolCall | null = null
  try {
    for await (const chunk of activeAiProvider.chat(msgs, AI_TOOL_CATALOG)) {
      if (chunk.kind === 'toolCall') call = chunk.call
    }
  } catch (err) {
    setNotice({
      text: `AI failed to respond: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'ai',
    })
    patchAi({ phase: 'idle' })
    return
  }

  if (!call) {
    setNotice({ text: 'AI did not return an action.', tone: 'warn', source: 'ai' })
    patchAi({ phase: 'idle' })
    return
  }

  const result = validateToolCall(call)
  if (!result.ok) {
    setNotice({ text: `AI proposed an unrecognized action — ignored (${result.reason}).`, tone: 'warn', source: 'ai' })
    patchAi({ phase: 'idle' })
    return
  }

  if (call.name === 'clarify') {
    const args = call.args as { question: string }
    patchAi({ phase: 'clarify', clarifyQuestion: args.question, proposal: null })
    // Unlike decline, a clarify question is an open, unanswered state — letting
    // it vanish with no notice would be the same silent-drop the expiry notice
    // on `confirm` already exists to prevent, just one step earlier.
    scheduleAiAutoIdle(true)
    return
  }
  if (call.name === 'decline') {
    const args = call.args as { reason: string }
    patchAi({ phase: 'decline', declineReason: args.reason, proposal: null })
    scheduleAiAutoIdle(false)
    return
  }

  const deck = (call.args as { deck?: DeckId }).deck
  patchAi({ phase: 'confirm', proposal: { summary: describeAiProposal(call), deckId: deck, call } })
  scheduleAiAutoIdle(true)
}

/** Go: runs the proposed action exactly as if it had been pressed on screen or on the controller. */
export function confirmAiProposal() {
  clearAiAutoIdle()
  const { ai, patchAi } = useStore.getState()
  const proposal = ai.proposal
  patchAi({ phase: 'idle', proposal: null, input: '' })
  if (proposal) runAiToolCall(proposal.call)
}

/** Cancel: the user's own explicit dismissal needs no notice — pressing Cancel already is the visible action. */
export function cancelAiProposal() {
  clearAiAutoIdle()
  useStore.getState().patchAi({ phase: 'idle', proposal: null, clarifyQuestion: null, declineReason: null, input: '' })
}

