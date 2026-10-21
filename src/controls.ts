import { audibleEndSec, songEndSec } from '@/core/audible-end'
import { mixEntryVerdict } from '@/core/mix-entry-target'
import { pcmFromAudioBuffer } from '@/platform/analyzer-js/analyze'
import { isPremiumUnlocked } from '@/core/premium'
import { PREDECODE_DWELL_MS } from '@/core/predecode'
import { clearPredecoded, setPredecodeStatus, slotOccupied, takePredecoded } from '@/platform/audio-webaudio/predecode-slot'
import { predecodeKeyFor, predecodeTrack } from '@/platform/source-fsaccess/predecode'
import { clipSpectrogram, type Spectrogram } from '@/core/sound/spectrogram'
import { detectVocalTimeline } from '@/core/sound/vocal-presence'
import { kickEnvelope } from '@/platform/analyzer-js/beat'
import { deckTrackNeeds } from '@/core/analysis-order'
import { barOneApplies, chooseBarGrid, detectBarOne } from '@/core/downbeat'
import { analysisCache, getAllDetectedGrids } from '@/platform/analyze-cache-idb/store'
import { analyzerWorker } from '@/platform/analyzer-worker'
import { engine } from '@/platform/audio-webaudio/engine'
import { KickMeter } from '@/platform/audio-webaudio/kick-meter'
import { KICK_GAP_WARN_MS } from '@/core/kick-gap'
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
import { saveSetHistoryText, saveTagsJson } from '@/platform/history-export-fsaccess/writer'
import {
  BEATGRID_NUDGE_SEC,
  HOT_CUE_COLORS,
  RECENTLY_REMOVED_WINDOW_SEC,
  syncTempoFor,
  centreBpm,
  speedPercent,
  deckRate,
  halfDoubleMultiplier,
  syncMultiplier,
  tempoToRate,
  TRANSITION_CROSSFADE_SEC,
} from '@/core/constants'
import { beatJumpTargetSec, loopRollReturnSec, LOOP_BEATS_STEPS } from '@/core/padmodes'
import {
  bpmFromTaps,
  doubleGrid,
  barLineCrossed,
  BEATS_PER_BAR,
  halveGrid,
  phaseDeltaSec,
  quantizeToGrid,
  setDownbeatAt,
  shiftGrid,
} from '@/core/beatgrid'
import { exitWaitStatus, phaseAlignedEntrySec } from '@/core/transition'
import { catchUpFactor, kickLockStep, KICK_LOCK_MAX_BARS, KICK_LOCK_SEC, KICK_LOCK_SETTLE_SEC, KICK_LOCK_KEEP_START_SEC, KICK_LOCK_NUDGE_SEC, KICK_LOCK_PLAIN_SHIFT_BARS } from '@/core/kick-lock'
import { AUTO_MIX_CROSSFADER_CURVE, eqMixFrame, incomingUnderA, plainEqMixPlan, type BassSwapStyle, type EqBand, type EqBands, type EqMixPlan } from '@/core/eq-mix'
import { joinWithoutCut, riseCutByQuietEntry } from '@/core/rise-guard'
import { HANDOFF_NEEDS_STRAIGHT_SYNC, MIN_BARS_AFTER_MIX, enoughSongAfterMix, firstVoiceInSec, handoffSide, nextPhraseStartSec, planHandoff, plainMixEndInB, type BVoiceStart, type HandoffPlan, type HandoffSide } from '@/core/vocal-handoff'
import { SWAP_CROSSFADER_CURVE, planVocalSwap, swapIncoming, vocalSwapFrame, type SwapEntry, type VocalSwapPlan } from '@/core/vocal-swap-mix'
import { analyzeEnergyProfile, findTransitionCandidates, resolveExitPointSec } from '@/core/structure'
import { setGenreOverrideByHash } from '@/platform/genre-overrides-idb/store'
import { MIN_REGION_SEC, barLineAtOrBeforeSec, closeOpenMark, drawnBarGrid, moveRegionEdge, undoLastEnd, type VocalManualTag } from '@/core/sound/vocal-manual'
import { deleteVocalManual, getAllVocalManual, getVocalManual, putVocalManual } from '@/platform/vocal-manual-idb/store'
import { deleteVocalStrip } from '@/platform/vocal-strip-idb/store'
import {
  addSampleRegion,
  addSuggestionRegion,
  createBandFrames,
  fillBandFrames,
  parseSampleMarksFile,
  rankCandidates,
  removeLastSample,
  sampleMarksExportText,
  type BandFrames,
  type SampleCandidate,
  type SampleKind,
  type SampleMarkTag,
} from '@/core/sound/sample-marks'
import { deleteSampleMarks, getAllSampleMarks, getSampleMarks, putSampleMarks } from '@/platform/sample-marks-idb/store'
import { parseVocalMarksFile, vocalMarksExportText } from '@/core/sound/vocal-manual-file'
import { pickJsonFileText } from '@/platform/vocal-marks-file-fsaccess/reader'
import {
  setLastPlayed as persistLastPlayedByHash,
  setTrackNote as persistTrackNoteByHash,
  setOwnerArtist,
  setOwnerTempoKey,
  getPlayRate,
  rememberPlayRatePath,
  setPlayRate,
} from '@/platform/track-meta-idb/store'
import {
  deleteCrateRecord,
  saveCrate,
  type CrateRecord,
} from '@/platform/crates-idb/store'
import { matchesColumnFilters, normalizeFilter, type ColumnFilters, type FilterColumn } from '@/core/library-filter'
import { matchesSearch, type SearchColumn } from '@/core/library-search'
import { sortTracks } from '@/core/library-sort'
import { getCues, putCues } from '@/platform/cues-idb/store'
import { clearTempo, getTempo } from '@/platform/tempo-idb/store'
import { getAllGridCorrections, getGridCorrection, putGridCorrection } from '@/platform/grid-corrections-idb/store'
import { compareGrid, gridCheckExportText, type DriftRow } from '@/core/grid-drift'
import { barLineAtNearestBeat, checkStartSec, nextInQueue, queueOrder, queueRemaining } from '@/core/bar-one-queue'
import { ownerCorrection, reconcileSavedGrid, resolveGridCorrection } from '@/core/grid-corrections'
import { getExcellentPoints, markExcellent } from '@/platform/mix-ratings-idb/store'
import { markExcellentPair, removeExcellentNear } from '@/platform/mix-pairs-idb/store'
import { clearBadMixes, markBadMix } from '@/platform/mix-bad-idb/store'
import { SAME_BAD_WINDOW_SEC } from '@/core/bad-mixes'
import { clock } from '@/platform/clock-audio'
import { analyseDeckTrackNow, inBackgroundPass, readOriginalTempoKey, readTagBpm, readTrackData } from '@/platform/source-fsaccess/library'
import { analysisCacheKey } from '@/core/analysis-cache'
import { detectedKeyFields } from '@/core/key-detect'
import { applyOwnerMeta, clearOwnerMeta, fillDetectedKey, labelAgrees, withLatestKey } from '@/core/tag-merge'
import type { ParsedKey } from '@/core/key-parse'
import { hashBytes, hashFile } from '@/platform/source-fsaccess/hash'
import { settings } from '@/platform/settings-idb/store'
import { DEFAULTS, FIELD_BY_KEY, secPerRev, type Settings } from '@/core/settings'
import { heardSemitones, KEY_SYNC_AUTO_MAX_SEMITONES, KEY_SYNC_MAX_SEMITONES, planKeySync, shiftCamelot } from '@/core/key-sync'
import { GLIDE_BACK_SEC, glideTempoAt, masterHasGone } from '@/core/tempo-glide'
import {
  MARK_SCHEMA,
  PLAY_BARS,
  PLAY_LEAD_BARS,
  VOCAL_CLIP_SEC,
  VOCAL_MARKS_SCHEMA,
  VOCAL_REVIEW_SCHEMA,
  VOCAL_SCHEMA,
  dropSpots,
  startGrid,
  startMarkSec,
  tagsExportText,
  vocalSpotsSec,
  type MarkAnswer,
  type MarkTag,
  type ReviewClip,
  type SampleEntry,
  type VocalMarksTag,
  type VocalAnswer,
  type VocalPick,
  vocalRound2Clips,
  vocalExtraSpotsSec,
} from '@/core/tagging'
import { getAllTags, putDecideTag, putFreshTag, putMarkTag, putVocalMarksTag, putVocalReviewTag, putVocalTag, type AllTags } from '@/platform/tagging-idb/store'
import { TagPlayer } from '@/platform/audio-webaudio/tag-player'
import {
  hasMixEntryNear,
  isOrdinalLabel,
  mixEntryLabel,
  moveHotCue as moveHotCuePure,
  pickHotCueSlot,
  shouldTriggerMixEntry,
} from '@/core/hotcues'
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
import { getLibraryExpanded, saveLibraryExpanded } from '@/platform/layout-idb/store'
import { pressFlash } from '@/app/state/flash'
import { REVEAL_SELECTION_EVENT } from '@/core/reveal-row'
import { useStore, type AppState, type FxState } from '@/app/state/store'
import type { AIMessage, AIToolCall } from '@/core/ports/ai'
import type { ArtistOption } from '@/core/artist-suggest'
import { canLookUp, lookupTerm, onlineOptions } from '@/core/online-artist'
import { itunesLookup } from '@/platform/artist-lookup-itunes/lookup'
import type { BeatGrid, BpmOrigin, DeckId, PadMode, Track } from '@/core/types'
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
  // v0.9.66: off frees the slot at once (80–230 MB); on starts from the row already selected.
  if (prev.predecodeNext && !v.predecodeNext) {
    predecodeWanted = null
    if (predecodeTimer) clearTimeout(predecodeTimer)
    predecodeTimer = null
    clearPredecoded()
  } else if (!prev.predecodeNext && v.predecodeNext) {
    // An old "not decoded ahead" from before it was switched off is about a song the owner may have left long ago.
    setPredecodeStatus({ state: 'idle' })
    schedulePredecode()
  }
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
  // The glide belongs to the track that was synced in, not to the deck — a new
  // track landing mid-glide would otherwise be dragged toward the old one's speed.
  cancelTempoGlide(deckId)
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
  // v0.9.61: where a deck load spends its time, read by scripts/measure-speed.mjs from `performance.getEntriesByType('mark')`.
  // Marks only: nothing on screen, and a few bytes per load. Measured 08/10 on the owner's PC: 9 s to load B while the
  // background passes ran, 2 s after they finished; this says which step waits.
  const loadMark = (step: string, detail?: object) => performance.mark(`deckload:${deckId}:${step}`, { detail })
  {
    const lib = useStore.getState().library
    loadMark('start', { hashesRead: lib.hashesRead, analysing: lib.tracks.filter((t) => t.analysisState === 'analyzing').length })
  }
  let buffer: AudioBuffer
  let contentHash: string | undefined
  try {
    // v0.9.66: the song may already be decoded (Settings › Decode the next song ahead). Same file, unchanged, same sample rate, or this
    // is a miss and everything below runs as it always did.
    const ahead = slotOccupied() ? takePredecoded(await predecodeKeyFor(track)) : null
    if (ahead) {
      buffer = ahead.buffer
      contentHash = ahead.contentHash
      loadMark('read')
      loadMark('hash')
      loadMark('decode', { predecoded: true })
    } else {
      const data = await readTrackData(track)
      loadMark('read')
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
      loadMark('hash')
      buffer = await engine.decode(data)
      loadMark('decode')
    }
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
  // The fader always starts in the middle (20/09: a new track showing the old one's offset never showed its own BPM). Since v0.9.47 the
  // middle is the speed saved for this track ("Save tempo"), else the file's own.
  // `null`: no identity (the hash failed) or the store could not be read. Then the row's own copy, merged at scan time, is used — the row
  // said 138, so the deck must not quietly play 150 — and either way it is said on screen below.
  const savedRate = contentHash ? await loadPlayRate(contentHash, track.id) : null
  const rowCopy = useStore.getState().library.tracks.find((t) => t.id === track.id)?.playRate ?? track.playRate ?? null
  const baseRate = savedRate ?? rowCopy ?? 1
  const rateUnread = savedRate == null && (contentHash != null || rowCopy != null)
  // The row says what the deck plays: a carried-over speed, or one the library's analysis pass has not merged yet, lands on it now.
  if (contentHash && savedRate != null) {
    const lib = useStore.getState().library
    const rowRate = baseRate === 1 ? null : baseRate
    // by id too: a row that took its speed from the path (v0.9.48) has no hash yet, and may hold another file's guess
    const mine = (t: Track) => t.contentHash === contentHash || t.id === track.id
    if (lib.tracks.some((t) => mine(t) && (t.playRate ?? null) !== rowRate)) {
      useStore.getState().setLibrary({ tracks: lib.tracks.map((t) => (mine(t) ? withPlayRate(t, rowRate) : t)) })
    }
  }
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
  // Again, not only at the top: the awaits above leave a window where the old
  // track, still synced and playing, can have a glide started on it — which
  // would then drag this new track from the old one's tempo (v0.8.39 review).
  cancelTempoGlide(deckId)
  engine.decks[deckId].setTempo(0)
  engine.decks[deckId].setBaseRate(baseRate)
  // The key lock stays on across loads; a key sync move does not — it was planned for the last song. Left in the engine, the new song
  // played shifted under a button that read "Key sync" (independent review, 05/10).
  engine.decks[deckId].setKeyShift(0)
  if (startSec > 0) engine.decks[deckId].seek(startSec)
  patchDeck(deckId, {
    track: { ...track, contentHash, bpm: track.bpm ?? undefined, durationSec },
    loading: false,
    playing: false,
    positionSec: startSec,
    durationSec,
    audibleEndSec: audibleEndSec(pcmFromAudioBuffer(buffer).channels, buffer.sampleRate, durationSec),
    bpm: track.bpm ?? null,
    beatGrid: null,
    beatGridConfirmed: false,
    barOneUnsure: false,
    bpmOrigin: null,
    syncActive: false,
    peaks: null,
    bands: null,
    tempo: 0,
    baseRate,
    tempoByHand: false,
    hotCues,
    cuePointSec,
    excellentMixPoints,
    loopActive: false,
    loopRange: null,
    keySyncShift: null,
  })
  loadMark('ready')
  pressFlash(`deck:${deckId}`)
  // Never silent (v0.9.46): a track that starts off its own speed says so, and says it is his saved choice.
  // Never over a warning already on screen — the first load once wiped the "audio device not connected" one (see the clearNotice above).
  const shown = useStore.getState().notice
  // Over a library warning too: a store that cannot be read also fails the "last played" stamp just before, and the speed heard matters more.
  if (rateUnread && (!shown || shown.tone === 'info' || shown.source === 'load' || shown.source === 'tempo' || shown.source === 'library')) {
    setNotice({
      text:
        rowCopy != null
          ? `The saved speed for "${track.title ?? track.name}" could not be read fresh — it plays at the one the list shows (${speedPercent(rowCopy)} of the file).`
          : `The saved speed for "${track.title ?? track.name}" could not be read — it plays at the file's own speed.`,
      tone: 'warn',
      source: 'tempo',
    })
  } else if (Math.abs(baseRate - 1) > 1e-4 && (!shown || shown.tone === 'info' || shown.source === 'load' || shown.source === 'tempo')) {
    setNotice({
      text: `"${track.title ?? track.name}" plays at the speed you saved for it (${speedPercent(baseRate)} of the file${track.bpm ? `, ${Number(centreBpm(track.bpm, baseRate).toFixed(1))} BPM` : ''}).`,
      tone: 'info',
      source: 'tempo',
    })
  }
  void onTrackLoadedForVocalMarks(deckId, contentHash)
  void onTrackLoadedForSampleMarks(deckId, contentHash, buffer)
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
  // The kick envelope for the "1" (v0.9.5) — read now, while `buffer` is
  // whole: the analysis below may transfer its channels to the worker.
  // Best-effort like the analysis: without it the grid keeps its first-beat "1", marked unsure.
  let kick: ReturnType<typeof kickEnvelope> | null = null
  try {
    kick = kickEnvelope(pcmFromAudioBuffer(buffer))
  } catch (err) {
    console.error('kick envelope failed', err)
  }
  deckAnalysisPending[deckId] = track.id
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

    // A BPM tag in the file still beats our own bpm guess — v0.1.7 measured
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
    const tagAgrees = labelAgrees(track, detectedBpm)
    const bpm = tagAgrees ? detectedBpm : (track.bpm ?? analysis.bpm)
    const detectedGrid: BeatGrid | null = analysis.beatGrid
      ? { bpm: bpm ?? analysis.beatGrid.bpm, offsetSec: analysis.beatGrid.offsetSec }
      : null
    // A grid the owner fixed by hand (v0.8.23) beats anything detection says,
    // bpm included: it is the one answer here a person checked.
    const saved = contentHash ? await loadGridCorrection(contentHash) : null
    if (useStore.getState().decks[deckId].track?.id !== track.id) return
    const savedGrid = saved && 'grid' in saved ? saved.grid : null
    const atLoad = savedGridAtLoad(deckId, track.id, saved, { tag: hintBpm, detected: detectedBpm })
    const corrected = atLoad?.grid ?? null
    // Which beat is the "1" (v0.9.5) — the rules, and why an unsure answer
    // still moves the grid, are in core/downbeat.ts.
    const barOne =
      !corrected && kick && analysis.beatGrid && barOneApplies(detectedGrid, analysis.beatGrid)
        ? detectBarOne(kick.low, kick.framesPerSec, analysis.beatGrid)
        : null
    const { beatGrid, barOneUnsure } = chooseBarGrid(detectedGrid, barOne, corrected)
    const deckBpm = corrected ? corrected.bpm : bpm
    // A key tag always wins (v0.8.27); this only fills a track that has none.
    const detectedKey = analysis.key ? detectedKeyFields(analysis.key) : {}
    patchDeck(deckId, {
      track: fillDetectedKey(
        withLatestKey(
          { ...track, contentHash, analysisState: 'analyzed', bpm: deckBpm ?? undefined, durationSec },
          useStore.getState().library.tracks.find((t) => t.id === track.id),
        ),
        detectedKey,
      ),
      bpm: deckBpm,
      bpmOrigin: bpmOriginOf({ row: useStore.getState().library.tracks.find((t) => t.id === track.id) ?? track, tagBpm: hintBpm, detectedBpm, savedBpm: savedGrid?.bpm ?? null, recountedTo: atLoad?.recountedTo ?? null, tagAgrees }),
      // Unconfirmed whenever detection didn't produce a grid it trusts — never
      // a silently-assumed-fine grid. Cleared only by the user checking or
      // editing it (BeatGridPanel, v0.3.0 sub-step d), or by a saved edit.
      beatGridConfirmed: corrected ? true : analysis.beatGridConfirmed,
      barOneUnsure,
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
        t.id === track.id
          ? fillDetectedKey(
              // The owner's typed BPM stays what the row shows (v0.8.38): the deck
              // still plays the refined tempo (the 2% rule above), but a row that
              // said 125 when he typed 125 and then read 124.93 after a load
              // would look like his edit had been quietly changed.
              { ...t, contentHash, analysisState: 'analyzed', bpm: t.bpmSource === 'owner' ? t.bpm : (deckBpm ?? t.bpm) },
              detectedKey,
            )
          : t,
      ),
    })
    jumpDeckTrackQueue(track.id)
  } catch (err) {
    console.error('analysis failed', err)
    if (useStore.getState().decks[deckId].track?.id !== track.id) return
    const message = err instanceof Error ? err.message : String(err)
    // The owner's saved grid needs no analysis to draw (v0.8.23) — without
    // this, a failed analysis hid a correction that was sitting in storage.
    const saved = contentHash ? await loadGridCorrection(contentHash) : null
    if (useStore.getState().decks[deckId].track?.id !== track.id) return
    // No analysis to read a tag or a detection from: the row's BPM (a tag, or the last analysis) is the label left.
    const atLoad = savedGridAtLoad(deckId, track.id, saved, { tag: track.bpm ?? null, detected: null })
    const corrected = atLoad?.grid ?? null
    patchDeck(deckId, {
      track: { ...track, contentHash, analysisState: 'failed', analysisError: message, durationSec },
      ...(corrected ? { beatGrid: corrected, bpm: corrected.bpm, beatGridConfirmed: true } : {}),
      bpmOrigin: bpmOriginOf({
        row: useStore.getState().library.tracks.find((t) => t.id === track.id) ?? track,
        tagBpm: track.bpm ?? null,
        detectedBpm: null,
        savedBpm: saved && 'grid' in saved ? saved.grid.bpm : null,
        recountedTo: atLoad?.recountedTo ?? null,
        tagAgrees: false,
      }),
    })
    const { library: libAfter, setLibrary: setLibAfter } = useStore.getState()
    setLibAfter({
      tracks: libAfter.tracks.map((t) =>
        t.id === track.id ? { ...t, contentHash, analysisState: 'failed', analysisError: message } : t,
      ),
    })
  } finally {
    if (deckAnalysisPending[deckId] === track.id) deckAnalysisPending[deckId] = null
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
      text: `Deck ${target} already has a track loaded — eject it (⏏ next to its time) before loading a suggestion there.`,
      tone: 'warn',
      source: 'load',
    })
    return
  }
  void loadTrackToDeck(target, track)
}

/**
 * v0.8.17: empty a deck. Until now nothing could — two notices told the
 * owner to "unload" a deck, and the only way was reloading the page.
 *
 * Refuses a playing deck, a deck mid-load, and either deck of a running
 * transition, each with a notice: ejecting any of those cuts live audio or
 * pulls a buffer out from under something still using it. What belongs to
 * the *track* is cleared (grid, cues, waveform, loop); what belongs to the
 * *deck* stays (tempo fader, vinyl mode, pad mode, loop length), since the
 * next track goes into the same physical deck.
 */
export function ejectDeck(deckId: DeckId) {
  const { decks, setNotice, patchDeck, masterDeckId } = useStore.getState()
  const st = decks[deckId]
  if (!st.track) return
  const refuse = (text: string) => setNotice({ text, tone: 'warn', source: 'load' })
  if (st.playing) return refuse(`Deck ${deckId} is playing — pause it before ejecting.`)
  if (st.loading) return refuse(`Deck ${deckId} is still loading — try again in a moment.`)
  if (activeTransition && (activeTransition.fromDeckId === deckId || activeTransition.toDeckId === deckId)) {
    return refuse(`Deck ${deckId} is part of a running transition — cancel it before ejecting.`)
  }
  // Same "just left a deck" treatment `loadTrackToDeck` gives a replaced
  // track, so it doesn't pop straight back up as a suggestion.
  markRecentlyRemoved(st.track.id)
  const deck = engine.decks[deckId]
  stopLoop(deckId)
  deck.unload()
  deck.setKeyShift(0)
  // the saved speed is the track's, not the deck's: the next track brings its own
  deck.setBaseRate(1)
  patchDeck(deckId, {
    track: null,
    keySyncShift: null,
    positionSec: 0,
    durationSec: 0,
    audibleEndSec: 0,
    bpm: null,
    beatGrid: null,
    beatGridConfirmed: true,
    barOneUnsure: false,
    bpmOrigin: null,
    syncActive: false,
    peaks: null,
    bands: null,
    hotCues: [],
    cuePointSec: 0,
    loopActive: false,
    loopRange: null,
    scratching: false,
    excellentMixPoints: [],
    baseRate: 1,
  })
  // A master with no track is a reference to nothing. The other deck's SYNC
  // is switched off with it: left lit, it would claim a lock it no longer
  // has, then start nudging toward whatever gets loaded here next.
  if (masterDeckId === deckId) {
    useStore.setState({ masterDeckId: null })
    const other: DeckId = deckId === 'A' ? 'B' : 'A'
    if (decks[other].syncActive) patchDeck(other, { syncActive: false })
  }
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
 * Shalom's explicit call (22/09): starts on click (since 23/09, on the
 * outgoing deck's next yellow line — `startAutoTransition`), no waiting for
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
  toHash: string,
  entrySec: number,
  exitSec: number | undefined,
) {
  const target: DeckId = fromDeckId === 'A' ? 'B' : 'A'
  const { decks, setNotice } = useStore.getState()
  // v0.8.16: past the remembered second, Shalom chose "do nothing" — checked
  // before loading too, so a refused mix doesn't leave a track sitting on
  // the other deck. `startAutoTransition` checks again after the load.
  const fromGrid = decks[fromDeckId].beatGrid
  if (
    exitSec != null &&
    fromGrid &&
    exitWaitStatus(engine.decks[fromDeckId].position, exitSec, barSecOf(fromGrid)) === 'passed'
  ) {
    setNotice({ text: passedExitText(fromDeckId, exitSec), tone: 'warn', source: 'mixRating' })
    return
  }
  // v0.9.26: checked before the load too, so a pair that can only be refused does not leave its track on the other deck. Leniently: the
  // library's BPM is the tag's (or the owner's), which can be half the grid's — read as is, it would double the bars and refuse a pair the
  // deck accepts. So double it (and 240 with none): this one refuses only what no reading saves. The real rule is the check after the load.
  // (The file's length, not the song's end: the end is measured at load. The check after the load below uses it and is the real one.)
  if (refuseTooLateEntry(target, entrySec, toTrack.durationSec ?? 0, { bpm: toTrack.bpm ? toTrack.bpm * 2 : 240 }, 'mixRating')) return
  // v0.8.17 (Shalom): a loaded but idle track on the other deck is replaced —
  // it's a less-fitting pick, and the strip exists to swap in the better one.
  // A *playing* track is still refused: replacing it cuts live music.
  if (decks[target].playing) {
    setNotice({
      text: `Deck ${target} is playing — an excellent-match mix can't replace a track that's live. Pause it or let it finish first.`,
      tone: 'warn',
      source: 'mixRating',
    })
    return
  }
  if (decks[target].loading) {
    setNotice({
      text: `Deck ${target} is still loading a track — try again in a moment.`,
      tone: 'warn',
      source: 'mixRating',
    })
    return
  }
  // Already on the target deck (paused): reloading it would only re-decode
  // the same file and drop its cues-in-progress for nothing.
  const alreadyThere = !!toTrack.contentHash && decks[target].track?.contentHash === toTrack.contentHash
  if (!alreadyThere) await loadTrackToDeck(target, toTrack)
  // The strip can match a not-yet-identified track by its path (v0.8.17), so
  // the identity is only certain now that the load hashed it.
  const loadedHash = useStore.getState().decks[target].track?.contentHash
  if (loadedHash !== toHash) {
    useStore.getState().setNotice({
      text: loadedHash
        ? `${toTrack.title ?? toTrack.name} is not the same file that was rated Excellent (it changed or was replaced) — mix not started.`
        : `${toTrack.title ?? toTrack.name} couldn't be identified after loading — mix not started.`,
      tone: 'warn',
      source: 'mixRating',
    })
    return
  }
  if (useStore.getState().decks[fromDeckId].track?.contentHash !== fromHashAtClick) {
    useStore.getState().setNotice({
      text: `Deck ${fromDeckId} is playing a different track now — mix not started.`,
      tone: 'warn',
      source: 'mixRating',
    })
    return
  }
  const loaded = useStore.getState().decks[target]
  if (refuseTooLateEntry(target, entrySec, songEndSec(loaded.audibleEndSec, loaded.durationSec), loaded.beatGrid, 'mixRating')) return
  // A pair rated before v0.8.16 never saved where the outgoing deck was —
  // mixing on the next bar is the old behaviour, named rather than silent.
  const oldPairNote =
    exitSec == null
      ? 'This pair was saved before exit points were remembered — mixing on the next bar. Rate it Excellent again to save where it mixed.'
      : null
  // v0.12.13 (owner, 19/10): an excellent pair mixes where it was saved, singing or not — v0.9.63's move off A's voice is gone with its rule.
  startAutoTransition(fromDeckId, target, entrySec, exitSec ?? null, oldPairNote)
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
  const waiting = useStore.getState().activeTransition
  useStore.getState().setNotice({
    text: waiting?.waitingUntilSec != null
      ? `Deck ${deckId} is waiting to mix out at ${formatMinSec(waiting.waitingUntilSec)} — press CANCEL TRANSITION to stop it.`
      : waiting?.waitingForBar
      ? `Deck ${deckId} is about to mix out on its next bar line — press CANCEL TRANSITION to stop it.`
      : `Deck ${deckId} is fading out in a transition — press CANCEL TRANSITION to stop it, or wait for it to finish.`,
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
  if (wasIncomingDeckOfTransition) {
    // The Cancel button just vanished and the deck may still be silent (a
    // play press during the bar-line wait) — say what happened.
    useStore.getState().setNotice({ text: `Transition cancelled — deck ${deckId} was touched by hand.`, tone: 'info', source: 'sync' })
    return
  }
  if (!deck.playing) autoSyncOnPlay(deckId)
  deck.togglePlay()
  useStore.getState().patchDeck(deckId, { playing: deck.playing })
  if (deck.playing) maybeAutoMaster(deckId)
}

export function play(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack || deck.playing) return
  autoSyncOnPlay(deckId)
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

/**
 * Which deck's own analysis is still running, by track id. A grid set in
 * that window is built on the tag's rounded bpm and no detected phase; saved
 * as the owner's, it would then beat the real analysis on every later load,
 * marked as checked (v0.8.23 review). So those edits are refused, out loud.
 */
const deckAnalysisPending: Record<DeckId, string | null> = { A: null, B: null }

type SavedGridResult = { grid: BeatGrid; tempoByHand: boolean } | { problem: string } | null

/**
 * The owner's saved grid for this track. Reads only — the notice for a
 * record that can't be used is shown by `applySavedGridResult`, after the
 * caller has checked the deck still holds this track, so a warning never
 * lands on the next track instead.
 */
async function loadGridCorrection(contentHash: string): Promise<SavedGridResult> {
  try {
    const r = resolveGridCorrection(await getGridCorrection(contentHash))
    if (r == null) return null
    if ('refused' in r) return { problem: `Your saved beat grid was not used (${r.refused}) — showing the detected one.` }
    return r
  } catch (err) {
    return {
      problem: `Your saved beat grid could not be read — showing the detected one: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** The grid to use, or `null`; a record that couldn't be used is said on screen — never a silent fallback. */
function applySavedGridResult(r: SavedGridResult): BeatGrid | null {
  if (r == null) return null
  if ('problem' in r) {
    useStore.getState().setNotice({ text: r.problem, tone: 'warn', source: 'grid' })
    return null
  }
  return r.grid
}

/** Which source the deck's BPM came from at load, with what each one said — the grid panel shows it (`DeckState.bpmOrigin`). */
function bpmOriginOf(a: {
  row: Track
  tagBpm: number | null
  detectedBpm: number | null
  savedBpm: number | null
  recountedTo: BpmOrigin['recountedTo']
  tagAgrees: boolean
}): BpmOrigin {
  const owner = a.row.bpmSource === 'owner' ? (a.row.bpm ?? null) : null
  const from = a.savedBpm != null ? 'saved' : a.tagAgrees || a.row.bpm == null ? 'detected' : owner != null ? 'owner' : 'list'
  return { from, recountedTo: a.recountedTo, saved: a.savedBpm, owner, tag: a.tagBpm, detected: a.detectedBpm }
}

/**
 * Whether the saved grid now on each deck had its tempo set by hand (`GridCorrection.tempoByHand`). Read at load, set by ÷2/×2/Tap, and
 * written back with every later save from that deck — a nudge after a ÷2 must not quietly turn the ÷2 into "not by hand".
 */
const tempoByHandOnDeck: Record<DeckId, boolean> = { A: false, B: false }

/**
 * The saved grid to use at load, counted the way the track is labelled (v0.9.45, `reconcileSavedGrid`). The label is the BPM the owner
 * typed — read from the library's row, not the load's snapshot, since he can type one while the deck loads — else the file tag, else the
 * sound; none of them when the saved tempo was set by hand. Disagreeing with his typed number by more than an octave is said on screen; disagreeing
 * with a tag or a detection is not — there the grid he saved is the better answer, as it always was.
 */
function savedGridAtLoad(
  deckId: DeckId,
  trackId: string,
  r: SavedGridResult,
  label: { tag: number | null; detected: number | null },
): { grid: BeatGrid; recountedTo: BpmOrigin['recountedTo'] } | null {
  const grid = applySavedGridResult(r)
  tempoByHandOnDeck[deckId] = r != null && 'grid' in r && r.tempoByHand
  if (!grid) return null
  // A tempo he set by hand (÷2/×2/Tap) beats every label, his own typed number included: the press is the later, more direct answer.
  if (tempoByHandOnDeck[deckId]) return { grid, recountedTo: null }
  const row = useStore.getState().library.tracks.find((t) => t.id === trackId)
  const owner = row?.bpmSource === 'owner' && row.bpm ? row.bpm : null
  const labelFrom = owner != null ? 'owner' : label.tag != null ? 'tag' : label.detected != null ? 'detected' : null
  const labelBpm = owner ?? label.tag ?? label.detected
  if (!labelBpm || !labelFrom) return { grid, recountedTo: null }
  const out = reconcileSavedGrid(grid, labelBpm)
  if (out.outcome === 'differs' && owner != null) {
    useStore.getState().setNotice({
      text: `"${row?.title ?? row?.name}": you set ${Number(owner.toFixed(1))} BPM, but the beat grid you fixed says ${Number(grid.bpm.toFixed(1))} — the deck plays your grid. Click the deck's BPM to fix the grid.`,
      tone: 'warn',
      source: 'grid',
    })
  }
  return { grid: out.grid, recountedTo: out.outcome === 'recounted' ? labelFrom : null }
}

/**
 * Refuses a grid edit while this deck's analysis is still running (see
 * `deckAnalysisPending`), with a notice. True means "go ahead".
 */
function gridEditAllowed(deckId: DeckId): boolean {
  if (deckAnalysisPending[deckId] == null) return true
  useStore.getState().setNotice({
    text: `Deck ${deckId} is still analysing this track — edit the beat grid once it appears.`,
    tone: 'warn',
    source: 'grid',
  })
  return false
}

/** Every hand edit to a grid goes through here, so none of them is lost at the next load (v0.8.23). */
function persistGridCorrection(deckId: DeckId): Promise<boolean> {
  const { decks, setNotice } = useStore.getState()
  const st = decks[deckId]
  const hash = st.track?.contentHash
  if (!st.beatGrid) return Promise.resolve(false)
  // Any edit or check is the owner looking at the grid — the "1" is no longer a guess shown as one.
  if (st.barOneUnsure) useStore.getState().patchDeck(deckId, { barOneUnsure: false })
  // From here the deck's BPM is the grid he just saved; the other sources keep what they said.
  if (st.bpmOrigin) useStore.getState().patchDeck(deckId, { bpmOrigin: { ...st.bpmOrigin, from: 'saved', recountedTo: null, saved: st.beatGrid.bpm } })
  if (!hash) {
    setNotice({
      text: 'Beat grid changed on screen, but this track has no identity yet, so it will not be remembered.',
      tone: 'warn',
      source: 'grid',
    })
    return Promise.resolve(false)
  }
  return putGridCorrection(hash, ownerCorrection(st.beatGrid, Date.now(), tempoByHandOnDeck[deckId])).then(
    () => {
      markOwnerChecked(hash)
      return true
    },
    (err) => {
      setNotice({
        text: `Beat grid changed on screen but not saved: ${err instanceof Error ? err.message : String(err)}`,
        tone: 'warn',
        source: 'grid',
      })
      return false
    },
  )
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

/**
 * v0.9.20: key lock on one deck. The first press builds the stretch (`engine.ensureKeyLock`); when that fails the button stays off and the
 * notice says why — never a lit button over unchanged sound.
 */
let keyLockLoading = false
export async function toggleKeyLock(deckId: DeckId) {
  // A second press while the first one is still loading the stretch: `on` was read before the wait, so it would have ended "on" too.
  if (keyLockLoading) return
  const on = !engine.decks[deckId].keyLock
  if (on) {
    keyLockLoading = true
    const ok = await engine.ensureKeyLock().finally(() => (keyLockLoading = false))
    if (!ok) {
      useStore.getState().setNotice({ text: `Key lock is not available: ${engine.keyLockError ?? 'unknown reason'}.`, tone: 'warn', source: 'keylock' })
      return
    }
    useStore.getState().clearNotice('keylock')
  }
  engine.decks[deckId].setKeyLock(on)
  // Key sync rides on the key lock: with the stretch out of the path the move is not heard, so a lit "Key +2" would be a lie.
  useStore.getState().patchDeck(deckId, { keyLock: on })
  if (!on) clearKeySync(deckId)
}

/**
 * v0.9.21: key sync. Moves this deck by whole semitones (`planKeySync`, ±6 at most) to the nearest key that fits the other deck as it is
 * heard right now, turning the key lock on first — the move needs the stretch. Pressed again, it puts the deck back on its own key and
 * leaves the key lock as it is. Either deck without a song or a key: nothing moves and the notice names the deck.
 */
export async function toggleKeySync(deckId: DeckId) {
  if (useStore.getState().decks[deckId].keySyncShift != null) {
    clearKeySync(deckId)
    useStore.getState().clearNotice('keylock')
    return
  }
  const said = await keySync(deckId, KEY_SYNC_MAX_SEMITONES)
  if (said) useStore.getState().setNotice({ ...said, source: 'keylock' })
}

/**
 * v0.9.22: Mix Assist keys the incoming deck itself (the owner, 05/10: "I want this to happen automatically when I press Mix Assist").
 * Two semitones at most, or what Settings says (1, or off) — past that a voice starts to sound processed, and the owner asked first whether moving a key hurts the song;
 * a bigger gap leaves the song in its own key and says so. A key sync the owner already set on that deck is his and is left alone.
 * The key lock goes on even when no move is needed: SYNC is about to put B on A's tempo, and without it that alone moves B's pitch off
 * the key it was just matched on. The result joins the transition's own notice rather than replacing it (`notice` has one slot).
 */
async function autoKeySync(t: ActiveTransition, noticeBefore: AppState['notice']) {
  const deckId = t.toDeckId
  const max = Math.min(settings.values.mixAssistKeySync, KEY_SYNC_AUTO_MAX_SEMITONES)
  // Off in Settings: nothing moves, and nothing is said — the owner turned it off himself, the transition's own notice is unchanged.
  if (!(max > 0) || useStore.getState().decks[deckId].keySyncShift != null) return
  const lockWasOn = engine.decks[deckId].keyLock
  const said = await keySync(deckId, max, () =>
    activeTransition !== t
      ? 'המעבר לא רץ יותר, אז הסולם לא הותאם.'
      // The first key lock load finished after B came in: switching the stretch in now is a jump in a song already fading up.
      : engine.decks[deckId].playing
        ? 'Key lock נטען רק אחרי שהשיר נכנס, אז הסולם לא הותאם הפעם. במעבר הבא זה כבר יעבוד.'
        : null,
  )
  if (activeTransition === t && useStore.getState().decks[deckId].keySyncShift != null) t.autoKey = { lockWasOn }
  if (!said) return
  // Anything put up since the transition started is this transition's — its own warning, a cancel, a give-up — and gets the key result
  // added to it. What was up before is someone else's, and is replaced rather than mixed into.
  const { notice, setNotice } = useStore.getState()
  if (notice && notice !== noticeBefore) {
    setNotice({ text: `${notice.text} · ${said.text}`, tone: notice.tone === 'warn' || said.tone === 'warn' ? 'warn' : 'info', source: notice.source })
  } else setNotice({ ...said, source: 'keylock' })
}

/**
 * The move itself, for the button and for Mix Assist. The key lock goes on even at a move of 0, so the deck's own tempo — SYNC putting it
 * on the other deck's — cannot pull it off the key it was matched on. Returns what to tell the owner; null only when a notice is already up.
 */
async function keySync(deckId: DeckId, maxShift: number, stillWanted: () => string | null = () => null): Promise<{ text: string; tone: 'info' | 'warn' } | null> {
  const { decks } = useStore.getState()
  const otherId: DeckId = deckId === 'A' ? 'B' : 'A'
  const mine = decks[deckId].track
  const other = decks[otherId].track
  const empty = [!mine && deckId, !other && otherId].filter(Boolean)
  if (empty.length) {
    return { text: `Key sync צריך שיר בשני הדקים — ${empty.length === 2 ? 'שני הדקים ריקים' : `בדק ${empty[0]} אין שיר`}.`, tone: 'warn' }
  }
  const otherDeck = engine.decks[otherId]
  const otherRate = deckRate(decks[otherId].baseRate, decks[otherId].tempo, settings.values.tempoRange)
  const plan = planKeySync(mine!.camelot, other!.camelot, heardSemitones(otherRate, otherDeck.keyLock, otherDeck.keyShift))
  if (!plan) {
    // a code that is there but is not Camelot counts as no key, and is named the same way
    const missing = [!shiftCamelot(mine!.camelot ?? '', 0) && deckId, !shiftCamelot(other!.camelot ?? '', 0) && otherId].filter(Boolean)
    return { text: `Key sync לא זז: לשיר ב${missing.length === 2 ? 'שני הדקים' : `דק ${missing[0]}`} אין סולם.`, tone: 'warn' }
  }
  if (Math.abs(plan.shift) > maxShift) {
    return {
      text: `הסולמות לא מתאימים (${plan.from} מול ${plan.target}): צריך להזיז ${Math.abs(plan.shift)} חצאי טון, יותר מ-${maxShift}, אז השיר בדק ${deckId} נשאר בסולם שלו.`,
      tone: 'warn',
    }
  }
  if (!engine.decks[deckId].keyLock) {
    // Loaded here rather than through `toggleKeyLock`, whose failure notice would replace a transition's own; the reason comes back as text.
    if (!(await engine.ensureKeyLock())) {
      return { text: `Key sync לא זז: Key lock לא זמין (${engine.keyLockError ?? 'סיבה לא ידועה'}).`, tone: 'warn' }
    }
  }
  // Checked after the only wait and before anything is switched: the key lock goes into the path only for a move that is still wanted.
  const unwanted = stillWanted()
  if (unwanted) return { text: unwanted, tone: 'warn' }
  if (!engine.decks[deckId].keyLock) {
    await toggleKeyLock(deckId)
    if (!engine.decks[deckId].keyLock) return { text: 'Key lock עדיין נטען — לחץ שוב על Key sync.', tone: 'info' }
  }
  // The first key lock load is awaited above: a song loaded onto either deck meanwhile makes this plan one for songs no longer there.
  const now = useStore.getState().decks
  if (now[deckId].track?.id !== mine!.id || now[otherId].track?.id !== other!.id) {
    return { text: 'Key sync לא זז: שיר הוחלף באמצע. לחץ שוב.', tone: 'warn' }
  }
  engine.decks[deckId].setKeyShift(plan.shift)
  useStore.getState().patchDeck(deckId, { keySyncShift: plan.shift })
  keySyncBasis[deckId] = { mine: mine!.id, mineKey: mine!.camelot ?? null, other: other!.id, otherKey: other!.camelot ?? null }
  const moved = plan.shift === 0 ? `${plan.from} כבר מתאים` : `${plan.from} זז ${plan.shift > 0 ? '+' : ''}${plan.shift} ל-${plan.to}, מתאים`
  const between = plan.targetOffBy != null
    ? ` (דק ${otherId} מנגן בלי Key lock והטמפו שם אותו בין שני סולמות; נלקח הקרוב, ${plan.target})`
    : ''
  return { text: `דק ${deckId}: ${moved} לדק ${otherId} (${plan.target})${between}.`, tone: plan.targetOffBy != null ? 'warn' : 'info' }
}

function clearKeySync(deckId: DeckId) {
  engine.decks[deckId].setKeyShift(0)
  keySyncBasis[deckId] = null
  useStore.getState().patchDeck(deckId, { keySyncShift: null })
}

/**
 * What a key sync was planned against. When either song or either key changes afterwards — the other deck loads a song, a late
 * detection or the owner's correction reaches a deck (`core/tag-merge.ts`) — the move no longer fits what it says it fits, so it is
 * taken off and the notice says why, rather than a lit "Key +1" over a mix that now clashes.
 */
const keySyncBasis: Record<DeckId, { mine: string; mineKey: string | null; other: string; otherKey: string | null } | null> = { A: null, B: null }
useStore.subscribe((s) => {
  for (const deckId of ['A', 'B'] as const) {
    const basis = keySyncBasis[deckId]
    if (!basis || s.decks[deckId].keySyncShift == null) continue
    const otherId: DeckId = deckId === 'A' ? 'B' : 'A'
    const mine = s.decks[deckId].track
    const other = s.decks[otherId].track
    const why =
      mine?.id !== basis.mine ? null // this deck's own load or eject clears it itself
        : other?.id !== basis.other ? `דק ${otherId} החליף שיר`
          : (mine?.camelot ?? null) !== basis.mineKey ? `הסולם של השיר בדק ${deckId} השתנה`
            : (other?.camelot ?? null) !== basis.otherKey ? `הסולם של השיר בדק ${otherId} השתנה`
              : undefined
    if (why === undefined) continue
    // A deck on air keeps its move: after a Mix Assist A→B, B is the song playing and loading the next one on A is the very next step —
    // clearing it then jumped the live song up to two semitones mid-play (independent review, 05/10). The button still says how far it
    // was moved; it just no longer claims to fit a song that is gone. Only a deck that is not playing is put back on its own key.
    if (s.decks[deckId].playing) {
      keySyncBasis[deckId] = null
      continue
    }
    clearKeySync(deckId)
    if (why) s.setNotice({ text: `Key sync בדק ${deckId} כובה: ${why}. לחץ שוב כדי להתאים מחדש.`, tone: 'info', source: 'keylock' })
  }
})

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
 * Whether the mouse may move this deck from the waveform right now (v0.8.28).
 *
 * The owner's choice is a setting, not a rule: `likeJog` (the default) lets the
 * mouse behave exactly like a hand on the platter — it cancels an automatic mix
 * through the same `cancelTransitionIfEitherDeckTouched` the jog uses, so there
 * is one rule to remember. `blocked` refuses while the deck is in SYNC or in an
 * automatic mix, and says so, because a refusal nobody sees looks like a broken
 * waveform.
 */
export function waveformMouseAllowed(deckId: DeckId): boolean {
  if (cfg.waveformMouseInSync !== 'blocked') return true
  const { decks, setNotice } = useStore.getState()
  const inMix =
    !!activeTransition &&
    (deckId === activeTransition.fromDeckId || deckId === activeTransition.toDeckId)
  if (!inMix && !decks[deckId].syncActive) return true
  setNotice({
    text: `Deck ${deckId} is ${inMix ? 'in an automatic mix' : 'in SYNC'} — the waveform is locked. Settings → "Mouse on the waveform during SYNC" unlocks it.`,
    tone: 'warn',
    source: 'sync',
  })
  return false
}

export function deckHasTrack(deckId: DeckId): boolean {
  return engine.decks[deckId].hasTrack
}

/**
 * Click-to-jump on the waveform. It obeys the same SYNC setting as drag and
 * wheel (v0.8.28 review): with `blocked` the notice says the waveform is locked,
 * and a click that moved the track anyway would make that notice a lie; with
 * `likeJog` a jump on a deck inside an automatic mix is a hand taking over, the
 * same as the jog, not a mix carrying on over a track that just moved.
 */
export function seekDeckByHand(deckId: DeckId, sec: number) {
  if (!engine.decks[deckId].hasTrack) return
  if (!waveformMouseAllowed(deckId)) return
  cancelTransitionIfEitherDeckTouched(deckId)
  seekDeck(deckId, sec)
}

/**
 * Mouse wheel on the waveform (v0.8.28): move the track by a fraction of a
 * beat — a quarter per notch, a whole beat with Shift (the owner's choice).
 * Measured in the track's own beats (`beatGrid.bpm`), not the tempo-adjusted
 * ones, because the seek is in track seconds.
 */
export function nudgeDeckByBeats(deckId: DeckId, beats: number) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack || beats === 0) return
  if (!waveformMouseAllowed(deckId)) return
  const st = useStore.getState().decks[deckId]
  const bpm = st.beatGrid?.bpm ?? st.bpm
  if (!bpm) {
    useStore.getState().setNotice({
      text: `Deck ${deckId} has no BPM yet — the wheel moves by beats, so it has nothing to count.`,
      tone: 'warn',
      source: 'sync',
    })
    return
  }
  cancelTransitionIfEitherDeckTouched(deckId)
  const target = deck.position + (beats * 60) / bpm
  seekDeck(deckId, Math.max(0, Math.min(st.durationSec, target)))
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
export function setTempo(deckId: DeckId, tempo: number, opts: { byHand?: boolean } = {}) {
  // Safe against this same function's own internal callers (syncDeck /
  // setMasterDeck, re-matching the *incoming* or *outgoing* deck's tempo):
  // during an active transition those only ever target `toDeckId`, and by
  // the time `finishTransition` re-matches `fromDeckId` through
  // `setMasterDeck`, `activeTransition` is already cleared — so this only
  // ever fires for a genuine manual touch of the tempo fader.
  cancelTransitionIfOutgoingDeckTouched(deckId)
  // A hand on the fader (or SYNC, which comes through here) outranks the glide.
  cancelTempoGlide(deckId)
  const t = Math.max(-1, Math.min(1, tempo))
  engine.decks[deckId].setTempo(t)
  // Only a hand's number is offered to "Save tempo" (v0.9.46): SYNC's, a mix's and a glide's belong to the pairing.
  useStore.getState().patchDeck(deckId, { tempo: t, syncActive: false, tempoByHand: opts.byHand !== false })
  if (useStore.getState().masterDeckId === deckId) refreshFxTimeForMasterTempo()
  // Nothing is remembered from here (v0.9.46): a speed is kept only when the owner presses "Save tempo" (`saveDeckTempo`).
}

/**
 * The speed saved for this track (v0.9.47), as a rate. A value v0.9.46 saved under `tempo3` — a fader position, an hour old when this
 * changed — is carried over once at the range it was saved under (the current one; nobody changed it in between) and then removed.
 * `null` = the store could not be read (the caller falls back to the row's copy and says so).
 */
async function loadPlayRate(contentHash: string, path: string): Promise<number | null> {
  let rate: number | null
  try {
    rate = await getPlayRate(contentHash)
  } catch (err) {
    console.error('reading the saved speed failed', err)
    return null
  }
  if (rate != null) {
    // where it is now, so the row shows it straight after the next refresh (v0.9.48) — a failure only delays that, said in the console
    void rememberPlayRatePath(contentHash, path).catch((err) => console.error('recording where a saved speed is failed', err))
    return rate
  }
  const fader = await getTempo(contentHash)
  if (fader == null) return 1
  const carried = tempoToRate(fader, settings.values.tempoRange)
  try {
    await setPlayRate(contentHash, Math.abs(carried - 1) < 1e-4 ? null : carried, path)
    await clearTempo(contentHash)
  } catch (err) {
    console.error('carrying a v0.9.46 saved tempo over failed', err)
  }
  return carried
}

/**
 * "Save tempo" (v0.9.47): the speed the deck plays at now becomes this track's own — the fader goes back to the middle at the same
 * speed, the deck and the row show the new BPM, and SYNC and the glide back count from it. Shalom (06/10): "the tempo should stay fixed if
 * I decided that's its tempo", after v0.9.46 kept the fader down and the row at the file's 150. Only what a hand set (`tempoByHand`):
 * SYNC's, a mix's and a glide's numbers belong to the pairing (the 20/09 bug). "Forget tempo" goes back to the file's speed. Said on screen.
 */
export async function saveDeckTempo(deckId: DeckId, opts: { forget?: boolean } = {}): Promise<void> {
  const { decks, setNotice } = useStore.getState()
  const deck = decks[deckId]
  const track = deck.track
  if (!track) return
  const name = track.title ?? track.name
  const hash = track.contentHash
  if (!opts.forget && (deck.syncActive || tempoGlides[deckId] || !deck.tempoByHand)) {
    setNotice({ text: `Deck ${deckId}'s tempo came from ${deck.syncActive ? 'SYNC' : tempoGlides[deckId] ? 'a glide back' : 'SYNC or the mix'} — it is the mix's, not "${name}"'s, so it was not saved.`, tone: 'warn', source: 'tempo' })
    return
  }
  if (!hash) {
    setNotice({ text: `"${name}" has no identity yet, so its tempo cannot be saved — try again once it has finished loading.`, tone: 'warn', source: 'tempo' })
    return
  }
  pressFlash(`deck:${deckId}`)
  const rate = opts.forget ? 1 : deckRate(deck.baseRate, deck.tempo, settings.values.tempoRange)
  const isFile = Math.abs(rate - 1) < 1e-4
  try {
    await setPlayRate(hash, isFile ? null : rate, track.id)
  } catch (err) {
    setNotice({ text: `Tempo for "${name}" wasn't saved: ${err instanceof Error ? err.message : String(err)}`, tone: 'warn', source: 'tempo' })
    return
  }
  const now = useStore.getState()
  const { library, setLibrary, patchDeck } = now
  setLibrary({ tracks: library.tracks.map((t) => (t.contentHash === hash ? withPlayRate(t, isFile ? null : rate) : t)) })
  if (now.decks[deckId].track?.contentHash === hash) {
    // Fader to the middle and the new centre in one tick: the speed heard does not change on Save (Forget is the one that moves it).
    // Forget moves it, so it ends a mix this deck is leaving, exactly like a hand on the fader would.
    if (opts.forget) cancelTransitionIfOutgoingDeckTouched(deckId)
    cancelTempoGlide(deckId)
    engine.decks[deckId].setTempo(0)
    engine.decks[deckId].setBaseRate(isFile ? 1 : rate)
    patchDeck(deckId, { tempo: 0, baseRate: isFile ? 1 : rate, tempoByHand: false })
    if (now.masterDeckId === deckId) {
      refreshFxTimeForMasterTempo()
      // Forget changes the speed heard: a deck synced to this one keeps up, as it does with a glide (Save changes nothing, so this no-ops).
      followGlidingMaster(deckId)
    }
  }
  const bpm = deck.bpm ? ` (${Number(centreBpm(deck.bpm, isFile ? 1 : rate).toFixed(1))} BPM)` : ''
  setNotice({
    text: isFile ? `"${name}" plays at the file's own speed again${bpm}.` : `"${name}" now plays at this speed every time${bpm} — the tempo fader's middle.`,
    tone: 'info',
    source: 'tempo',
  })
}

/** `playRate` on a library row (v0.9.47) — removed, not set to 1, so a row with nothing saved looks exactly like one from before. */
function withPlayRate(t: Track, rate: number | null): Track {
  if (rate == null) {
    if (t.playRate == null) return t
    const { playRate: _, ...rest } = t
    return rest
  }
  return { ...t, playRate: rate }
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
    // A synced deck that jumps keeps the beat (v0.9.33, the owner, 07/10: the second press of the same "Mix in" pad, on a deck already
    // playing, put its kicks between the other deck's — "two kicks one after the other"). The jump landed wherever the cue was, off the
    // master's beat by up to half a beat, and the SYNC loop pulls a deck back by nudging its speed, a few ms a second: the kicks flammed for
    // seconds. Now it lands at most half a beat from the cue, on the beat — what Quantize does on any DJ deck.
    const onBeat = syncPhaseDeltaSec(deckId, existing.positionSec)
    let target = existing.positionSec + (onBeat ?? 0)
    const beatSec = decks[deckId].beatGrid ? 60 / decks[deckId].beatGrid!.bpm : 0
    // Before the start: the next beat instead, not 0 — 0 is off the beat, the very thing this snap is for. Past the end: the beat before.
    if (onBeat != null && target < 0) target += beatSec
    if (onBeat != null && target > deck.duration) target -= beatSec
    // A cue inside a running loop stays inside it: the snap may not carry the deck out of a loop the owner set.
    const { loopStart, loopEnd } = deck
    if (onBeat != null && loopStart != null && loopEnd != null && existing.positionSec >= loopStart && existing.positionSec < loopEnd) {
      const span = loopEnd - loopStart
      if (target >= loopEnd) target -= span
      if (target < loopStart) target += span
    }
    target = Math.min(Math.max(0, target), deck.duration)
    deck.seek(target)
    patchDeck(deckId, { positionSec: target })
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
    if (refuseTooLateEntry(deckId, cue!.positionSec, songEndSec(decks[deckId].audibleEndSec, decks[deckId].durationSec), decks[deckId].beatGrid, 'sync')) return
    // The same start as the panel's click (v0.9.17: on A's next phrase start, not its next bar).
    startAutoTransitionOnPhrase(otherDeckId, deckId, cue!.positionSec)
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
 * Save a mix-in point as a hot cue (v0.4.7). Since v0.8.14 only from
 * `rateMixTransition`'s "Excellent" — Shalom (23/09): a pad per click filled
 * the grid with points that never proved themselves; only a mix he rated
 * excellent earns one. Uses the first empty pad, or evicts the pad with the
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

/**
 * The only two doors to the engine's loop. The waveform draws the loop from
 * `loopRange` in the store, so a loop set straight on the engine (Loop Roll
 * never touches `loopActive`) would play with nothing on screen — the same
 * "audible but invisible" gap the project refuses everywhere else.
 */
function startLoop(deckId: DeckId, startSec: number, endSec: number) {
  engine.decks[deckId].setLoop(startSec, endSec)
  useStore.getState().patchDeck(deckId, { loopRange: { startSec, endSec } })
}

function stopLoop(deckId: DeckId) {
  engine.decks[deckId].clearLoop()
  useStore.getState().patchDeck(deckId, { loopRange: null })
}

export function toggleLoop(deckId: DeckId) {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return
  const { patchDeck, decks } = useStore.getState()
  const st = decks[deckId]
  if (st.loopActive) {
    stopLoop(deckId)
    patchDeck(deckId, { loopActive: false })
  } else {
    const bpm = st.bpm ?? 120
    const beatSec = 60 / bpm
    const start = quantizeIfOn(deckId, deck.position)
    startLoop(deckId, start, start + beatSec * st.loopBeats)
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
    startLoop(deckId, start, start + beatSec * b)
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
  const { tempo, baseRate } = useStore.getState().decks[deckId]
  const rate = deckRate(baseRate, tempo, settings.values.tempoRange)
  const elapsedSec = (engine.currentTime - roll.startedAtSec) * rate
  const target = loopRollReturnSec(roll.entrySec, elapsedSec, deck.duration)
  stopLoop(deckId)
  deck.seek(target)
  // A roll pressed over a normal loop replaced it in the engine; leaving `loopActive`
  // on would light the LOOP button with no loop behind it.
  useStore.getState().patchDeck(deckId, { positionSec: target, loopActive: false })
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
    stopLoop(deckId)
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
    stopLoop(deckId)
    patchDeck(deckId, { loopActive: false })
    return
  }
  const bpm = st.bpm ?? 120
  const start = quantizeIfOn(deckId, deck.position)
  startLoop(deckId, start, start + (60 / bpm) * beats)
  patchDeck(deckId, { loopActive: true, loopBeats: beats })
}

/** Loop mode, SHIFT+press: Loop Roll — loops while held, catches up to the natural position on release. Returns the release closure. */
function pressLoopRollPad(deckId: DeckId, beats: number): () => void {
  const deck = engine.decks[deckId]
  const bpm = useStore.getState().decks[deckId].bpm ?? 120
  const entrySec = quantizeIfOn(deckId, deck.position)
  loopRollByDeck[deckId] = { entrySec, startedAtSec: engine.currentTime }
  startLoop(deckId, entrySec, entrySec + (60 / bpm) * beats)
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
      // SHIFT + a set pad deletes, from the FLX4 exactly as from Shift+click
      // (v0.8.24, owner's decision): the pads say "× delete" whenever SHIFT
      // is held, from either source, and a label that promises a delete the
      // controller doesn't do is the silent mismatch this version removed.
      if (shiftHeld && decks[deckId].hotCues.some((c) => c.index === index)) {
        deleteHotCue(deckId, index)
        return () => {}
      }
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
/**
 * Slots with a resolve load in flight. `Library.tsx` fires several resolves
 * during one boot scan without waiting (after the scan, per analysis patch,
 * at the end), and since v0.12.1 they no longer queue behind the first touch —
 * so without this each one read, hashed and decoded the same whole track at
 * once, and a late duplicate `loadSlot` cut off a pad already playing.
 */
const samplerSlotLoads = new Set<number>()

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
    if (slot.trackId || engine.sampler.hasBuffer(i) || samplerSlotLoads.has(i)) continue
    // A recorded slot (v0.7.5) resolves from its own stored blob, not from
    // the library scan this function otherwise exists for — it has no
    // `contentHash` to match against, and doesn't need one.
    if (slot.recordingId) {
      samplerSlotLoads.add(i)
      try {
        if (!(await loadSamplerSlotRecording(i, slot.recordingId))) recordingFailed++
      } finally {
        samplerSlotLoads.delete(i)
      }
      continue
    }
    if (!slot.contentHash) continue
    const track = library.tracks.find((t) => t.contentHash === slot.contentHash)
    if (!track) {
      unresolved++
      continue
    }
    samplerSlotLoads.add(i)
    try {
      await loadSamplerSlotAudio(i, track, { keepSavedSettings: true })
    } finally {
      samplerSlotLoads.delete(i)
    }
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
  // No `initAudio()` here — see the note in `loadSamplerSlotAudio`.
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
  // Only a fresh load waits for the engine. A saved-bank resolve runs at boot,
  // before anyone has touched the page, and Chrome holds `resume()` until the
  // first touch — so awaiting it here parked `resolveSamplerSlots` on slot 1
  // and every slot after it stayed empty until a click (debt since 23/09,
  // reproduced by scripts/verify-sampler-no-gesture.mjs). Decoding and
  // handing a slot its buffer work on a suspended context; only playing needs
  // it running, and `pressSamplerPad` starts the engine before it plays.
  if (!opts.keepSavedSettings) await initAudio()
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
    const masterBpm = master?.bpm ? master.bpm * deckRate(master.baseRate, master.tempo, cfg.tempoRange) : null
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
  if (useStore.getState().audioReady) return pressSamplerPadNow(index)
  // Since v0.12.1 a saved slot holds its audio before the engine has ever
  // started (see `loadSamplerSlotAudio`), so a pad can be the very first thing
  // pressed. Triggering into the still-suspended context lit the pad and made
  // no sound, and a one-shot never un-lit (`onSlotEnded` is wired there).
  // Even where the browser lets audio start untouched, the sampler volume had
  // not been applied yet. So the press starts the engine and plays once it
  // runs. If the browser holds the start (no touch on the page yet), the
  // screen says so and points at "Start audio engine" — measured in the test
  // Chromium (scripts/verify-sampler-no-gesture.mjs): a later click elsewhere
  // did NOT release a start the browser already held. And a
  // pad that waited that long does not go off by itself when the engine does
  // start: a sample firing seconds after the press is worse than none.
  let release: (() => void) | null = null
  let released = false
  let waitingShown = false
  const waitText = 'The sound engine is off — press "Start audio engine" at the top, then press the pad again.'
  const waitTimer = window.setTimeout(() => {
    waitingShown = true
    useStore.getState().setNotice({ text: waitText, tone: 'warn', source: 'sampler' })
  }, 400)
  void initAudio().then(() => {
    window.clearTimeout(waitTimer)
    if (waitingShown) {
      // Only our own message — another sampler warning set meanwhile stays.
      const { notice, setNotice } = useStore.getState()
      if (notice?.text === waitText) setNotice(null)
      return
    }
    // Played even if the pad was already let go: a quick tap on a One-shot
    // must still fire. A Gated pad let go before the engine ran plays nothing
    // (triggering it only to stop it at once was an audible blip).
    if (released && useStore.getState().sampler.slots[index].mode === 'gated') return
    const r = pressSamplerPadNow(index)
    if (released) r()
    else release = r
  })
  return () => {
    released = true
    release?.()
  }
}

function pressSamplerPadNow(index: number): () => void {
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
  const masterBpm = master?.bpm ? master.bpm * deckRate(master.baseRate, master.tempo, cfg.tempoRange) : null
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
  return master?.bpm ? master.bpm * deckRate(master.baseRate, master.tempo, cfg.tempoRange) : null
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

/**
 * The track list pulled up big, or back to its normal size (v0.9.34). The
 * decks hide their pads while it is big — see `libraryExpanded` in the store.
 * Saved so it comes back after a reload; a save that fails says so, because a
 * size that silently resets next time looks like the drag never worked.
 */
let libraryLayoutTouched = false

export function setLibraryExpanded(expanded: boolean): void {
  libraryLayoutTouched = true
  const { libraryExpanded, set, setNotice } = useStore.getState()
  if (libraryExpanded === expanded) return
  set('libraryExpanded', expanded)
  saveLibraryExpanded(expanded).catch((err: unknown) => {
    console.error('Library size save failed', err)
    setNotice({
      text: `The track list size didn't save, so it will open at the normal size next time — ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'layout',
    })
  })
}

export function toggleLibraryExpanded(): void {
  setLibraryExpanded(!useStore.getState().libraryExpanded)
}

/** Boot: put the list back at the size it was left at. Not tied to the audio engine — the layout should be right before anyone presses Start. */
export async function restoreLibraryLayout(): Promise<void> {
  const stored = await getLibraryExpanded()
  // A drag that landed while IndexedDB was still answering is newer than
  // what it holds (and is already being saved); the stored value must not undo it.
  if (stored != null && !libraryLayoutTouched) useStore.getState().set('libraryExpanded', stored)
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
  // v0.9.16/v0.9.18: a knob turned by hand during a transition is his from then on — the transition stops moving it and will not put it back.
  const e = activeTransition?.eq
  if (e) {
    if (deckId === activeTransition!.fromDeckId) e.byHand.from.add(band)
    if (deckId === activeTransition!.toDeckId) e.byHand.to.add(band)
  }
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
  if (activeTransition) cancelTransitionByHand('the crossfader was moved')
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
            `deckmix-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`,
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
    const result = await saveSetHistoryText(text, `deckmix-setlist-${new Date().toISOString().slice(0, 10)}.txt`)
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

/**
 * Mark the grid as looked at, edit or not — clears the "unconfirmed" pill.
 * Saved like an edit (v0.12.4): until then it changed only the screen, and the
 * pill was back at the next load of the same track (debt from v0.8.23). Only
 * an unconfirmed grid is written — closing the panel over a grid detection
 * already trusted would otherwise pin every such grid as the owner's.
 */
export function confirmBeatGrid(deckId: DeckId) {
  const st = useStore.getState().decks[deckId]
  // v0.9.5: closing the panel over an unsure "1" is checking it, as for an unconfirmed grid.
  if (st.beatGridConfirmed && !st.barOneUnsure) return
  // No grid at all: nothing to save — the pill goes, as it always did.
  if (!st.beatGrid) return useStore.getState().patchDeck(deckId, { beatGridConfirmed: true })
  if (!gridEditAllowed(deckId)) return
  useStore.getState().patchDeck(deckId, { beatGridConfirmed: true })
  persistGridCorrection(deckId)
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
  persistGridCorrection(deckId)
}

/** Corrects an octave-low guess — see core/beatgrid.ts's halveGrid. */
export function halveBeatGrid(deckId: DeckId) {
  const { patchDeck, decks } = useStore.getState()
  const grid = decks[deckId].beatGrid
  if (!grid) return
  const next = halveGrid(grid)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
  tempoByHandOnDeck[deckId] = true
  persistGridCorrection(deckId)
}

/** Corrects an octave-high guess — see core/beatgrid.ts's doubleGrid. */
export function doubleBeatGrid(deckId: DeckId) {
  const { patchDeck, decks } = useStore.getState()
  const grid = decks[deckId].beatGrid
  if (!grid) return
  const next = doubleGrid(grid)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
  tempoByHandOnDeck[deckId] = true
  persistGridCorrection(deckId)
}

/**
 * Beat 0 is wherever the playhead sits right now, at the grid's current bpm
 * (or the plain tag/detected bpm if there was no grid yet at all — this is
 * also how a track with no detectable periodicity gets a first grid).
 */
export function setDownbeatHere(deckId: DeckId): Promise<boolean> {
  const deck = engine.decks[deckId]
  if (!deck.hasTrack) return Promise.resolve(false)
  if (!gridEditAllowed(deckId)) return Promise.resolve(false)
  const { patchDeck, decks } = useStore.getState()
  const bpm = decks[deckId].beatGrid?.bpm ?? decks[deckId].bpm
  if (!bpm) return Promise.resolve(false)
  const next = setDownbeatAt(bpm, deck.position)
  patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
  return persistGridCorrection(deckId)
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
  if (!gridEditAllowed(deckId)) return
  const now = performance.now() / 1000
  const taps = tapTimesSec[deckId]
  if (taps.length > 0 && now - taps[taps.length - 1] > TAP_RESET_SEC) taps.length = 0
  taps.push(now)
  if (taps.length > 8) taps.shift() // bound memory; recent taps matter most
  const bpm = bpmFromTaps(taps)
  if (bpm == null) return
  const { patchDeck, decks } = useStore.getState()
  // Re-folded into the new, possibly shorter bar: the stored offset is
  // always inside the first bar (`BeatGrid.offsetSec`), and the bar line
  // itself doesn't move.
  const next = setDownbeatAt(bpm, decks[deckId].beatGrid?.offsetSec ?? 0)
  patchDeck(deckId, { beatGrid: next, bpm, beatGridConfirmed: true })
  tempoByHandOnDeck[deckId] = true
  persistGridCorrection(deckId)
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
    glideWhenMasterHasGone()
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
  const masterBpm = master.bpm ? master.bpm * deckRate(master.baseRate, master.tempo, cfg.tempoRange) : null
  if (!masterBpm) return
  sampler.slots.forEach((slot, i) => {
    if (slot.mode !== 'loop' || !slot.syncEnabled || !slot.playing || !slot.bpm) return
    engine.sampler.setRate(i, samplerSyncRate(masterBpm, slot.bpm, true))
  })
}

// ————————————————————————————————————————————————————————————————
// Auto SYNC in, glide back out (v0.8.39, Shalom 25/09). Play on a deck while
// the other plays syncs it; once the other track is gone, the synced one
// becomes master and slides back to its own BPM over GLIDE_BACK_SEC. Without
// this a synced-in track kept the outgoing one's tempo to its end, and every
// track after it inherited the drift.
// ————————————————————————————————————————————————————————————————

/** Transient like `activeTransition` — nothing here is serializable. */
const tempoGlides: Partial<Record<DeckId, { from: number; startSec: number }>> = {}

/** Called just before a deck starts playing. The automatic mix does its own SYNC, so it is left alone. */
function autoSyncOnPlay(deckId: DeckId) {
  if (!cfg.autoSyncGlide || activeTransition) return
  const other: DeckId = deckId === 'A' ? 'B' : 'A'
  const { decks } = useStore.getState()
  if (decks[deckId].syncActive || !decks[other].playing) return
  // syncDeck says out loud when it cannot (no BPM, no grid) — the same
  // notice a SYNC press gives, so a refused auto-sync is not a silent one.
  syncDeck(deckId)
}

function cancelTempoGlide(deckId: DeckId) {
  delete tempoGlides[deckId]
}

function startTempoGlide(deckId: DeckId) {
  const st = useStore.getState().decks[deckId]
  // Already at its own speed: nothing to glide, and nothing worth announcing.
  if (!st.track || Math.abs(st.tempo) < 1e-4) return
  tempoGlides[deckId] = { from: st.tempo, startSec: engine.currentTime }
  useStore.getState().setNotice({
    text: `Deck ${deckId} is gliding back to its own tempo${st.bpm ? ` (${centreBpm(st.bpm, st.baseRate).toFixed(1)} BPM)` : ''} over ${GLIDE_BACK_SEC} s. Touching its tempo fader or SYNC stops the glide.`,
    tone: 'info',
    source: 'sync',
  })
  ensureGlideTicker()
}

let glideTickerStarted = false
/**
 * Ten steps a second, not one: at the sync loop's 1 s a 16% glide over 30 s
 * moves in 0.5% jumps, which is a pitch step an ear catches. At 0.1 s each
 * step is well under what anyone hears.
 */
function ensureGlideTicker() {
  if (glideTickerStarted) return
  glideTickerStarted = true
  let last = 0
  clock.subscribe((now) => {
    if (now - last < 0.1) return
    last = now
    // The switch "turns all of this off" — a glide already running included.
    if (!cfg.autoSyncGlide) {
      cancelTempoGlide('A')
      cancelTempoGlide('B')
      return
    }
    for (const id of ['A', 'B'] as DeckId[]) {
      const g = tempoGlides[id]
      if (!g) continue
      // A paused deck, or one braking to a stop, is left alone: writing a rate
      // now would cancel the vinyl brake ramp and play on at full speed. The
      // tempo catches up on the first tick after it plays again.
      if (!engine.decks[id].playing) continue
      const elapsed = now - g.startSec
      const tempo = glideTempoAt(g.from, 0, elapsed, GLIDE_BACK_SEC)
      engine.decks[id].setTempo(tempo)
      useStore.getState().patchDeck(id, { tempo, tempoByHand: false })
      if (useStore.getState().masterDeckId === id) refreshFxTimeForMasterTempo()
      // Same tick, including the last one — following from the 1 s sync loop
      // left a follower 1 s behind, in audible steps, and stranded it there
      // once the glide was deleted.
      followGlidingMaster(id)
      if (elapsed >= GLIDE_BACK_SEC) delete tempoGlides[id]
    }
  })
}

/**
 * Consecutive sync ticks (1 s apart) the master has read as gone. Two, not
 * one: a crossfader cut or a fader chop that happens to land on a tick is a
 * trick, not the end of the song — and a master handed over by mistake cannot
 * be taken back, since the old deck is left unsynced (v0.8.39 review).
 */
let masterGoneTicks = 0

/** "When the old song is over" — the synced deck takes over as master and glides home. Left to the automatic mix while one runs; `finishTransition` starts that glide itself. */
function glideWhenMasterHasGone() {
  if (!cfg.autoSyncGlide || activeTransition) {
    masterGoneTicks = 0
    return
  }
  const { decks, masterDeckId, mixer } = useStore.getState()
  if (!masterDeckId) return
  const master = decks[masterDeckId]
  const gone = masterHasGone(masterDeckId, {
    playing: master.playing,
    channelVolume: mixer.channels[masterDeckId].volume,
    crossfader: mixer.crossfader,
  })
  masterGoneTicks = gone ? masterGoneTicks + 1 : 0
  if (masterGoneTicks < 2) return
  masterGoneTicks = 0
  for (const id of ['A', 'B'] as DeckId[]) {
    if (id === masterDeckId) continue
    const st = decks[id]
    if (!st.syncActive || !st.playing) continue
    setMasterDeck(id)
    startTempoGlide(id)
  }
}

/**
 * A track synced in *during* a glide must move with it — SYNC matches tempo
 * once, when pressed, and the phase loop can only nudge, never follow a
 * master that keeps changing speed. Limited to a gliding master on purpose:
 * a synced deck following a hand-moved master fader is a separate change.
 */
function followGlidingMaster(glidingId: DeckId) {
  const { decks, masterDeckId, patchDeck } = useStore.getState()
  if (masterDeckId !== glidingId) return
  const master = decks[masterDeckId]
  if (!master.bpm) return
  for (const id of ['A', 'B'] as DeckId[]) {
    if (id === masterDeckId) continue
    const st = decks[id]
    if (!st.syncActive || !st.bpm) continue
    // Clamped like setTempo: past the fader's end the readout would show a
    // speed the fader cannot. Said out loud, since the deck then stops keeping up.
    const wanted = syncTempoFor(centreBpm(master.bpm, master.baseRate), master.tempo, centreBpm(st.bpm, st.baseRate), settings.values.tempoRange)
    const tempo = Math.max(-1, Math.min(1, wanted))
    if (Math.abs(tempo - st.tempo) < 1e-4) continue
    if (tempo !== wanted && Math.abs(st.tempo) < 1) {
      useStore.getState().setNotice({
        text: `Deck ${id} can't follow deck ${masterDeckId}'s glide any further — its tempo fader is at the end of its range.`,
        tone: 'warn',
        source: 'sync',
      })
    }
    engine.decks[id].setTempo(tempo)
    patchDeck(id, { tempo, tempoByHand: false })
  }
}

/**
 * The signed move that would put `positionSec` of a synced deck on the playing master's beat phase, or null when SYNC is not holding this
 * deck to anything right now (off, either deck stopped, a grid missing, or it is the master itself). One function for the SYNC loop and
 * for a hot-cue jump on a synced deck (v0.9.33), so the two can never disagree about which beat is "on".
 */
function syncPhaseDeltaSec(id: DeckId, positionSec: number): number | null {
  const { decks, masterDeckId } = useStore.getState()
  if (!masterDeckId || id === masterDeckId) return null
  const master = decks[masterDeckId]
  const st = decks[id]
  if (!st.syncActive || !st.playing || !master.playing) return null
  if (!st.beatGrid || !master.beatGrid) return null
  // Half-time pairs (v0.8.36): the deck's beats are read at the master's
  // rate, so an 85 locks every beat to every other beat of a 170 instead of
  // being "half a beat off" on every other one.
  // Read from what the two decks are *playing*, not their native BPMs: once
  // SYNC has matched them, the ratio is ~exactly 1, 2 or 0.5 whatever the
  // faders or the tempo range, so this can't disagree with the choice
  // `syncTempoFor` made (v0.8.36 review: native BPMs could, at ±16%/±50%).
  const range = settings.values.tempoRange
  const mult =
    st.bpm && master.bpm
      ? halfDoubleMultiplier(master.bpm * deckRate(master.baseRate, master.tempo, range), st.bpm * deckRate(st.baseRate, st.tempo, range))
      : 1
  const deckGrid = mult === 1 ? st.beatGrid : { ...st.beatGrid, bpm: st.beatGrid.bpm * mult }
  return phaseDeltaSec(positionSec, deckGrid, engine.decks[masterDeckId].position, master.beatGrid)
}

function runSyncCorrection() {
  for (const id of ['A', 'B'] as DeckId[]) {
    // A deck held silent by Mix Assist's kick lock is the gate's to nudge: this loop's 1 s nudge replaces the gate's mid-way (last call
    // wins in `syncNudge`), and a gap read during it would pass for a lock while B is still moving.
    const held = useStore.getState().activeTransition
    if (held?.aligning && held.toDeckId === id) continue
    const delta = syncPhaseDeltaSec(id, engine.decks[id].position)
    if (delta == null || Math.abs(delta) < SYNC_PHASE_DEADBAND_SEC) continue
    engine.decks[id].syncNudge(delta, SYNC_LOOP_INTERVAL_SEC)
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
  pressFlash(`sync:${deckId}`)
  // The gliding deck is always master, so the press below ends in "already
  // master" before reaching setTempo — and the glide notice promises SYNC stops it.
  cancelTempoGlide(deckId)
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
  const tempo = syncTempoFor(centreBpm(master.bpm, master.baseRate), master.tempo, centreBpm(st.bpm, st.baseRate), settings.values.tempoRange)
  setTempo(deckId, tempo, { byHand: false })
  patchDeck(deckId, { syncActive: true })
  ensureSyncLoop()
  // Said out loud: the two BPM readouts now differ by 2×, which reads as "SYNC
  // failed" unless something says why.
  const mult = syncMultiplier(master.bpm * deckRate(master.baseRate, master.tempo, settings.values.tempoRange), centreBpm(st.bpm, st.baseRate), settings.values.tempoRange)
  if (mult !== 1) {
    setNotice({
      text: `Deck ${deckId} synced ${mult === 2 ? 'half-time' : 'double-time'} to deck ${resolvedMaster} — ${Math.round(centreBpm(st.bpm, st.baseRate))} BPM counts as ${Math.round(centreBpm(st.bpm, st.baseRate) * mult)}.`,
      tone: 'info',
      source: 'sync',
    })
  }
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
  const tempo = syncTempoFor(centreBpm(master.bpm, master.baseRate), master.tempo, centreBpm(mine, st.baseRate), settings.values.tempoRange)
  setTempo(other, tempo, { byHand: false })
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
  /** v0.9.22: Mix Assist moved B's key itself (`autoKeySync`); a cancel puts it back, and the key lock as it found it. */
  autoKey?: { lockWasOn: boolean }
  /** The one live clock subscription — the bar-line wait before the join, then the crossfade after it. Swapped at the join, so `cancelTransition` always stops whichever is running. */
  unsubscribe: () => void
  /** v0.5.4: the outgoing deck's own exit point — see `AppState.activeTransition`'s own doc comment. Carried here too so `finishTransition` can raise the rating prompt without recomputing it. Always a number (23/09) — see the fallback at its computation site. */
  exitPointSec: number
  /** v0.8.14: the raw `entrySec` this transition was called with, before `phaseAlignedEntrySec` re-aligns it — carried through to `pendingMixRating` for `markExcellentPair`, same split as `exitPointSec` above. */
  entrySec: number
  /** v0.8.16: the outgoing deck's position at the join, set by `join` — `null` until then. What `markExcellentPair` saves as the pair's exit second. */
  joinedFromSec: number | null
  /**
   * v0.9.18 (v0.9.16 did the MID alone): every transition mixes with the EQ (`core/eq-mix.ts`) — all three knobs on both decks. Where the
   * owner had them at the join — put back on finish and on cancel — and which one he has since turned by hand: from that moment that knob
   * is his, never moved or put back by the transition. `style` is read once at the join, so a change in Settings mid-mix cannot flip it.
   */
  eq?: { own: { from: EqBands; to: EqBands }; byHand: { from: Set<EqBand>; to: Set<EqBand> }; style: BassSwapStyle }
  /**
   * v0.9.75: the kick-gap meter (`core/kick-gap.ts`) — reads both decks' sound for the whole mix and says at the end how far apart their
   * kicks were. `fromTime` (audio clock) is where the windows start to count: after the lock, so a gap the lock was still closing is not
   * reported as the mix's.
   */
  kick?: { meter: KickMeter; fromTime: number }
}

const EQ_KEY = { low: 'eqLow', mid: 'eqMid', high: 'eqHigh' } as const
const EQ_BANDS: EqBand[] = ['low', 'mid', 'high']

/** Sets one knob for the transition — engine and the knob on screen together, so the owner sees it turn. */
function setMixEq(deckId: DeckId, band: EqBand, v: number) {
  if (useStore.getState().mixer.channels[deckId][EQ_KEY[band]] === v) return
  engine.decks[deckId].setEq(band, v)
  useStore.getState().patchChannel(deckId, { [EQ_KEY[band]]: v })
}

/** Sets every knob the transition still owns to `knobs` (one deck's three). */
function applyMixEq(t: ActiveTransition, side: 'from' | 'to', knobs: EqBands) {
  const e = t.eq
  if (!e) return
  const deckId = side === 'from' ? t.fromDeckId : t.toDeckId
  for (const band of EQ_BANDS) if (!e.byHand[side].has(band)) setMixEq(deckId, band, knobs[band])
}

/**
 * A tap window holds the last 0.74 s, so the first window that counts starts this long after the lock: what the lock was still closing
 * is in the windows before it.
 */
const KICK_METER_SETTLE_SEC = 0.8

/**
 * v0.9.75 (the owner, 19/10): said when a mix ends, next to whatever the transition already said — how far apart the two decks' kicks were,
 * measured on the sound and not on the beat grids. A mix whose kicks could not be measured says so; it is never reported as a zero.
 */
function reportKickGap(t: ActiveTransition) {
  const k = t.kick
  if (!k) return
  const { summary, windows } = k.meter.stop(k.fromTime)
  const to = t.toDeckId
  let text: string
  let tone: 'info' | 'warn' = 'info'
  if (!summary) {
    text = `לא הצלחתי למדוד את פער הקיקים במיקס הזה (${windows.length} בדיקות, לא נמצאו מספיק קיקים ברורים בשני הדקים יחד) — לא ידוע אם הבסים ישבו.`
  } else {
    const med = Math.round(summary.medianMs)
    const p90 = Math.round(summary.p90Ms)
    const side = med === 0 ? '' : med > 0 ? ` — דק ${to} מאחר` : ` — דק ${to} מקדים`
    if (Math.abs(summary.medianMs) > KICK_GAP_WARN_MS) tone = 'warn'
    text = `פער קיקים במיקס: ${Math.abs(med)} אלפיות שנייה${side} (9 מתוך 10 קיקים בתוך ${p90}, נמדד על ${summary.pairs} קיקים).${tone === 'warn' ? ' הבסים לא ישבו.' : ''}`
  }
  console.info('[kick-gap]', text, summary)
  // Next to whatever the transition already said, but a notice nobody dismissed must not carry the previous mix's reading along: that
  // part is dropped, and a warning already showing stays a warning.
  const cur = useStore.getState().notice
  const rest = (cur?.text ?? '').split(' · ').filter((part) => part && !part.startsWith('פער קיקים במיקס') && !part.startsWith('לא הצלחתי למדוד את פער הקיקים'))
  const keepWarn = rest.length > 0 && cur?.tone === 'warn'
  useStore.getState().setNotice({ text: [...rest, text].join(' · '), tone: keepWarn ? 'warn' : tone, source: 'sync' })
}

/** Puts the knobs a transition turned back where the owner had them, except one he turned himself since. */
function restoreMixEq(t: ActiveTransition) {
  if (!t.eq) return
  applyMixEq(t, 'from', t.eq.own.from)
  applyMixEq(t, 'to', t.eq.own.to)
}

const channelEq = (deckId: DeckId): EqBands => {
  const c = useStore.getState().mixer.channels[deckId]
  return { low: c.eqLow, mid: c.eqMid, high: c.eqHigh }
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
  if (activeTransition && deckId === activeTransition.fromDeckId) cancelTransitionByHand(`deck ${deckId} was touched`)
}

/**
 * v0.8.16: a replay can wait minutes for its exit second, and any touch on
 * either deck or the crossfader cancels it (the ROADMAP rule these callers
 * apply). The red button just vanishing reads as "it didn't mix", so a
 * cancelled *wait* is named. A normal transition is cancelled within a bar
 * of the click, by the hand that is plainly doing it — no notice there, as
 * before.
 */
function cancelTransitionByHand(what: string) {
  const waitingUntilSec = useStore.getState().activeTransition?.waitingUntilSec
  const handoffSec = useStore.getState().activeTransition?.handoffSec
  const onPhrase = useStore.getState().activeTransition?.onPhrase
  const swap = useStore.getState().activeTransition?.swap
  cancelTransition()
  if (handoffSec != null) {
    // A handoff runs for many bars after its wait, so it is named whether it was still waiting or already mixing.
    useStore.getState().setNotice({ text: `${swap ? 'החלפת השירה' : 'מסירת השירה'} בוטלה — ${what === 'the crossfader was moved' ? 'הזזת את הקרוספיידר' : what.replace(/^deck (\w) was touched$/, 'נגעת בדק $1')}.`, tone: 'info', source: 'sync' })
  } else if (waitingUntilSec != null && onPhrase) {
    useStore.getState().setNotice({ text: `המעבר בוטל — ${what === 'the crossfader was moved' ? 'הזזת את הקרוספיידר' : what.replace(/^deck (\w) was touched$/, 'נגעת בדק $1')} בזמן שחיכה לתחילת הקטע ב-${formatMinSec(waitingUntilSec)}.`, tone: 'info', source: 'sync' })
  } else if (waitingUntilSec != null) {
    useStore.getState().setNotice({
      text: `Excellent-match mix cancelled — ${what} while it was waiting for ${formatMinSec(waitingUntilSec)}.`,
      tone: 'info',
      source: 'mixRating',
    })
  }
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
    cancelTransitionByHand(`deck ${deckId} was touched`)
  }
}

/**
 * Seek-then-sync (ROADMAP.md v0.4.6): the incoming deck is aligned and
 * started while the crossfader still sits fully on the outgoing deck (so the
 * join is inaudible; the vocal swap's B is the exception — it starts on its
 * voice line and is heard from that moment), then handed to the existing `syncDeck`/`ensureSyncLoop`
 * for continuous correction exactly like a manually-pressed SYNC would be.
 * From there a `clock`-driven loop (the same shared rAF source
 * `ensureSyncLoop` itself subscribes to) drives the EQ and the crossfader
 * through `core/eq-mix.ts`'s `eqMixFrame` (v0.9.18 — a plain transition on
 * `plainEqMixPlan` over `TRANSITION_CROSSFADE_SEC`, a handoff on its plan),
 * via `engine.setCrossfader`. Since v0.9.33 every automatic mix runs on
 * `full-middle` (`core/fx.ts`; `AUTO_MIX_CROSSFADER_CURVE`, and the vocal
 * swap's `SWAP_CROSSFADER_CURVE`): both decks at full level in the middle,
 * because each is EQ'd down to the part of a song the other lacks. On the
 * hand crossfader's equal-power curve the mix sat about 2–3 dB under the
 * two songs for half its length — the drop the owner heard (07/10).
 *
 * Refuses (with a notice, never a silent no-op) rather than start a
 * transition it cannot phase-align or that would land on a deck that is not
 * cleanly available — a deck already mid-load, or already playing.
 */
/** `engine.setCrossfader`'s domain is -1 (A only) .. +1 (B only) — the extreme fully on `fromDeckId`. */
function crossfaderExtremeFor(fromDeckId: DeckId): number {
  return fromDeckId === 'A' ? -1 : 1
}

/**
 * `waitUntilSec` (v0.8.16): an excellent-pair replay — hold the join until the
 * outgoing deck reaches the second it mixed out at last time
 * (`exitWaitStatus`), then take the first bar line there. Shalom's calls
 * (23/09): before that second, load and wait; past it, don't mix at all and
 * say so. Omitted, the join takes the next bar line, as before.
 */
export function startAutoTransition(
  fromDeckId: DeckId,
  toDeckId: DeckId,
  entrySec: number,
  waitUntilSec: number | null = null,
  /**
   * A caller's own note about this start (v0.8.16: "old pair, no exit
   * second"). `notice` has one slot, so it is folded into this function's own
   * unconfirmed-grid warning instead of being set before the call and
   * overwritten by it. Dropped only by a refusal, which matters more.
   */
  leadNote: string | null = null,
  /**
   * v0.9.15, Mix Assist by sound: a vocal handoff (`core/vocal-handoff.ts`). `waitUntilSec` is then the plan's join line; instead of the fixed
   * fade from the join, the crossfader follows A's own play position — B up to the middle after the join, the bass swap on `handoffSec`, A
   * down to nothing by `fadeEndSec`. Since v0.12.13 the join is under A's last lines and B's voice comes in on `handoffSec`, the end of A's transition.
   */
  handoff: { handoffSec: number; fadeEndSec: number } | null = null,
  /** v0.9.17: `waitUntilSec` is a phrase start of A (`startAutoTransitionOnPhrase`), not a saved exit second — only the "passed" text differs. */
  waitIsPhrase = false,
  /**
   * The vocal swap (`core/vocal-swap-mix.ts`): rides on `handoff` (A's position drives it, from the join line to the end), and only the
   * knobs differ — B starts with everything but its LOW, on the `full-middle` crossfader curve, and the frames are `vocalSwapFrame`'s instead of the EQ mix's.
   */
  vocalSwap: VocalSwapPlan | null = null,
) {
  const { decks, setNotice, notice: noticeBefore } = useStore.getState()
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
  // After the refusals above: the Mix panel lights only for a transition that actually starts.
  pressFlash('mix')
  // v0.4.10: an unconfirmed grid is a guess, not a refusal reason — Shalom's
  // call (05/09): "like a blinking yellow light: it's a risk, but I'm doing
  // it" rather than blocking mid-set. Named explicitly so the DJ knows which
  // side to listen to, same as every other notice this function already
  // raises.
  const unconfirmed: DeckId[] = []
  if (!from.beatGridConfirmed) unconfirmed.push(fromDeckId)
  if (!to.beatGridConfirmed) unconfirmed.push(toDeckId)
  const unconfirmedText =
    unconfirmed.length > 0
      ? `Phase-aligning against an unconfirmed beat grid on deck ${unconfirmed.join(' and ')} — the join may drift more than usual until SYNC catches it up.`
      : null

  const fromEngine = engine.decks[fromDeckId]
  const toEngine = engine.decks[toDeckId]

  /** What the owner sees this mix called in every notice: a handoff and a vocal swap share the machinery, not the name. */
  const mixName = vocalSwap ? 'החלפת השירה' : 'מסירת השירה'
  const passedText = (sec: number) =>
    handoff
      ? passedHandoffText(fromDeckId, sec, mixName)
      : waitIsPhrase
        ? `דק ${fromDeckId} עבר את ${formatMinSec(sec)}, תחילת הקטע ש-${toDeckId} חיכה לה — המעבר לא התחיל. בחר שוב בחלון של Mix Assist.`
        : passedExitText(fromDeckId, sec)
  if (waitUntilSec != null && exitWaitStatus(fromEngine.position, waitUntilSec, barSecOf(from.beatGrid)) === 'passed') {
    setNotice({ text: passedText(waitUntilSec), tone: 'warn', source: 'sync' })
    return
  }
  if (unconfirmedText) {
    setNotice({ text: leadNote ? `${leadNote} Also: ${unconfirmedText}` : unconfirmedText, tone: 'warn', source: 'sync' })
  } else if (leadNote) {
    setNotice({ text: leadNote, tone: 'info', source: 'mixRating' })
  }

  // Establish the join point explicitly rather than trust whatever the live
  // crossfader already happens to read — ROADMAP.md requires the incoming
  // deck to start while the crossfader "still sits fully" on the outgoing
  // one, and a manual nudge earlier (while only one deck was playing) could
  // otherwise leave it short of that extreme.
  const startExtreme = crossfaderExtremeFor(fromDeckId)
  engine.setCrossfader(startExtreme)
  // v0.8.16: the store follows now, not at the join — a replay can wait
  // minutes, and the on-screen fader must not sit somewhere the audio isn't.
  useStore.getState().patchMixer({ crossfader: startExtreme })

  // v0.8.14 (owner review 23/09): the join waits for the outgoing deck's next
  // yellow (bar) line instead of firing on the click — a DJ drops the new
  // track "on the one", and a join at an arbitrary beat of the bar is
  // audibly wrong even when every beat matches. Up to one bar of wait (~2s
  // at 120 BPM). The transition is already "active" during the wait, so the
  // Cancel button is there from the click and `Mixer.tsx` says it's waiting.
  // v0.5.4: the outgoing deck's own next candidate point, shown as a
  // suggested exit (`resolveExitPointSec`, `core/structure.ts` — its own doc
  // comment has the 23/09 fix: this used to be able to fall back to `null`,
  // which silently skipped the rating prompt too).
  // The file's length maps bands to seconds; the song's end (v0.9.70) only drops exits that sit in a silent tail.
  const fromEnd = songEndSec(from.audibleEndSec, from.durationSec)
  const exitCandidates = from.bands ? findTransitionCandidates(from.bands, from.durationSec, from.beatGrid).filter((c) => c.sec < fromEnd) : []
  const exitPointSec = resolveExitPointSec(exitCandidates, fromEngine.position)

  const join = (fromGrid: BeatGrid, toGrid: BeatGrid) => {
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
    // it lands. The frame this runs on is a few ms past the bar line;
    // `phaseAlignedEntrySec` is bar-phase math, so the incoming deck lands
    // exactly that same fraction past its own yellow line.
    // v0.9.18: B's knobs go to their "under A" places (LOW killed, MID cut) before it makes a sound. Here, before the position is read:
    // these are store writes, and nothing may sit between that read and the seek (above). A refusal below puts them back (`cancelTransition`).
    if (activeTransition) {
      const own = { from: channelEq(fromDeckId), to: channelEq(toDeckId) }
      activeTransition.eq = { own, byHand: { from: new Set(), to: new Set() }, style: cfg.bassSwap }
      applyMixEq(activeTransition, 'to', vocalSwap ? swapIncoming(own.to) : incomingUnderA(own.to))
    }
    const joinedFromSec = fromEngine.position
    const joinedAtTime = engine.currentTime
    // The wait joins on the first yellow line crossed in a window up to a bar after `waitUntilSec` (`exitWaitStatus`). For a handoff that
    // would be a bar late against a plan whose swap and fade are fixed seconds of A — B's voice a bar before A is out, the run-in a bar
    // short. Not started instead, and said.
    if (handoff && waitUntilSec != null && joinedFromSec > waitUntilSec + barSecOf(fromGrid) / 4) {
      giveUp(`${mixName} לא התחילה — דק ${fromDeckId} עבר את ${formatMinSec(waitUntilSec)} לפני ש-${toDeckId} נכנס. בחר שוב בחלון של Mix Assist.`)
      return
    }
    const enterSec = phaseAlignedEntrySec(entrySec, toGrid, joinedFromSec, fromGrid)
    toEngine.seek(enterSec)
    toEngine.play()
    if (activeTransition) activeTransition.joinedFromSec = joinedFromSec
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
    // `syncDeck` is a toggle: on a deck whose SYNC was already on it would switch it OFF, and B would drift against A for the whole join —
    // for a handoff, up to 16 bars of drift under bar maths that assume the two are locked.
    if (!useStore.getState().decks[toDeckId].syncActive) syncDeck(toDeckId)
    const barSecFrom = barSecOf(fromGrid)
    // A handoff runs on A's own seconds, from the join to the plan's fade end, the bass swap on the handoff. A plain transition runs on the
    // wall clock (as before v0.9.18: `TRANSITION_CROSSFADE_SEC`), so its bar is A's bar at A's current tempo.
    const barWallFrom = barSecFrom / deckRate(useStore.getState().decks[fromDeckId].baseRate, useStore.getState().decks[fromDeckId].tempo, cfg.tempoRange)
    if (activeTransition) {
      const meter = new KickMeter(fromEngine, toEngine, engine.ctx, (barWallFrom / BEATS_PER_BAR) * 1000)
      meter.start()
      activeTransition.kick = { meter, fromTime: joinedAtTime + KICK_METER_SETTLE_SEC }
    }
    const mixPlan: EqMixPlan = handoff
      ? { joinSec: joinedFromSec, swapSec: handoff.handoffSec, fadeEndSec: handoff.fadeEndSec }
      : plainEqMixPlan(TRANSITION_CROSSFADE_SEC, barWallFrom)

    // v0.9.18: the plain transition's clock starts on A's yellow line, not here — the seek, the store writes and `syncDeck` above take tens of
    // ms on a full UI (v0.4.6 measured up to 280), and the bass swap counts whole bars from this moment, so it would land that late.
    // More than half a bar past a line is not a late frame (the wait joins on the frame that crosses one): then no correction at all.
    const pastLineSec = joinedFromSec - barLineAtOrBeforeSec(joinedFromSec, fromGrid)
    let startedAtSec = joinedAtTime - (pastLineSec >= 0 && pastLineSec < barSecFrom / 2 ? pastLineSec * (barWallFrom / barSecFrom) : 0)
    let lastFromPos = joinedFromSec
    // v0.9.33 (the owner, 07/10): B stays at zero on the crossfader until its kicks sit on A's (`core/kick-lock.ts`) — the join's own
    // alignment is worked out before the seek reaches the audio thread, and that residue used to be heard while B was already rising.
    // The vocal swap is not held: B is meant to be heard from its voice line on, A's voice going down on the same bars (the frames would
    // jump if skipped), and B's LOW — its kick — is killed until the swap anyway.
    let rising = !!vocalSwap
    let lockedAt = joinedAtTime
    let plainShifted = false
    let lastNudgeAt = -Infinity
    const unsubscribeFade = clock.subscribe((t) => {
      // A handoff's crossfader follows A's position, so A must keep moving forward: a loop (or anything that sends A back) would hold the
      // crossfader short of the handoff while B walks into its voice — a voice over a voice, and a transition that never finishes.
      if (handoff) {
        const pos = fromEngine.position
        const looped = useStore.getState().decks[fromDeckId].loopActive
        if (looped || pos < lastFromPos - 0.25) {
          cancelTransition()
          useStore.getState().setNotice({
            text: `${mixName} בוטלה — דק ${fromDeckId} ${looped ? 'נכנס ללופ' : 'חזר אחורה'}, והמיקס תלוי בזה שהוא ממשיך קדימה.`,
            tone: 'warn',
            source: 'sync',
          })
          return
        }
        lastFromPos = pos
      }
      const tr = activeTransition
      if (!tr?.eq) return
      if (!rising) {
        // A plain transition first waits up to `KICK_LOCK_KEEP_START_SEC` past its own start; after that its start is a bar later, and the
        // wait runs to that line — checked every frame up to it, so a gap that opens again after a lock is nudged again, not heard.
        const holdUntil = handoff ? joinedAtTime + KICK_LOCK_MAX_BARS * barWallFrom : plainShifted ? startedAtSec : startedAtSec + KICK_LOCK_KEEP_START_SEC
        const step = kickLockStep(t - joinedAtTime, syncPhaseDeltaSec(toDeckId, toEngine.position), t - lastNudgeAt, holdUntil - joinedAtTime)
        if (step.kind === 'wait') return
        if (step.kind === 'nudge') {
          toEngine.syncNudge(step.deltaSec, KICK_LOCK_NUDGE_SEC)
          lastNudgeAt = t
          return
        }
        if (step.kind === 'timeout' && !handoff && !plainShifted) {
          plainShifted = true
          startedAtSec += KICK_LOCK_PLAIN_SHIFT_BARS * barWallFrom
          return
        }
        if (step.kind === 'locked' && plainShifted && t < startedAtSec) return
        rising = true
        lockedAt = t
        if (tr.kick) tr.kick.fromTime = t + KICK_METER_SETTLE_SEC
        const endAt = startedAtSec + TRANSITION_CROSSFADE_SEC
        useStore.setState((s) => ({
          activeTransition: s.activeTransition ? { ...s.activeTransition, aligning: false, endAtClock: handoff ? null : endAt } : null,
        }))
        // Never silently: a mix that went on without the lock says so, and why — next to whatever this transition already said (an
        // unconfirmed grid, the key sync), not over it.
        const said =
          step.kind === 'timeout'
            ? `הקיקים של דק ${toDeckId} לא התיישרו לגמרי בזמן (עדיין ${Math.round(Math.abs(step.deltaSec) * 1000)} אלפיות שנייה) — המעבר ממשיך, ו-SYNC ממשיך לתקן.`
            : step.kind === 'unmeasured'
              ? `לא הצלחתי למדוד אם הקיקים של דק ${toDeckId} יושבים על של דק ${fromDeckId} (SYNC כבוי?) — המעבר ממשיך בלי לחכות.`
              : null
        if (said) {
          const cur = useStore.getState().notice
          useStore.getState().setNotice({ text: cur && cur !== noticeBefore ? `${cur.text} · ${said}` : said, tone: 'warn', source: 'sync' })
        }
      }
      // v0.9.67d: a bass-hold swap runs for many bars before B's bass returns, with B's kick killed and never gated by the lock above (the plain
      // swap is 3 bars). B's phase is checked every frame until the swap and a gap is nudged out while B's LOW is still down, so the bass that
      // comes in sits on A's — the same lock the other mixes wait for, done here while B plays its voice.
      if (vocalSwap?.bassHold && fromEngine.position < vocalSwap.swapSec && t - joinedAtTime >= KICK_LOCK_SETTLE_SEC && t - lastNudgeAt >= KICK_LOCK_NUDGE_SEC) {
        const gap = syncPhaseDeltaSec(toDeckId, toEngine.position)
        if (gap != null && Math.abs(gap) >= KICK_LOCK_SEC) {
          toEngine.syncNudge(gap, KICK_LOCK_NUDGE_SEC)
          lastNudgeAt = t
        }
      }
      const frame = vocalSwap
        ? vocalSwapFrame(vocalSwap, fromEngine.position, barSecFrom, { a: tr.eq.own.from, b: tr.eq.own.to }, cfg.eqDb)
        : eqMixFrame(
            mixPlan,
            handoff ? fromEngine.position : t - startedAtSec,
            handoff ? barSecFrom : barWallFrom,
            { a: tr.eq.own.from, b: tr.eq.own.to },
            tr.eq.style,
            cfg.eqDb,
          )
      applyMixEq(tr, 'from', frame.a)
      applyMixEq(tr, 'to', frame.b)
      // A handoff kept moving on A's seconds during the wait: B catches up over a beat instead of jumping to where the plan has got to.
      const progress = handoff && !vocalSwap ? frame.progress * catchUpFactor(t - lockedAt, barWallFrom / BEATS_PER_BAR) : frame.progress
      // engine.setCrossfader's own domain is -1 (A only) .. +1 (B only); this
      // maps `progress` onto whichever half of that range moves *away* from
      // `fromDeckId`, in either direction.
      const x = fromDeckId === 'A' ? -1 + 2 * progress : 1 - 2 * progress
      engine.setCrossfader(x, vocalSwap ? SWAP_CROSSFADER_CURVE : AUTO_MIX_CROSSFADER_CURVE)
      useStore.getState().patchMixer({ crossfader: x })
      if (frame.progress >= 1) finishTransition()
    })
    if (activeTransition) activeTransition.unsubscribe = unsubscribeFade
    useStore.setState({
      activeTransition: {
        fromDeckId,
        toDeckId,
        exitPointSec,
        waitingForBar: false,
        waitingUntilSec: null,
        handoffSec: handoff?.handoffSec ?? null,
        onPhrase: waitIsPhrase,
        swap: !!vocalSwap,
        endSec: handoff?.fadeEndSec ?? null,
        endAtClock: null,
        aligning: !vocalSwap,
      },
    })
  }

  const giveUp = (text: string) => {
    cancelTransition()
    useStore.getState().setNotice({ text, tone: 'warn', source: 'sync' })
  }
  let lastPos = fromEngine.position
  let waitStartedAt = engine.currentTime
  let loopNoticeShown = false
  const unsubscribeWait = clock.subscribe((t) => {
    // Grids read fresh every frame, not captured at the click: a grid nudge
    // or "set downbeat here" during the wait moves the yellow lines, and
    // the join must land on the lines the owner is looking at now.
    const { decks: now } = useStore.getState()
    const fromGrid = now[fromDeckId].beatGrid
    const toGrid = now[toDeckId].beatGrid
    if (!fromGrid || !toGrid) {
      giveUp(`Deck ${!fromGrid ? fromDeckId : toDeckId} lost its beat grid — transition not started.`)
      return
    }
    if (!fromEngine.playing) {
      giveUp(`Deck ${fromDeckId} stopped before its next bar line — transition not started.`)
      return
    }
    const pos = fromEngine.position
    const crossed = barLineCrossed(lastPos, pos, fromGrid)
    lastPos = pos
    if (waitUntilSec != null) {
      const status = exitWaitStatus(pos, waitUntilSec, barSecOf(fromGrid))
      if (status === 'passed') {
        giveUp(passedText(waitUntilSec))
        return
      }
      if (status === 'early') {
        // A wait of minutes is the point here, so the two-bar "never reached
        // a bar line" guard below only starts counting once the exit is due.
        waitStartedAt = t
        // A loop closing before the exit second holds the deck in 'early'
        // for as long as it runs. Not a reason to cancel — a DJ may be
        // stretching the song on purpose — but the wait must not look stuck.
        const loopEnd = fromEngine.loopEnd
        const loopHolds = loopEnd != null && now[fromDeckId].loopActive && loopEnd < waitUntilSec
        if (loopHolds && !loopNoticeShown) {
          loopNoticeShown = true
          useStore.getState().setNotice({
            text: handoff
              ? `דק ${fromDeckId} בלופ לפני ${formatMinSec(waitUntilSec)} — ${mixName} מחכה עד שהלופ ישוחרר.`
              : waitIsPhrase
                ? `דק ${fromDeckId} בלופ לפני ${formatMinSec(waitUntilSec)} — דק ${toDeckId} מחכה לתחילת הקטע עד שהלופ ישוחרר.`
                : `Deck ${fromDeckId} is looping before ${formatMinSec(waitUntilSec)} — the excellent mix waits until the loop is released.`,
            tone: 'info',
            source: 'sync',
          })
        } else if (!loopHolds) {
          loopNoticeShown = false
        }
        return
      }
    }
    if (!crossed) {
      // A loop shorter than a bar that holds no yellow line never crosses
      // one. Two bars of waiting (at the tempo the grid says) is past any
      // real wait, so it's that — say so instead of waiting forever.
      if (t - waitStartedAt > 2 * BEATS_PER_BAR * (60 / fromGrid.bpm)) {
        giveUp(`Deck ${fromDeckId} never reached a bar line (a loop without one?) — transition not started.`)
      }
      return
    }
    unsubscribeWait()
    join(fromGrid, toGrid)
  })

  activeTransition = {
    fromDeckId,
    toDeckId,
    toPreState: { positionSec: to.positionSec, playing: to.playing },
    unsubscribe: unsubscribeWait,
    exitPointSec,
    entrySec,
    joinedFromSec: null,
  }
  // v0.9.22: the incoming song moves to a key that fits A while it is still silent. If the key lock's first load outlasts the wait for the
  // bar line, B is already in and fading up — then nothing is switched, and the notice says so (`autoKeySync`).
  void autoKeySync(activeTransition, noticeBefore)
  useStore.setState({
    activeTransition: { fromDeckId, toDeckId, exitPointSec, waitingForBar: true, waitingUntilSec: waitUntilSec, handoffSec: handoff?.handoffSec ?? null, onPhrase: waitIsPhrase, swap: !!vocalSwap, endSec: handoff?.fadeEndSec ?? null, endAtClock: null },
  })
}

/**
 * Mix Assist by sound (v0.9.15): one click on a handoff row. B waits paused until the plan's join line on A — since v0.12.13 a few bars
 * before A's last line ends — enters in its own stretch with no voice, sings where A's transition ends, and A goes down after. Everything else —
 * refusals, the bar alignment, cancel, the rating — is `startAutoTransition`'s, unchanged.
 */
export function startVocalHandoff(fromDeckId: DeckId, toDeckId: DeckId, plan: HandoffPlan) {
  startAutoTransition(fromDeckId, toDeckId, plan.entrySec, plan.joinSec, null, { handoffSec: plan.handoffSec, fadeEndSec: plan.fadeEndSec })
}

/**
 * A vocal-swap row of the Mix Assist panel was clicked (`core/vocal-swap-mix.ts`). Planned again from the live position, as the handoff is.
 * B waits paused until A's voice-end line, starts there on its own voice line (heard at once), and the knobs and the crossfader do the rest.
 */
export function startVocalSwapAt(fromDeckId: DeckId, toDeckId: DeckId, entry: SwapEntry) {
  if (handoffSyncMultiplier(fromDeckId, toDeckId) !== 1) {
    useStore.getState().setNotice({ text: 'החלפת שירה: הדקים יסונכרנו בחצי או בכפול קצב — המיקס מחושב רק לקצב ישר', tone: 'warn', source: 'sync' })
    return
  }
  const a = deckHandoffSide(fromDeckId)
  const b = deckHandoffSide(toDeckId)
  const plan = 'missing' in a || 'missing' in b ? null : planVocalSwap(a, engine.decks[fromDeckId].position, b, entry)
  if (!plan) {
    useStore.getState().setNotice({ text: 'החלפת השירה כבר לא אפשרית מהמקום הזה — בחר שורה אחרת בחלון של Mix Assist.', tone: 'warn', source: 'sync' })
    return
  }
  startAutoTransition(fromDeckId, toDeckId, plan.entrySec, plan.joinSec, null, { handoffSec: plan.voiceSec, fadeEndSec: plan.endSec }, false, plan)
}

/**
 * How SYNC will read the incoming deck against the playing one — straight (1), half- or double-time — computed exactly as `syncDeck` does,
 * from the playing deck's playing BPM. A handoff is planned only for 1 (`core/vocal-handoff.ts`), and the plain transition's vocal line
 * uses it to run B's seconds at the right speed.
 */
export function handoffSyncMultiplier(fromDeckId: DeckId, toDeckId: DeckId): 0.5 | 1 | 2 {
  const { decks } = useStore.getState()
  const from = decks[fromDeckId]
  const to = decks[toDeckId]
  if (!from.bpm || !to.bpm) return 1
  return syncMultiplier(from.bpm * deckRate(from.baseRate, from.tempo, settings.values.tempoRange), centreBpm(to.bpm, to.baseRate), settings.values.tempoRange)
}

/** One deck's voice + grid for a handoff, read from the store the way the deck's vocal strip reads it. */
export function deckHandoffSide(deckId: DeckId): HandoffSide | { missing: string } {
  const s = useStore.getState()
  const deck = s.decks[deckId]
  if (!deck.track) return { missing: 'אין שיר בדק' }
  const vocal = s.library.tracks.find((t) => t.id === deck.track?.id)?.vocal
  const tag = deck.track.contentHash ? s.vocalManual[deck.track.contentHash] : undefined
  // The song's own end, not the file's: a long silent tail is not room for a mix (v0.9.70).
  const side = handoffSide(vocal, tag, deck.beatGrid, songEndSec(deck.audibleEndSec, deck.durationSec))
  return 'missing' in side ? side : { ...side, bands: deck.bands }
}

/**
 * The panel's handoff row was clicked. The panel planned on a position floored to the second; the plan that runs is made again here from the
 * live position, so a join line the panel thought was still ahead is never already behind the playhead.
 */
export function startVocalHandoffAt(fromDeckId: DeckId, toDeckId: DeckId, voice: BVoiceStart) {
  if (handoffSyncMultiplier(fromDeckId, toDeckId) !== 1) {
    useStore.getState().setNotice({ text: HANDOFF_NEEDS_STRAIGHT_SYNC, tone: 'warn', source: 'sync' })
    return
  }
  const a = deckHandoffSide(fromDeckId)
  const b = deckHandoffSide(toDeckId)
  const plan = 'missing' in a || 'missing' in b ? null : planHandoff(a, engine.decks[fromDeckId].position, b, voice)
  if (!plan) {
    useStore.getState().setNotice({ text: 'מסירת השירה כבר לא אפשרית מהמקום הזה — בחר שורה אחרת בחלון של Mix Assist.', tone: 'warn', source: 'sync' })
    return
  }
  startVocalHandoff(fromDeckId, toDeckId, plan)
}

/**
 * v0.9.17: an energy point of the Mix Assist panel was clicked. Until now it joined on A's next yellow line (v0.8.14) — the owner (05/10):
 * "you mixed right away instead of waiting for the right moment … you are supposed to know when to come in by where the verses start". It
 * now waits for the next phrase start of A (`nextPhraseStartSec`): counted from where A's voice starts and stops, or, with no voice to count
 * from, from the grid's first yellow line — and the notice says which, so a count he cannot check is never passed off as his verses.
 * The join is `deckPhraseJoin`'s, and the notice says why there.
 */
export function startAutoTransitionOnPhrase(fromDeckId: DeckId, toDeckId: DeckId, entrySec: number) {
  const phrase = deckPhraseJoin(fromDeckId, engine.decks[fromDeckId].position, { toDeckId, sec: entrySec })
  if (!phrase) {
    startAutoTransition(fromDeckId, toDeckId, entrySec) // no grid: refuses, and says why
    return
  }
  // Singing under the mix is allowed since v0.12.13, but still said — never a silent pick.
  const over = phrase.aVoiceSec != null ? ` דק ${fromDeckId} שר ב-${formatMinSec(phrase.aVoiceSec)}, אז המעבר ירוץ על השירה שלו.` : ''
  const rise = phrase.rise === 'unchecked' ? ` לא בדקתי אם הכניסה קוטעת עלייה של דק ${fromDeckId}: אין עדיין ניתוח עוצמה לשני השירים, או שזו תחילת הקטע האחרונה.` : phrase.rise === 'moved' ? ` הזזתי את הכניסה כדי לא לקטוע עלייה של דק ${fromDeckId} עם התחלה שקטה של דק ${toDeckId} (לפי עוצמה, לא לפי מה שמנגן).` : phrase.rise === 'stuck' ? ` שים לב: דק ${fromDeckId} עולה אחרי הכניסה ודק ${toDeckId} מתחיל שקט, ולא מצאתי נקודה טובה יותר — כדאי לבחור נקודת כניסה אחרת (לפי עוצמה, לא לפי מה שמנגן).` : ''
  startAutoTransition(fromDeckId, toDeckId, entrySec, phrase.sec, `דק ${toDeckId} ייכנס כשדק ${fromDeckId} יגיע ל-${formatMinSec(phrase.sec)} — ${phrase.why}.${over}${rise}`, null, true)
}

/**
 * Where an energy point or a Mix-in pad joins, from `positionSec` of the outgoing deck, and why there — in the owner's words. One function
 * for the panel's line and the click, so the two can only differ by the second the panel's position is floored to. Null without a grid.
 *
 * v0.12.13, the owner (19/10): waiting for A to stop singing is only for joining a voice to a voice (the vocal handoff). From v0.9.63 to
 * here this waited for a stretch where A was quiet for the whole mix, so a click could wait past the moment he heard as the way in (his
 * screenshot: a drum break at 3:09–3:11, the mix at 3:15). Back to A's next phrase start (v0.9.17); `aVoiceSec` still names where A sings
 * in the mix, as a fact.
 * With no voice reading for A, the phrase count from the grid, and the words say A's singing is unknown there.
 */
export function deckPhraseJoin(
  deckId: DeckId,
  positionSec: number,
  entry?: { toDeckId: DeckId; sec: number },
): { sec: number; why: string; aVoiceSec: number | null; rise: 'ok' | 'moved' | 'stuck' | 'unchecked' } | null {
  const deck = useStore.getState().decks[deckId]
  if (!deck.beatGrid) return null
  const side = deckHandoffSide(deckId)
  const grid = deck.beatGrid
  const timeline = 'missing' in side ? null : side.timeline
  const end = songEndSec(deck.audibleEndSec, deck.durationSec)
  let phrase = nextPhraseStartSec(grid, timeline, end, positionSec)
  // v0.12.16 (the owner, 21/10): never join in the middle of a rise of A with a quiet start of B (`core/rise-guard.ts`). With no energy reading
  // of either song nothing is checked, and `rise` stays 'none' — the panel and the notice only claim what was measured.
  let rise: 'ok' | 'moved' | 'stuck' | 'unchecked' = 'ok'
  const to = entry ? useStore.getState().decks[entry.toDeckId] : null
  if (entry && to) {
    // Not run means said so (`unchecked`), never a silent "fine": a song still being analysed has no contour, and a join on A's last bars has no later one to move to.
    if (!deck.bands || !to.bands || phrase.by === 'end') rise = 'unchecked'
    else {
      const a = energyProfileOf(deck.bands, deck.durationSec)
      const b = energyProfileOf(to.bands, to.durationSec)
      const mixSec = plainMixNeedSec(deckId, grid)
      const r = joinWithoutCut(
        phrase.sec,
        (after) => {
          const n = nextPhraseStartSec(grid, timeline, end, after)
          return n.by === 'end' ? null : n.sec
        },
        (join) => riseCutByQuietEntry(a, join, b, entry.sec, mixSec),
      )
      if (r.moved) {
        // `by` follows the second that was chosen, not the first one tried: the reason shown must be true for the join shown.
        phrase = nextPhraseStartSec(grid, timeline, end, r.sec - barSecOf(grid) * 0.5)
        rise = 'moved'
      } else if (r.stuck) rise = 'stuck'
    }
  }
  const aVoiceSec = 'missing' in side ? null : firstVoiceInSec(side, phrase.sec, phrase.sec + plainMixNeedSec(deckId, deck.beatGrid))
  const why =
    phrase.by === 'voice'
      ? 'תחילת קטע'
      : phrase.by === 'grid'
      ? `תחילת קטע, לפי ספירת 8 תיבות מתחילת השיר (${'missing' in side ? `${side.missing} — לא ידוע אם הוא שר שם` : 'אין בו שירה'})`
      : 'אין עוד תחילת קטע לפני סוף השיר, אז בתיבה הבאה'
  return { sec: phrase.sec, why, aVoiceSec, rise }
}

/**
 * How much of A a plain mix covers, in A's own seconds: the fade is wall-clock (`TRANSITION_CROSSFADE_SEC`) and A runs at its rate, plus half
 * a bar, since the real entry can move that much to land on a yellow line, plus the bar(s) the v0.9.33 kick lock may push the start back —
 * without them a quiet stretch that just fits would end with A singing over the tail of the fade.
 */
/** An energy profile is a pass over the whole contour and the panel asks per row on every render: kept per analysis, which `bands` identifies. */
const energyProfiles = new WeakMap<Float32Array, ReturnType<typeof analyzeEnergyProfile>>()
function energyProfileOf(bands: Float32Array, durationSec: number) {
  let p = energyProfiles.get(bands)
  if (!p) energyProfiles.set(bands, (p = analyzeEnergyProfile(bands, durationSec)))
  return p
}

function plainMixNeedSec(deckId: DeckId, grid: BeatGrid): number {
  const deck = useStore.getState().decks[deckId]
  return TRANSITION_CROSSFADE_SEC * deckRate(deck.baseRate, deck.tempo, cfg.tempoRange) + barSecOf(grid) * (0.5 + KICK_LOCK_PLAIN_SHIFT_BARS)
}

/** One bar in track seconds — the unit `exitWaitStatus` measures its window in. */
function barSecOf(grid: BeatGrid): number {
  return BEATS_PER_BAR * (60 / grid.bpm)
}

/**
 * v0.9.26: the 24 bars of v0.9.23 for a mix that starts from a second saved earlier — a "Mix in" pad and an excellent pair. Until then only
 * the panel's own rows were held to it, so a pad saved before v0.9.23 (or a pair rated on a mix that ended near B's end) could still start a
 * mix B could not finish: the owner's 05/10 screenshot, by another door. Refused and said, never started short. True when refused.
 * `durationSec` 0 (not known yet) passes. Only the pair's check before its load can see that, and it checks again after; a pad cannot,
 * since a deck's saved cues are put on it only after the track is decoded.
 */
function refuseTooLateEntry(toDeckId: DeckId, entrySec: number, durationSec: number, grid: Pick<BeatGrid, 'bpm'> | null, source: 'sync' | 'mixRating'): boolean {
  if (!(durationSec > 0) || enoughSongAfterMix(durationSec, grid, plainMixEndInB(entrySec, grid, TRANSITION_CROSSFADE_SEC))) return false
  useStore.getState().setNotice({
    text: `המעבר לא התחיל — אם דק ${toDeckId} ייכנס מ-${formatMinSec(entrySec)}, השיר שלו ייגמר פחות מ-${MIN_BARS_AFTER_MIX} תיבות אחרי שהמיקס מסתיים.`,
    tone: 'warn',
    source,
  })
  return true
}

function passedHandoffText(fromDeckId: DeckId, joinSec: number, mixName: string): string {
  return `דק ${fromDeckId} כבר עבר את ${formatMinSec(joinSec)}, שם B היה צריך להיכנס — ${mixName} לא התחילה. בחר שוב בחלון של Mix Assist.`
}

function passedExitText(fromDeckId: DeckId, exitSec: number): string {
  return `Deck ${fromDeckId} is already past ${formatMinSec(exitSec)}, where this excellent mix went last time — mix not started.`
}

/** `3:05` — the same m:ss the deck header shows, so a notice names a second the owner can find on screen. */
/**
 * The countdown on the cancel button (v0.9.33, the owner, 07/10): how long until the incoming deck comes in (`'join'`, while the mix is
 * waiting for A to reach its line) or until the mix is over (`'end'`), in wall seconds — A's seconds divided by its playback rate, since a
 * deck playing at +6% gets there sooner. `null` when there is nothing honest to count to: a plain transition waiting for its next bar line
 * (under one bar) or a transition no longer running.
 */
export function transitionCountdown(): { to: 'join' | 'end'; sec: number } | null {
  const t = useStore.getState().activeTransition
  if (!t) return null
  const from = useStore.getState().decks[t.fromDeckId]
  const rate = deckRate(from.baseRate, from.tempo, settings.values.tempoRange) || 1
  const pos = engine.decks[t.fromDeckId].position
  if (t.waitingForBar) return t.waitingUntilSec != null ? { to: 'join', sec: Math.max(0, (t.waitingUntilSec - pos) / rate) } : null
  if (t.endSec != null) return { to: 'end', sec: Math.max(0, (t.endSec - pos) / rate) }
  if (t.endAtClock != null) return { to: 'end', sec: Math.max(0, t.endAtClock - engine.currentTime) }
  return null
}

export function formatMinSec(sec: number): string {
  const whole = Math.max(0, Math.floor(sec))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Crossfade reached 100% (ROADMAP.md): the incoming deck becomes
 * master-sync automatically, and the cancel button disappearing (via
 * `activeTransition` clearing) is the only signal the transition ended.
 *
 * v0.5.4: also raises the rating prompt (`App.tsx`'s `TransitionRatingPrompt`)
 * for the exit point this transition actually used, when the outgoing track
 * carries a `contentHash` to key a rating against (`exitPointSec` is always a
 * number since 23/09 — see its computation in `startAutoTransition`). A
 * cancelled transition (`cancelTransition` below) never reaches here, so
 * backing out of a mix never triggers a rating for one that didn't happen.
 *
 * 23/09 (Shalom, running app): the outgoing deck used to keep "playing"
 * silently at the crossfader's extreme — audibly gone, but still marked
 * playing, so nothing on screen said which deck was actually live. `pause`
 * is the same function PAUSE calls by hand; called after the transition's
 * own guards (`activeTransition`/`blockStopOfOutgoingDeck`) are already
 * cleared above, so it runs as a plain pause, not a cancel.
 */
function finishTransition() {
  const t = activeTransition
  if (!t) return
  activeTransition = null
  t.unsubscribe()
  // A is paused below; its knobs go back to where he had them, so the next song on that deck does not start with its bass killed. B's are
  // there already (the swaps end before the fade does); restored too, so a frame skipped at the very end cannot leave one short.
  restoreMixEq(t)
  useStore.setState({ activeTransition: null })
  setMasterDeck(t.toDeckId)
  pause(t.fromDeckId)
  if (cfg.autoSyncGlide) startTempoGlide(t.toDeckId)
  reportKickGap(t)

  const fromTrack = useStore.getState().decks[t.fromDeckId].track
  if (fromTrack) {
    const toTrack = useStore.getState().decks[t.toDeckId].track
    useStore.setState({
      pendingMixRating: {
        fromDeckId: t.fromDeckId,
        contentHash: fromTrack.contentHash,
        trackName: fromTrack.name,
        exitPointSec: t.exitPointSec,
        toContentHash: toTrack?.contentHash,
        toTrackId: toTrack?.id,
        entrySec: t.entrySec,
        // `join` always runs before the fade that reaches here, so this is set;
        // the fallback only keeps the type honest.
        joinedFromSec: t.joinedFromSec ?? t.exitPointSec,
      },
    })
  }
}

/**
 * The cancel button (Mixer.tsx): fixed, prominent, no confirmation dialog.
 * Both decks return to exactly their pre-transition state — the outgoing
 * deck's playback was never touched by this code, so only the EQ knobs the
 * mix turned (v0.9.18: on both decks), the crossfader (back to fully on
 * it) and the incoming deck (paused, seeked back) need restoring —
 * and no further automatic correction fires afterward: clearing
 * `syncActive` here is what keeps `runSyncCorrection`'s loop from touching
 * the incoming deck again once it is silent and paused.
 */
export function cancelTransition() {
  const t = activeTransition
  if (!t) return
  activeTransition = null
  t.unsubscribe()
  t.kick?.meter.stop()
  restoreMixEq(t)
  useStore.setState({ activeTransition: null })

  const toEngine = engine.decks[t.toDeckId]
  toEngine.pause()
  if (t.autoKey) {
    clearKeySync(t.toDeckId)
    if (!t.autoKey.lockWasOn) void toggleKeyLock(t.toDeckId)
  }
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
  if (rating === 'bad') {
    saveBadMix(pendingMixRating)
    return
  }
  if (rating !== 'excellent') return
  saveExcellentMixEntryPad(pendingMixRating)
  if (!pendingMixRating.contentHash) return
  void markExcellent(pendingMixRating.contentHash, pendingMixRating.exitPointSec).catch((err) => {
    console.error('markExcellent failed', err)
  })
  // v0.8.14: the pair only saves when both tracks are already identified —
  // the incoming track's hash can still be missing this soon after it took
  // over (analysis may still be running), and there is no later trigger that
  // would fill it in for this specific transition, so the gap is surfaced
  // rather than silently dropped.
  if (pendingMixRating.toContentHash) {
    void markExcellentPair(
      pendingMixRating.contentHash,
      pendingMixRating.toContentHash,
      pendingMixRating.entrySec,
      pendingMixRating.joinedFromSec,
      pendingMixRating.toTrackId,
    )
      .then(({ dropped }) => {
        useStore.setState((s) => ({ excellentPairsRev: s.excellentPairsRev + 1 }))
        // the cap pushed the oldest remembered point of this pair out — said, not skipped
        if (dropped) {
          useStore.getState().setNotice({
            text: 'This pair already held 12 saved mix-in points; the oldest one was removed to make room.',
            tone: 'info',
            source: 'mixRating',
          })
        }
      })
      .catch((err) => {
        console.error('markExcellentPair failed', err)
      })
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

/**
 * v0.12.14, the owner (21/10): a mix rated Bad must stop coming back, and another one be offered. The pair + the incoming song's entry second
 * is remembered (`mix-bad-idb`); Mix Assist's panel then leaves those rows out and says how many (`TransitionPointsPanel`), so the other
 * rows of the same pair are the alternative. An Excellent saved at the same point is removed — one point is never both. A hash still missing
 * (analysis not done) is said, not skipped, same as the Excellent pair.
 */
function saveBadMix(r: NonNullable<AppState['pendingMixRating']>) {
  const { setNotice } = useStore.getState()
  if (!r.contentHash || !r.toContentHash) {
    setNotice({ text: 'המיקס לא נזכר כרע — אחד השירים עוד לא סיים להיות מזוהה (ניתוח).', tone: 'info', source: 'mixRating' })
    return
  }
  const { contentHash: from, toContentHash: to, entrySec } = r
  void markBadMix(from, to, entrySec)
    .then(() => removeExcellentNear(from, to, entrySec, SAME_BAD_WINDOW_SEC))
    .then(() => {
      useStore.setState((s) => ({ badMixesRev: s.badMixesRev + 1, excellentPairsRev: s.excellentPairsRev + 1 }))
      setNotice({
        text: `המיקס סומן כרע — נקודת הכניסה ${formatMinSec(entrySec)} של השיר הנכנס לא תוצע שוב אחרי השיר הזה. השורות האחרות בחלון Mix Assist נשארו.`,
        tone: 'info',
        source: 'mixRating',
      })
    })
    .catch((err) => {
      console.error('markBadMix failed', err)
      setNotice({ text: 'הדירוג "רע" לא נשמר — המיקס עלול להופיע שוב.', tone: 'warn', source: 'mixRating' })
    })
}

/** The panel's "show again" (v0.12.14): forgets every Bad rating of this pair. */
export function restoreBadMixes(fromHash: string, toHash: string) {
  void clearBadMixes(fromHash, toHash)
    .then(() => useStore.setState((s) => ({ badMixesRev: s.badMixesRev + 1 })))
    .catch((err) => {
      console.error('clearBadMixes failed', err)
      useStore.getState().setNotice({ text: 'לא הצלחתי להחזיר את המיקסים שסומנו כרעים.', tone: 'warn', source: 'mixRating' })
    })
}

/**
 * The "Mix in" pad for an excellent-rated mix (v0.8.14) goes on the incoming
 * track — the deck that took over. Only if that exact track is still there:
 * the rating prompt can sit unanswered while the DJ loads something else,
 * and a pad lands on whatever track is loaded (`persistCues`). Anything that
 * stops the save is said, not skipped.
 */
function saveExcellentMixEntryPad(r: NonNullable<AppState['pendingMixRating']>) {
  const toDeckId: DeckId = r.fromDeckId === 'A' ? 'B' : 'A'
  const st = useStore.getState().decks[toDeckId]
  const verdict = mixEntryVerdict(r, st.track)
  if (verdict !== 'ok') {
    useStore.getState().setNotice({
      text:
        verdict === 'no-hash'
          ? `Mix-in pad not saved — deck ${toDeckId}'s track has no fingerprint yet, so there is nothing to save the pad under.`
          : `Mix-in pad not saved — deck ${toDeckId} no longer holds the track this mix went into.`,
      tone: 'info',
      source: 'mixRating',
    })
    return
  }
  if (hasMixEntryNear(st.hotCues, r.entrySec)) return
  saveMixEntryHotCue(toDeckId, r.entrySec, mixEntryLabel(r.entrySec))
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
  //
  // v0.8.25: and the rows the table actually *draws* when it has told us —
  // Mix Only / hide-played / "more like this" narrow the list inside
  // `Library.tsx`, and walking the sorted list under them moved the
  // highlight onto a hidden row. The sorted list stays the fallback for
  // before the table has rendered once.
  // `null` = the table hasn't drawn yet; `[]` = it drew nothing, so there
  // is no row to move to — falling back there picked a hidden track again.
  const ids = library.visibleIds ?? sortedFilteredTracks().map((t) => t.id)
  if (ids.length === 0) return
  const idx = ids.indexOf(library.selectedId ?? '')
  const nextIdx = idx < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, idx + delta))
  setLibrary({ selectedId: ids[nextIdx] })
  schedulePredecode()
  // The highlight moved by the owner's own hand (arrow keys, the controller's browse wheel): the table scrolls to keep it in view. `Library.tsx` listens.
  window.dispatchEvent(new Event(REVEAL_SELECTION_EVENT))
}

/**
 * Limit the search box to one column (v0.8.25), or `null` for the plain
 * all-fields search. The typed text is kept: switching BPM → Key with "8A"
 * already typed shows the Key result for it straight away.
 */
export function setSearchColumn(column: SearchColumn | null) {
  useStore.getState().setLibrary({ queryColumn: column })
}

/**
 * Limit the table to some genres (v0.9.24), or `null` for all of them. An
 * empty pick is stored as `null`: "no genre ticked" showing an empty table
 * would read as a broken library, not as a filter.
 */
export function setGenreFilter(genres: string[] | null) {
  useStore.getState().setLibrary({ genreFilter: genres && genres.length > 0 ? genres : null })
}

/**
 * Set or clear (`null`) one column's ▾ filter (v0.9.36). Empty values are
 * dropped by `normalizeFilter`, so "nothing ticked" is "no filter", never an
 * empty table.
 */
export function setColumnFilter<C extends FilterColumn>(column: C, value: ColumnFilters[C] | null) {
  const { library, setLibrary } = useStore.getState()
  const next: ColumnFilters = { ...library.columnFilters }
  const v = normalizeFilter(column, value)
  if (v === undefined) delete next[column]
  else next[column] = v
  setLibrary({ columnFilters: next })
}

export function filteredTracks(): Track[] {
  const { library, crates } = useStore.getState()
  const column = library.queryColumn
  const genres = library.genreFilter ? new Set(library.genreFilter) : null
  const cols = library.columnFilters
  const now = Date.now()
  const base = library.tracks.filter(
    (t) =>
      matchesSearch(t, library.query, column) &&
      (!genres || genres.has(t.genre ?? '')) &&
      matchesColumnFilters(t, cols, now),
  )
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
  schedulePredecode()
}

// ————————————————————————————————————————————————————————————————
// Decode the next song ahead (v0.9.66, Premium label, off by default; plan docs/research/predecode-next-plan.md).
// A row that stays selected for PREDECODE_DWELL_MS is decoded into the one slot while the decks play, so loading it later skips the
// 2–3 s the browser's decoder takes (measured on the owner's PC 08/10: deck B load 2008 ms → 343 ms). Not built yet: the Mix Assist
// suggestion and a future full-auto picker as callers; both would call `requestPredecode`.
// ————————————————————————————————————————————————————————————————

let predecodeTimer: ReturnType<typeof setTimeout> | null = null
let predecodeRunning = false
/** What the selection is now: asked again by an in-flight decode so one nobody wants any more is dropped, not stored. */
let predecodeWanted: string | null = null

function predecodeEnabled(): boolean {
  return settings.values.predecodeNext && isPremiumUnlocked('predecodeNext')
}

/** `go`: safe to decode now. `busy`: a deck is loading or a transition is live (retry). `onDeck`: the song is already loaded, nothing to do. */
function predecodeGate(trackId: string): 'go' | 'busy' | 'onDeck' {
  const { decks } = useStore.getState()
  if (decks.A.track?.id === trackId || decks.B.track?.id === trackId) return 'onDeck'
  if (decks.A.loading || decks.B.loading || activeTransition) return 'busy'
  return 'go'
}

function schedulePredecode() {
  if (predecodeTimer) clearTimeout(predecodeTimer)
  predecodeTimer = null
  if (!predecodeEnabled()) return
  predecodeTimer = setTimeout(() => {
    predecodeTimer = null
    void requestPredecode(selectedTrack())
  }, PREDECODE_DWELL_MS)
}

/** Decode `track` into the slot now, if the switch is on and the moment is safe. One decode at a time; the latest request waits its turn. */
export async function requestPredecode(track: Track | undefined) {
  if (!track || !predecodeEnabled()) return
  predecodeWanted = track.id
  if (predecodeRunning) return
  predecodeRunning = true
  try {
    // Loop: a request that arrived mid-decode (the owner kept scrolling) is served once the current one ends.
    let target: Track | undefined = track
    while (target) {
      const wanted = target.id
      const gate = predecodeGate(wanted)
      if (gate === 'go') {
        // Asked again before the expensive step and before storing: a deck load or a transition that began meanwhile, or the song
        // landing on a deck, makes the result worthless (a buffer for a song already loaded would sit in memory with nothing to take it).
        await predecodeTrack(target, (navigator as { deviceMemory?: number }).deviceMemory, () => predecodeWanted === wanted && predecodeEnabled() && predecodeGate(wanted) === 'go')
      } else if (gate === 'busy') {
        // Said, and tried again: the moments a deck loads or a transition runs are the ones the owner hears, so nothing is decoded then.
        setPredecodeStatus({ state: 'skipped', name: target.title ?? target.name, why: 'a deck is loading or a mix is running; trying again in a moment' })
        schedulePredecode()
      }
      const next: Track | undefined = predecodeEnabled() ? selectedTrack() : undefined
      target = next && next.id !== target.id && predecodeWanted === next.id ? next : undefined
    }
  } finally {
    predecodeRunning = false
  }
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
/**
 * v0.9.10b — the owner's hand-made vocal marks. All three are on the deck's own track, keyed by its content hash.
 * Every refusal says why (the project's "never skip silently"); every save that fails says so.
 */
function vocalNotice(text: string, tone: 'warn' | 'info' = 'warn') {
  useStore.getState().setNotice({ text, tone, source: 'library' })
}

async function saveVocalManual(tag: VocalManualTag): Promise<void> {
  useStore.getState().setVocalManual(tag.contentHash, tag)
  try {
    await putVocalManual(tag)
  } catch (err) {
    vocalNotice(`סימוני השירה נשמרו רק עד סגירת האפליקציה: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function manualTagFor(deckId: DeckId): VocalManualTag | null {
  const s = useStore.getState()
  const track = s.decks[deckId].track
  if (!track?.contentHash) return null
  return (
    s.vocalManual[track.contentHash] ?? {
      schema: 1,
      contentHash: track.contentHash,
      trackId: track.id,
      name: track.name,
      genre: track.genre,
      regions: [],
      finished: false,
      updatedAt: Date.now(),
    }
  )
}

/**
 * Drags or nudges one edge of one of his marks. While a drag is going it only updates what is on screen (`persist` false); the pointer-up, and every
 * wheel notch, saves. A time the mark cannot take (see `moveRegionEdge`) leaves it as it was.
 */
export function setVocalRegionEdge(deckId: DeckId, index: number, edge: 'from' | 'to', sec: number, persist: boolean): void {
  const s = useStore.getState()
  const tag = manualTagFor(deckId)
  const moved = tag ? moveRegionEdge(tag.regions, index, edge, sec, s.decks[deckId].durationSec) : null
  if (!tag || !moved) return
  // the black "vocal ended" opened sits on the old edge; once he moves edges by hand it would paint over the new one
  if (s.vocalMarkOpen[deckId]?.afterVoice) cancelOpenVocalMark(deckId)
  const next = { ...tag, regions: moved, updatedAt: Date.now() }
  if (persist) void saveVocalManual(next)
  else s.setVocalManual(tag.contentHash, next)
}

/**
 * Pressed "vocal started" → opens a mark at the play position; pressed again "vocal ended" → closes it, and the black (no voice) starts right there
 * (the owner, 05/10: "when I press 'vocal ended' I expect the black line to start"). That black stays open until the next "vocal started", which
 * closes it where the new voice begins; so marking a song is one press per change, voice and black taking turns.
 */
export async function toggleVocalMark(deckId: DeckId, kind: 'voice' | 'none' = 'voice'): Promise<void> {
  const s = useStore.getState()
  const deck = s.decks[deckId]
  const tag = manualTagFor(deckId)
  if (!deck.track || !tag) {
    vocalNotice('אי אפשר לסמן שירה: אין שיר טעון בדק הזה (או שעוד לא זוהה הקובץ שלו).')
    return
  }
  const open = s.vocalMarkOpen[deckId]
  if (!open) {
    s.setVocalMarkOpen(deckId, { contentHash: tag.contentHash, startSec: deck.positionSec, kind })
    return
  }
  s.setVocalMarkOpen(deckId, null)
  if (open.contentHash !== tag.contentHash) {
    // another song's black that "vocal ended" opened is not his: dropped, and this press does what it says on this song
    if (open.afterVoice) return toggleVocalMark(deckId, kind)
    vocalNotice('סימון השירה שהיה פתוח היה של שיר אחר ולא נשמר.')
    return
  }
  const grid = drawnBarGrid(deck)
  const voiceStarts = (open.kind ?? 'voice') === 'none' && kind === 'voice'
  const added = closeOpenMark(tag.regions, open, deck.positionSec, deck.durationSec, grid, voiceStarts)
  let regions = tag.regions
  if (added.ok) regions = added.regions
  // A black that "vocal ended" opened and that has no length left is not his mark: nothing he pressed is lost (his "ended" is in the voice mark).
  else if (!(open.afterVoice && added.reason === 'too-short')) {
    vocalNotice(added.reason === 'too-short' ? 'הסימון קצר מחצי שנייה ולא נשמר.' : 'הסימון לא נשמר: זמן לא תקין.')
    if (!voiceStarts) return
  }
  if (regions !== tag.regions) await saveVocalManual({ ...tag, regions, updatedAt: Date.now() })
  if (voiceStarts) {
    s.setVocalMarkOpen(deckId, { contentHash: tag.contentHash, startSec: deck.positionSec, kind: 'voice' })
  } else if (added.ok && (open.kind ?? 'voice') === 'voice') {
    const endSec = regions[regions.length - 1].toSec
    if (deck.durationSec - endSec >= MIN_REGION_SEC) s.setVocalMarkOpen(deckId, { contentHash: tag.contentHash, startSec: endSec, kind: 'none', afterVoice: true })
  }
}

/** Cancels a mark that was opened and not yet closed, without saving anything. */
export function cancelOpenVocalMark(deckId: DeckId) {
  useStore.getState().setVocalMarkOpen(deckId, null)
}

export async function undoVocalMark(deckId: DeckId): Promise<void> {
  const s = useStore.getState()
  const open = s.vocalMarkOpen[deckId]
  // The black that "vocal ended" opened is not a press of his: undo means undoing that "ended", so it goes and the voice mark reopens.
  if (open && !open.afterVoice) return cancelOpenVocalMark(deckId)
  if (open) cancelOpenVocalMark(deckId)
  const tag = manualTagFor(deckId)
  if (!tag || tag.regions.length === 0) {
    vocalNotice('אין סימון לבטל בשיר הזה.', 'info')
    return
  }
  const undone = undoLastEnd(tag.regions, drawnBarGrid(s.decks[deckId]))
  await saveVocalManual({ ...tag, regions: undone.regions, updatedAt: Date.now() })
  // back to "started, not yet ended": a wrong "ended" is fixed by pressing it again where it belongs
  if (undone.reopenStartPressSec != null) s.setVocalMarkOpen(deckId, { contentHash: tag.contentHash, startSec: undone.reopenStartPressSec, kind: undone.reopenKind })
}

/**
 * "I finished marking this song": from now on everything he did not mark is "no voice".
 * A song with no voice at all is a valid answer, not a missing one (the owner, 04/10: a quiet song could not be finished because the button
 * wanted at least one mark; his fix: a "no voice in this song" tick beside it turns it on) — finishing with no purple marks makes the whole song
 * "no voice", and the notice says so.
 * A mark still open is closed first at the play position, as if he had pressed its "ended" — finishing must not drop it.
 */
export async function finishVocalMarks(deckId: DeckId): Promise<void> {
  const open = useStore.getState().vocalMarkOpen[deckId]
  // the black "vocal ended" opened: finishing makes the rest black anyway, so it is simply dropped (closing it could be refused as too short)
  if (open?.afterVoice) cancelOpenVocalMark(deckId)
  else if (open) {
    const before = manualTagFor(deckId)?.regions.length ?? 0
    await toggleVocalMark(deckId, open.kind ?? 'voice')
    // refused (too short, another song's mark): its notice says why, and finishing now would replace that notice — he presses again
    if ((manualTagFor(deckId)?.regions.length ?? 0) === before) return
    // closing a voice opens the black after it; on a finished song the rest is black already
    if (useStore.getState().vocalMarkOpen[deckId]?.afterVoice) cancelOpenVocalMark(deckId)
  }
  const tag = manualTagFor(deckId)
  if (!tag) return
  await saveVocalManual({ ...tag, finished: true, updatedAt: Date.now() })
  if (!tag.regions.some((r) => r.kind !== 'none')) vocalNotice('השיר סומן כשיר בלי שירה בכלל: כולו שחור. טעות? "מחק סימונים וחזור לניחוש" מבטל.', 'info')
}

/**
 * "Teach the computer from this song" (the owner's choice 03/10: the button that used to say "back to the computer's guess"): the song becomes a
 * lesson. His marks are the truth for it, the computer's own guess is forgotten (it was wrong, that is why he marked), and the training scripts take
 * only taught songs. Only a finished song can be taught — an unfinished one has marks for the stretch he looked at and nothing about the rest.
 */
export async function teachFromSong(deckId: DeckId): Promise<void> {
  const tag = manualTagFor(deckId)
  const track = useStore.getState().decks[deckId].track
  if (!tag || !track) return
  if (!tag.finished) {
    vocalNotice('קודם לחץ "סיימתי לסמן את השיר": רק שיר גמור אפשר ללמד ממנו.')
    return
  }
  await saveVocalManual({ ...tag, taught: true, taughtAt: Date.now(), updatedAt: Date.now() })
  try {
    await deleteVocalStrip(tag.contentHash, track.genre ?? '')
  } catch (err) {
    vocalNotice(`הניחוש הישן של המחשב לא נמחק מהזיכרון (לא משפיע על מה שמוצג): ${err instanceof Error ? err.message : String(err)}`)
  }
  const { library, setLibrary } = useStore.getState()
  setLibrary({ tracks: library.tracks.map((t) => (t.id === track.id ? { ...t, vocal: { state: 'manual', timeline: null } } : t)) })
  vocalNotice('השיר נכנס ללימוד. הניחוש הישן של המחשב לשיר הזה נמחק.', 'info')
}

/** Takes a song back out of the lessons: its marks stay, the computer's guess for it is recomputed in the background on the next library load. */
export async function unteachSong(deckId: DeckId): Promise<void> {
  const tag = manualTagFor(deckId)
  const track = useStore.getState().decks[deckId].track
  if (!tag || !track) return
  const { taught: _t, taughtAt: _a, ...rest } = tag
  await saveVocalManual({ ...rest, updatedAt: Date.now() })
  const { library, setLibrary } = useStore.getState()
  setLibrary({
    tracks: library.tracks.map((t) => (t.id === track.id ? { ...t, vocal: { state: 'queued', timeline: null, note: 'הוסר מהלימוד — הניחוש יחושב מחדש בטעינה הבאה של הספרייה' } } : t)),
  })
}

/** Throws his marks away and goes back to the computer's guess. The UI asks twice before calling this. */
export async function clearVocalMarks(deckId: DeckId): Promise<void> {
  const track = useStore.getState().decks[deckId].track
  if (!track?.contentHash) return
  useStore.getState().setVocalManual(track.contentHash, null)
  try {
    await deleteVocalManual(track.contentHash)
  } catch (err) {
    vocalNotice(`הסימונים הוסרו רק עד סגירת האפליקציה: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Every song's hand-made marks to a new file the owner names — a backup that survives clearing the browser's data, and the input for training. */
export async function exportVocalMarks(fromDeck?: DeckId): Promise<void> {
  if (fromDeck) pressFlash(`export:${fromDeck}`)
  const day = new Date().toISOString().slice(0, 10)
  try {
    const all = await getAllVocalManual()
    if (all.length === 0) {
      vocalNotice('אין עדיין סימוני שירה לייצא.', 'info')
      return
    }
    const r = await saveTagsJson(vocalMarksExportText(all, Date.now()), `deckmix-vocal-marks-${day}.json`)
    if (r === 'ok') vocalNotice(`יוצאו סימוני שירה של ${all.length} שירים (${all.filter((t) => t.finished).length} מהם גמורים).`, 'info')
  } catch (err) {
    vocalNotice(`סימוני השירה לא יוצאו: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Brings a backup back. A song that already has marks here is KEPT as it is and counted as skipped — an import never overwrites his work —
 * and every mark the file refuses is counted too, with the first reason.
 */
export async function importVocalMarks(): Promise<void> {
  try {
    const text = await pickJsonFileText()
    if (text == null) return
    const { tags, rejected } = parseVocalMarksFile(text)
    const have = await getAllVocalManual()
    const haveHashes = new Set(have.map((t) => t.contentHash))
    let added = 0
    let skipped = 0
    for (const t of tags) {
      if (haveHashes.has(t.contentHash)) {
        skipped++
        continue
      }
      await putVocalManual(t)
      useStore.getState().setVocalManual(t.contentHash, t)
      added++
    }
    const parts = [`נוספו ${added} שירים`]
    if (skipped) parts.push(`${skipped} דולגו כי כבר יש להם סימון כאן`)
    if (rejected.length) parts.push(`${rejected.length} נדחו (${rejected[0].name}: ${rejected[0].reason})`)
    vocalNotice(parts.join(' · '), rejected.length ? 'warn' : 'info')
  } catch (err) {
    vocalNotice(`סימוני השירה לא יובאו: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * v0.9.49: a song on a deck gets its vocal strip and its "more like this" fingerprint now, not when the background passes reach it — those
 * only start after the whole library's BPM pass (06/10: deck A read "vocal: not analysed yet" with 239 rows still queued). Read from the
 * live row, after this load's own analysis marked it analysed: a row that already has both costs nothing. A genre change leaves the strip
 * `queued` ("recomputed at the next load"), and this is what makes that note true.
 */
function jumpDeckTrackQueue(trackId: string) {
  const row = useStore.getState().library.tracks.find((t) => t.id === trackId)
  if (!row || !deckTrackNeeds(row)) return
  // The owner's genre picks are keyed by hash and land on the rows with the hash pass; the strip depends on the genre and is cached under it,
  // so before then it would be worked out — and stored — for the folder's genre instead of his. Waits that pass out (~12s on his library).
  // One waiter per track: reloading the same song while the hash pass runs must not stack them.
  if (!useStore.getState().library.hashesRead) {
    if (waitingForHashes.has(trackId)) return
    waitingForHashes.add(trackId)
    const stop = useStore.subscribe((st) => {
      if (!st.library.hashesRead) return
      stop()
      waitingForHashes.delete(trackId)
      if (st.decks.A.track?.id === trackId || st.decks.B.track?.id === trackId) jumpDeckTrackQueue(trackId)
    })
    return
  }
  const need = deckTrackNeeds(row)
  if (!need) return
  // Already on it in the background (it put the deck track first): a second decode of the same song would only cost memory mid-load.
  const busy = inBackgroundPass(trackId)
  const want = { vocal: need.vocal && !busy, embedding: need.embedding && !busy }
  void analyseDeckTrackNow(row, want, (patch) => {
    const { library, setLibrary } = useStore.getState()
    // The same file only: a rescan in between may have put another track under this id. And a strip only for the genre it was worked out
    // for: a genre changed meanwhile left the row `queued` for the new one, and an old-genre result would read as done (review, 07/10).
    setLibrary({
      tracks: library.tracks.map((t) =>
        t.id === trackId && t.contentHash === row.contentHash && (!patch.vocal || (t.genre ?? '') === (row.genre ?? '')) ? { ...t, ...patch } : t,
      ),
    })
  })
}
const waitingForHashes = new Set<string>()

/** On every load: drop a mark the old track left open (said so), and bring this song's saved marks into memory. */
async function onTrackLoadedForVocalMarks(deckId: DeckId, contentHash: string | undefined) {
  const s = useStore.getState()
  const open = s.vocalMarkOpen[deckId]
  if (open) {
    s.setVocalMarkOpen(deckId, null)
    if (!open.afterVoice) vocalNotice('סימון שירה שהיה פתוח בדק לא נשמר: נטען שיר אחר.')
  }
  if (!contentHash || s.vocalManual[contentHash]) return
  try {
    const tag = await getVocalManual(contentHash)
    if (tag) useStore.getState().setVocalManual(contentHash, tag)
  } catch (err) {
    vocalNotice(`סימוני השירה של השיר לא נקראו: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ───────── v0.9.30 stage 1 experiment: sample marks ─────────
// The owner marks loops and hits by hand; next to them the app shows its own candidates (core/sound/sample-marks.ts) so the two can be
// compared on the same songs. The band frames are computed once per loaded song, only while the setting is on, in short chunks so the
// screen keeps moving; the decoded buffer is not kept.
const sampleFrames: Record<DeckId, { contentHash: string; frames: BandFrames } | null> = { A: null, B: null }
const sampleToken: Record<DeckId, number> = { A: 0, B: 0 }
/** Songs whose saved marks could not be read: marking them is refused, because the first save would replace the unread record. */
const sampleReadFailed = new Set<string>()

function sampleNotice(text: string, tone: 'warn' | 'info' = 'warn') {
  useStore.getState().setNotice({ text, tone, source: 'library' })
}

async function onTrackLoadedForSampleMarks(deckId: DeckId, contentHash: string | undefined, buffer: AudioBuffer) {
  const token = ++sampleToken[deckId]
  sampleFrames[deckId] = null
  const s = useStore.getState()
  s.setSampleFramesFor(deckId, null)
  s.setSampleFramesFailed(deckId, null)
  const open = s.sampleMarkOpen[deckId]
  if (open) {
    s.setSampleMarkOpen(deckId, null)
    sampleNotice('סימון קטע שהיה פתוח בדק לא נשמר: נטען שיר אחר.')
  }
  if (!contentHash) return
  // Always read the saved record, even with the setting off: a mark made later builds on it, and building on an empty one would overwrite his work.
  if (!useStore.getState().sampleMarks[contentHash]) {
    try {
      const tag = await getSampleMarks(contentHash)
      if (tag && !useStore.getState().sampleMarks[contentHash]) useStore.getState().setSampleMarks(contentHash, tag)
      sampleReadFailed.delete(contentHash)
    } catch (err) {
      sampleReadFailed.add(contentHash)
      sampleNotice(`סימוני הקטעים של השיר לא נקראו, אז סימון חדש בשיר הזה חסום כדי לא לדרוס אותם: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!cfg.sampleMarking) return
  try {
    const mono = new Float32Array(buffer.length)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch)
      for (let i = 0; i < mono.length; i++) mono[i] += d[i] / buffer.numberOfChannels
    }
    const frames = createBandFrames(mono.length, buffer.sampleRate)
    for (let f = 0; f < frames.frames; f += 150) {
      if (token !== sampleToken[deckId]) return
      fillBandFrames(mono, frames, f, f + 150)
      await new Promise((r) => setTimeout(r, 0))
    }
    if (token !== sampleToken[deckId] || useStore.getState().decks[deckId].track?.contentHash !== contentHash) return
    sampleFrames[deckId] = { contentHash, frames }
    useStore.getState().setSampleFramesFor(deckId, contentHash)
  } catch (err) {
    useStore.getState().setSampleFramesFailed(deckId, contentHash)
    sampleNotice(`ההצעות של המחשב לקטעים לא חושבו (${err instanceof Error ? err.message : String(err)}). אפשר לסמן ביד בלעדיהן.`)
  }
}

/** The computer's candidates for the song on this deck, or `null` while they cannot be had (no frames yet, or the song has no grid). */
export function sampleCandidatesFor(deckId: DeckId, bars: number): SampleCandidate[] | null {
  const deck = useStore.getState().decks[deckId]
  const f = sampleFrames[deckId]
  const grid = drawnBarGrid(deck)
  if (!f || !grid || f.contentHash !== deck.track?.contentHash) return null
  return rankCandidates(f.frames, grid, deck.durationSec, bars)
}

async function saveSampleMarks(tag: SampleMarkTag): Promise<void> {
  useStore.getState().setSampleMarks(tag.contentHash, tag)
  try {
    await putSampleMarks(tag)
  } catch (err) {
    sampleNotice(`סימוני הקטעים נשמרו רק עד סגירת האפליקציה: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function sampleTagFor(deckId: DeckId): SampleMarkTag | null {
  const s = useStore.getState()
  const track = s.decks[deckId].track
  if (!track?.contentHash) return null
  return (
    s.sampleMarks[track.contentHash] ?? {
      schema: 1,
      contentHash: track.contentHash,
      trackId: track.id,
      name: track.name,
      genre: track.genre,
      regions: [],
      finished: false,
      updatedAt: Date.now(),
    }
  )
}

/** First press opens a mark at the play position, the second closes it. Loops snap to the yellow lines, hits keep the presses. */
export async function toggleSampleMark(deckId: DeckId, kind: SampleKind): Promise<void> {
  const s = useStore.getState()
  const deck = s.decks[deckId]
  const tag = sampleTagFor(deckId)
  if (!deck.track || !tag) {
    sampleNotice('אי אפשר לסמן קטע: אין שיר טעון בדק הזה (או שעוד לא זוהה הקובץ שלו).')
    return
  }
  if (sampleReadFailed.has(tag.contentHash)) {
    sampleNotice('אי אפשר לסמן קטעים בשיר הזה: הסימונים השמורים שלו לא נקראו, וסימון חדש היה דורס אותם. טען את השיר שוב.')
    return
  }
  const open = s.sampleMarkOpen[deckId]
  if (!open) {
    s.setSampleMarkOpen(deckId, { contentHash: tag.contentHash, startSec: deck.positionSec, kind })
    return
  }
  s.setSampleMarkOpen(deckId, null)
  if (open.contentHash !== tag.contentHash) {
    sampleNotice('סימון הקטע שהיה פתוח היה של שיר אחר ולא נשמר.')
    return
  }
  const added = addSampleRegion(tag.regions, open.kind, open.startSec, deck.positionSec, deck.durationSec, drawnBarGrid(deck))
  if (!added.ok) {
    sampleNotice(added.reason === 'too-short' ? 'הסימון קצר מדי ולא נשמר.' : 'הסימון לא נשמר: זמן לא תקין.')
    return
  }
  const grid = drawnBarGrid(deck)
  await saveSampleMarks({ ...tag, regions: added.regions, gridBpm: grid?.bpm, gridOffsetSec: grid?.offsetSec, updatedAt: Date.now() })
}

export async function undoSampleMark(deckId: DeckId): Promise<void> {
  const s = useStore.getState()
  if (s.sampleMarkOpen[deckId]) {
    s.setSampleMarkOpen(deckId, null)
    return
  }
  const tag = sampleTagFor(deckId)
  if (!tag || tag.regions.length === 0) {
    sampleNotice('אין סימון קטע לבטל בשיר הזה.', 'info')
    return
  }
  await saveSampleMarks({ ...tag, regions: removeLastSample(tag.regions), updatedAt: Date.now() })
}

/**
 * "I listened to the whole song": from now on what he did not mark counts as "not worth keeping". What the app showed him (its top guesses for
 * 2, 4 and 8 bars) is written into the song's record at this moment, so the comparison afterwards needs no audio. If the guesses are not there
 * (no grid, frames not ready) the record says so by having none, and the notice says it too.
 */
export async function finishSampleMarks(deckId: DeckId): Promise<void> {
  const s = useStore.getState()
  if (s.sampleMarkOpen[deckId]) s.setSampleMarkOpen(deckId, null)
  const tag = sampleTagFor(deckId)
  if (!tag) return
  if (sampleReadFailed.has(tag.contentHash)) {
    sampleNotice('אי אפשר לסיים את השיר: הסימונים השמורים שלו לא נקראו. טען את השיר שוב.')
    return
  }
  const shown = [2, 4, 8].flatMap((bars) => sampleCandidatesFor(deckId, bars) ?? [])
  const grid = drawnBarGrid(s.decks[deckId])
  await saveSampleMarks({ ...tag, finished: true, shown, gridBpm: grid?.bpm, gridOffsetSec: grid?.offsetSec, updatedAt: Date.now() })
  if (shown.length === 0) sampleNotice('השיר סומן כגמור, אבל למחשב לא היו הצעות לשיר הזה (אין רשת או שהחישוב לא הסתיים). הסימונים שלך נשמרו.')
}

export async function reopenSampleMarks(deckId: DeckId): Promise<void> {
  const tag = sampleTagFor(deckId)
  if (tag) await saveSampleMarks({ ...tag, finished: false, updatedAt: Date.now() })
}

export async function clearSampleMarks(deckId: DeckId): Promise<void> {
  const tag = sampleTagFor(deckId)
  if (!tag) return
  useStore.getState().setSampleMarks(tag.contentHash, null)
  useStore.getState().setSampleMarkOpen(deckId, null)
  try {
    await deleteSampleMarks(tag.contentHash)
  } catch (err) {
    sampleNotice(`הסימונים הוסרו רק עד סגירת האפליקציה: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The "save" button on one of the computer's candidates: stores it as a loop marked as coming from the computer, so the owner's own marks stay a clean test of it. */
export async function saveSampleCandidate(deckId: DeckId, cand: SampleCandidate): Promise<void> {
  const tag = sampleTagFor(deckId)
  if (!tag) {
    sampleNotice('אי אפשר לשמור קטע: אין שיר טעון בדק הזה (או שעוד לא זוהה הקובץ שלו).')
    return
  }
  if (sampleReadFailed.has(tag.contentHash)) {
    sampleNotice('אי אפשר לשמור: הסימונים השמורים של השיר לא נקראו, ושמירה הייתה דורסת אותם. טען את השיר שוב.')
    return
  }
  const added = addSuggestionRegion(tag.regions, cand)
  if (!added.ok) {
    sampleNotice('ההצעה הזאת כבר שמורה.', 'info')
    return
  }
  const grid = drawnBarGrid(useStore.getState().decks[deckId])
  await saveSampleMarks({ ...tag, regions: added.regions, gridBpm: grid?.bpm, gridOffsetSec: grid?.offsetSec, updatedAt: Date.now() })
}

/**
 * Plays a saved clip on its own deck so he can hear what was stored: a loop repeats between its two edges (the deck's own loop, drawn on the
 * waveform like any other), a hit plays from its start with no loop. Pressing the same loop again stops it.
 */
export function playSampleRegion(deckId: DeckId, index: number): void {
  const s = useStore.getState()
  const tag = sampleTagFor(deckId)
  const r = tag?.regions[index]
  if (!r) return
  const st = s.decks[deckId]
  if (r.kind === 'loop') {
    if (st.loopActive && st.loopRange && Math.abs(st.loopRange.startSec - r.fromSec) < 1e-3 && Math.abs(st.loopRange.endSec - r.toSec) < 1e-3) {
      stopLoop(deckId)
      s.patchDeck(deckId, { loopActive: false })
      return
    }
    seekDeck(deckId, r.fromSec)
    startLoop(deckId, r.fromSec, r.toSec)
    s.patchDeck(deckId, { loopActive: true })
  } else {
    if (st.loopActive) {
      stopLoop(deckId)
      s.patchDeck(deckId, { loopActive: false })
    }
    seekDeck(deckId, r.fromSec)
  }
  play(deckId)
}

/**
 * Puts a saved clip on the first empty sampler pad, as its own recording: the clip's samples are cut from the song (decoded again from the file,
 * the deck's own buffer is not kept) and stored the way a live recording is, so the pad keeps working after a reload and never depends on the
 * song staying in the library. A loop goes in as a looping pad, a hit as a one-shot. Never overwrites an occupied pad; with all 16 full it says so.
 */
let sendingToPad = false

export async function sendSampleToPad(deckId: DeckId, index: number): Promise<void> {
  const s = useStore.getState()
  const track = s.decks[deckId].track
  const r = sampleTagFor(deckId)?.regions[index]
  if (!track || !r) {
    sampleNotice('אי אפשר לשלוח לפד: אין שיר טעון או שהקטע כבר לא קיים.')
    return
  }
  // One at a time: two presses would pick the same empty pad while the first still decodes.
  if (sendingToPad) {
    sampleNotice('קטע אחר עדיין עובר לפד. המתן רגע ונסה שוב.', 'info')
    return
  }
  sendingToPad = true
  useStore.getState().clearNotice('sampler')
  let recordingId: string | null = null
  try {
    await initAudio()
    const buffer = await engine.decode(await readTrackData(track))
    const sr = buffer.sampleRate
    const from = Math.max(0, Math.floor(r.fromSec * sr))
    const to = Math.min(buffer.length, Math.ceil(r.toSec * sr))
    if (to - from < 1) throw new Error('הקטע ריק')
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch).slice(from, to))
    const clip = engine.sampler.buildBuffer(channels, sr)
    // The pad is chosen only now, after the slow decode, and taken in the same step: nothing awaits between the check and the patch.
    const slotIndex = useStore.getState().sampler.slots.findIndex((sl) => !isSamplerSlotOccupied(sl))
    if (slotIndex < 0) {
      sampleNotice('כל 16 הפדים של הסמפלר תפוסים. רוקן פד ונסה שוב.')
      return
    }
    engine.sampler.loadSlot(slotIndex, clip)
    engine.sampler.setGain(slotIndex, useStore.getState().sampler.slots[slotIndex].gain)
    recordingId = crypto.randomUUID()
    const m = Math.floor(r.fromSec / 60)
    // Set even if the save below fails, as a live recording does: the pad stays visibly occupied and playable for this session.
    useStore.getState().patchSamplerSlot(slotIndex, {
      trackId: null,
      contentHash: undefined,
      recordingId,
      trackName: `${track.title ?? track.name} ${m}:${String(Math.floor(r.fromSec % 60)).padStart(2, '0')}`,
      bpm: track.bpm ?? undefined,
      syncEnabled: false,
      playing: false,
    })
    setSamplerSlotMode(slotIndex, r.kind === 'loop' ? 'loop' : 'oneShot')
    let saved = true
    try {
      await saveRecordingBlob(recordingId, new Blob([encodeWav(channels, sr) as unknown as BlobPart], { type: 'audio/wav' }))
    } catch (err) {
      saved = false
      console.error('sample to pad: recording save failed', err)
      useStore.getState().setNotice({
        text: `הקטע בפד ${slotIndex + 1} ינוגן עד סגירת האפליקציה בלבד, הוא לא נשמר (${err instanceof Error ? err.message : String(err)}).`,
        tone: 'warn',
        source: 'sampler',
      })
    }
    await persistSamplerBank()
    if (saved) sampleNotice(`הקטע נשמר בפד ${slotIndex + 1} של הסמפלר (SMPL).`, 'info')
  } catch (err) {
    console.error('sample to pad failed', err)
    if (recordingId) void deleteRecordingBlob(recordingId)
    sampleNotice(`הקטע לא הועבר לפד: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    sendingToPad = false
  }
}

/** Deletes one saved clip (the owner's button on its row). */
export async function removeSampleRegion(deckId: DeckId, index: number): Promise<void> {
  const tag = sampleTagFor(deckId)
  if (!tag || !tag.regions[index]) return
  if (sampleReadFailed.has(tag.contentHash)) {
    sampleNotice('אי אפשר למחוק: הסימונים השמורים של השיר לא נקראו. טען את השיר שוב.')
    return
  }
  await saveSampleMarks({ ...tag, regions: tag.regions.filter((_, i) => i !== index), updatedAt: Date.now() })
}

/** Jumps to the computer's next candidate after the playhead (wrapping to the first), so he can listen to what it picked. */
export function seekNextSampleCandidate(deckId: DeckId, bars: number): void {
  const c = sampleCandidatesFor(deckId, bars)
  if (!c || c.length === 0) {
    sampleNotice('אין הצעות של המחשב לשיר הזה (חסרה רשת פעימות, או שהחישוב עוד לא הסתיים).', 'info')
    return
  }
  const pos = useStore.getState().decks[deckId].positionSec
  seekDeck(deckId, (c.find((x) => x.fromSec > pos + 0.2) ?? c[0]).fromSec)
}

/** Brings a backup back. A song that already has marks here is KEPT as it is and counted as skipped; every mark the file refuses is counted too, with the first reason. */
export async function importSampleMarks(): Promise<void> {
  try {
    const text = await pickJsonFileText()
    if (text == null) return
    const { tags, rejected } = parseSampleMarksFile(text)
    const haveHashes = new Set((await getAllSampleMarks()).map((t) => t.contentHash))
    let added = 0
    let skipped = 0
    for (const t of tags) {
      if (haveHashes.has(t.contentHash)) {
        skipped++
        continue
      }
      await putSampleMarks(t)
      useStore.getState().setSampleMarks(t.contentHash, t)
      added++
    }
    const parts = [`נוספו ${added} שירים`]
    if (skipped) parts.push(`${skipped} דולגו כי כבר יש להם סימון כאן`)
    if (rejected.length) parts.push(`${rejected.length} נדחו (${rejected[0].name}: ${rejected[0].reason})`)
    sampleNotice(parts.join(' · '), rejected.length ? 'warn' : 'info')
  } catch (err) {
    sampleNotice(`סימוני הקטעים לא יובאו: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function exportSampleMarks(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  try {
    const all = await getAllSampleMarks()
    if (all.length === 0) {
      sampleNotice('אין עדיין סימוני קטעים לייצא.', 'info')
      return
    }
    const r = await saveTagsJson(sampleMarksExportText(all, Date.now()), `deckmix-sample-marks-${day}.json`)
    if (r === 'ok') sampleNotice(`יוצאו סימוני קטעים של ${all.length} שירים (${all.filter((t) => t.finished).length} מהם גמורים).`, 'info')
  } catch (err) {
    sampleNotice(`סימוני הקטעים לא יוצאו: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * v0.9.71: the "check the 1" queue. Songs whose "1" he has not checked (no owner grid record yet) are loaded one after another onto a
 * stopped deck and played from a bar line; one press says the yellow line is right, moves it to the playhead, or skips. Every answer
 * but a skip is written the way a hand edit is (`persistGridCorrection`), so it is what the next load of that song uses.
 * A skip is counted on screen and the song stays unchecked for the next run.
 */
const barOneQ = {
  order: [] as Track[],
  visited: new Set<string>(),
  checked: new Set<string>(),
  /** The run whose advance is in flight (0 = none): a stopped run's late loop must not block the next run. */
  busyRun: 0,
  run: 0,
  deckId: 'A' as DeckId,
  current: null as Track | null,
  doneCount: 0,
  skipped: 0,
  /** Why songs were skipped without an answer (no grid), kept for the closing message: a single notice slot would otherwise lose it. */
  noGrid: [] as string[],
  /** Songs found already checked only once loaded (identified late, or under another file name): counted, never silently dropped. */
  alreadyChecked: 0,
  /** A start or an answer is in flight: a second click while it runs must not repeat it. */
  working: false,
}

function barOneNotice(text: string, tone: 'warn' | 'info' = 'warn') {
  useStore.getState().setNotice({ text, tone, source: 'grid' })
}

function barOneSet(patch: Partial<NonNullable<ReturnType<typeof useStore.getState>['barOneQueue']>>) {
  const q = useStore.getState().barOneQueue
  if (q) useStore.getState().setBarOneQueue({ ...q, ...patch })
}

/** The content hashes that already carry a readable owner grid. Throws on a blocked IndexedDB: an empty set would queue every song again. */
async function ownerCheckedHashes(): Promise<Set<string>> {
  const out = new Set<string>()
  for (const { contentHash, value } of await getAllGridCorrections()) {
    if ((value as { source?: string } | null)?.source !== 'owner') continue
    const r = resolveGridCorrection(value)
    if (r && 'grid' in r) out.add(contentHash)
  }
  return out
}

/** v0.9.73: the library's "1 not checked" count reads this set; a save adds to it at once so the number never lags behind a press. */
function markOwnerChecked(hash: string): void {
  const cur = useStore.getState().ownerCheckedHashes
  if (cur && !cur.has(hash)) useStore.getState().setOwnerCheckedHashes(new Set(cur).add(hash))
}

/** Re-reads which songs carry an owner grid. A failed read says so and leaves the count off: an empty set would claim every song is unchecked. */
export async function refreshOwnerChecked(): Promise<void> {
  try {
    // Merged with what a press saved while this read was in flight: the read may hold an older snapshot.
    const read = await ownerCheckedHashes()
    const now = useStore.getState().ownerCheckedHashes
    useStore.getState().setOwnerCheckedHashes(now ? new Set([...read, ...now]) : read)
  } catch (err) {
    useStore.getState().setOwnerCheckedHashes(null)
    useStore.getState().setNotice({
      text: `The saved grids could not be read, so "songs not checked yet" is not shown: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'grid',
    })
  }
}

export async function startBarOneQueue(): Promise<void> {
  if (useStore.getState().barOneQueue || barOneQ.working) return
  if (barOneQ.busyRun !== 0) {
    barOneNotice('The previous run is still finishing its last load. Try again in a moment.')
    return
  }
  const { decks } = useStore.getState()
  if (engine.decks.A.playing || engine.decks.B.playing) {
    barOneNotice('A deck is playing. Stop both decks first: checking plays each song through the speakers.')
    return
  }
  barOneQ.working = true
  try {
    barOneQ.checked = await ownerCheckedHashes()
  } catch (err) {
    barOneQ.working = false
    barOneNotice(`The saved grids could not be read, so the queue was not started: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  barOneQ.working = false
  barOneQ.order = queueOrder(useStore.getState().library.tracks, barOneQ.checked)
  barOneQ.visited = new Set()
  barOneQ.doneCount = 0
  barOneQ.skipped = 0
  barOneQ.noGrid = []
  barOneQ.alreadyChecked = 0
  barOneQ.run++
  barOneQ.deckId = decks.A.track == null ? 'A' : decks.B.track == null ? 'B' : 'A'
  if (barOneQ.order.length === 0) {
    barOneNotice('Every song in the list already has a "1" you checked.', 'info')
    return
  }
  useStore.getState().setBarOneQueue({ deckId: barOneQ.deckId, name: '', phase: 'loading', remaining: barOneQ.order.length, checked: 0, skipped: 0 })
  await advanceBarOne()
}

async function advanceBarOne(): Promise<void> {
  const run = barOneQ.run
  if (barOneQ.busyRun === run || !useStore.getState().barOneQueue) return
  barOneQ.busyRun = run
  const aborted = () => run !== barOneQ.run || !useStore.getState().barOneQueue
  try {
    for (;;) {
      const track = nextInQueue(barOneQ.order, barOneQ.visited)
      if (!track) {
        if (engine.decks[barOneQ.deckId].playing) togglePlay(barOneQ.deckId)
        barOneNotice(`${barOneSummary()} No more songs in the queue.`, barOneQ.noGrid.length > 0 ? 'warn' : 'info')
        useStore.getState().setBarOneQueue(null)
        return
      }
      barOneQ.visited.add(track.id)
      barOneQ.current = track
      const deckId = barOneQ.deckId
      if (engine.decks[deckId].playing) togglePlay(deckId)
      barOneSet({ name: track.title ?? track.name, phase: 'loading', remaining: queueRemaining(barOneQ.order, barOneQ.visited, barOneQ.checked), checked: barOneQ.doneCount, skipped: barOneQ.skipped })
      await loadTrackToDeck(deckId, track)
      if (aborted()) return
      // Loading finishes before the analysis does; the "1" can only be answered once the grid is there.
      // The grid can lag the load by a moment, so a missing grid gets a short grace; a running analysis gets up to 90 s. A song whose
      // analysis ended with no grid goes straight to the skip below instead of keeping the owner waiting.
      const graceEnd = Date.now() + 5_000
      const deadline = Date.now() + 90_000
      while (!aborted() && Date.now() < deadline) {
        if (useStore.getState().decks[deckId].track?.id !== track.id) break
        const noGridYet = useStore.getState().decks[deckId].beatGrid == null
        if (deckAnalysisPending[deckId] == null && !(noGridYet && Date.now() < graceEnd)) break
        await new Promise((r) => setTimeout(r, 200))
      }
      if (aborted()) return
      const d = useStore.getState().decks[deckId]
      if (d.track?.id !== track.id || !d.beatGrid) {
        barOneQ.skipped++
        barOneQ.noGrid.push(track.title ?? track.name)
        barOneNotice(`"${track.title ?? track.name}" has no beat grid to check (it did not load or the analysis found none). It stays unchecked.`)
        continue
      }
      const hash = d.track?.contentHash
      if (hash && barOneQ.checked.has(hash)) {
        barOneQ.alreadyChecked++ // identified only now, and already checked: counted in the summary
        continue
      }
      seekDeck(deckId, checkStartSec(d.durationSec, d.beatGrid))
      togglePlay(deckId)
      barOneSet({ phase: 'ready', remaining: queueRemaining(barOneQ.order, barOneQ.visited, barOneQ.checked) })
      return
    }
  } finally {
    if (barOneQ.busyRun === run) barOneQ.busyRun = 0
  }
}

/** 'yes' = the yellow line is on the 1; 'here' = the 1 is where the playhead is now; 'skip' = leave it unchecked. */
export async function answerBarOne(answer: 'yes' | 'here' | 'skip'): Promise<void> {
  const q = useStore.getState().barOneQueue
  if (!q || q.phase !== 'ready' || barOneQ.working || barOneQ.busyRun === barOneQ.run) return
  const run = barOneQ.run
  const deckId = q.deckId
  const st = useStore.getState().decks[deckId]
  // The bar names one song; the answer belongs to that song only. If something else was loaded on this deck meanwhile (library, MIDI),
  // an answer would be saved to the wrong file, so the run ends instead.
  if (st.track?.id !== barOneQ.current?.id) {
    barOneNotice('Another song was loaded on this deck, so the run was stopped and nothing was saved for it.')
    stopBarOneQueue()
    return
  }
  const hash = st.track?.contentHash
  barOneQ.working = true
  barOneSet({ phase: 'loading' }) // synchronous: a second click finds the buttons off and the latch on
  try {
    if (answer === 'skip') {
      barOneQ.skipped++
    } else {
      if (answer === 'yes' && !st.beatGrid) {
        barOneNotice('This song has no beat grid to confirm. Use "The 1 is here" or skip.')
        barOneSet({ phase: 'ready' })
        return
      }
      if (answer === 'yes' && !gridEditAllowed(deckId)) {
        barOneSet({ phase: 'ready' })
        return
      }
      // Confirming always writes a record, even over a grid detection already trusted: that record is what makes the song "checked".
      let saved: boolean
      if (answer === 'yes') saved = await persistGridCorrection(deckId)
      else if (st.beatGrid && gridEditAllowed(deckId)) {
        // The press only picks the beat; the grid's own beat positions stay (see barLineAtNearestBeat).
        const next = barLineAtNearestBeat(st.beatGrid, engine.decks[deckId].position)
        useStore.getState().patchDeck(deckId, { beatGrid: next, bpm: next.bpm, beatGridConfirmed: true })
        saved = await persistGridCorrection(deckId)
      } else saved = await setDownbeatHere(deckId) // no grid yet: the plain playhead is all there is
      if (run !== barOneQ.run) return // Stop was pressed while it saved; the queue is gone and must not move on
      if (!saved) {
        barOneNotice('The answer was not saved (see the message above). Try again or skip.')
        barOneSet({ phase: 'ready' })
        return
      }
      if (answer === 'yes') useStore.getState().patchDeck(deckId, { beatGridConfirmed: true })
      if (hash) barOneQ.checked.add(hash)
      barOneQ.doneCount++
    }
  } finally {
    barOneQ.working = false
  }
  await advanceBarOne()
}

function barOneSummary(): string {
  const names = barOneQ.noGrid.slice(0, 3).map((n) => `"${n}"`).join(', ')
  const noGrid = barOneQ.noGrid.length > 0 ? ` No beat grid, so not shown: ${names}${barOneQ.noGrid.length > 3 ? ` and ${barOneQ.noGrid.length - 3} more` : ''} (see "analysis failed" in the library bar).` : ''
  return `Checked ${barOneQ.doneCount}, skipped ${barOneQ.skipped}${barOneQ.alreadyChecked > 0 ? `, ${barOneQ.alreadyChecked} already checked under another name` : ''}.${noGrid}`
}

export function stopBarOneQueue(): void {
  const q = useStore.getState().barOneQueue
  if (!q) return
  barOneQ.run++
  if (engine.decks[q.deckId].playing) togglePlay(q.deckId)
  barOneNotice(`Stopped. ${barOneSummary()}`, 'info')
  useStore.getState().setBarOneQueue(null)
}

/**
 * v0.9.69 experiment: every grid he fixed by hand against what the analyzer detected for the same file. Songs whose record cannot be
 * used are counted in `refused` (with the first reason), never dropped; a corrected song with no current-version detection stays in
 * the rows as `no-detection`.
 */
export async function loadGridCheckRows(): Promise<{ rows: DriftRow[]; refused: number; firstRefusal: string | null; detectorRecords: number }> {
  const [stored, detected] = await Promise.all([getAllGridCorrections(), getAllDetectedGrids()])
  const names = new Map<string, string>()
  for (const t of useStore.getState().library.tracks) if (t.contentHash && !names.has(t.contentHash)) names.set(t.contentHash, t.title ?? t.name)
  const rows: DriftRow[] = []
  let refused = 0
  let firstRefusal: string | null = null
  let detectorRecords = 0
  for (const { contentHash, value } of stored) {
    const source = (value as { source?: string } | null)?.source
    if (source === 'detector') {
      detectorRecords++
      continue
    }
    // Anything that is not a readable owner record is counted as refused (a damaged one that lost `source` included), never skipped.
    const r = resolveGridCorrection(value)
    if (!r || 'refused' in r) {
      refused++
      firstRefusal ??= r ? r.refused : 'empty record'
      continue
    }
    const d = detected.get(contentHash)
    rows.push(
      compareGrid({
        contentHash,
        name: names.get(contentHash) ?? null,
        hand: { ...r.grid, tempoByHand: r.tempoByHand },
        detected: d?.grid ?? null,
        durationSec: d?.durationSec ?? null,
      }),
    )
  }
  return { rows, refused, firstRefusal, detectorRecords }
}

export async function exportGridCheck(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  try {
    const { rows } = await loadGridCheckRows()
    if (rows.length === 0) {
      sampleNotice('אין עדיין רשתות שתיקנת ביד לייצא.', 'info')
      return
    }
    const r = await saveTagsJson(gridCheckExportText(rows, Date.now()), `deckmix-grid-check-${day}.json`)
    if (r === 'ok') sampleNotice(`יוצאה השוואת רשת הקצב של ${rows.length} שירים.`, 'info')
  } catch (err) {
    sampleNotice(`השוואת הרשת לא יוצאה: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function setTrackGenre(trackId: string, genre: string) {
  const { library, setLibrary, setNotice } = useStore.getState()
  setLibrary({
    // The strip depends on the genre (the model's genre column, the Trance rule): it is marked for recomputing, with the reason on screen.
    tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, genre, vocal: t.vocal ? { state: 'queued' as const, timeline: null, note: 'הז׳אנר השתנה — יחושב מחדש בטעינה הבאה' } : t.vocal } : t)),
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
 * The owner's own BPM and/or key for a track (v0.8.38) — typed from what
 * Beatport shows, in the Library's check panel. Same shape as `setTrackNote`:
 * the row changes at once, the value is kept by content hash, and a failed
 * save is said on screen with the track's name. A deck holding the track takes
 * the key at once (`setLibrary` → `decksFollowLibraryKeys`); the BPM only on
 * its next load — Shalom's decision (25/09), so a playing track and a deck
 * synced to it never jump mid-mix. The panel says so.
 */
export async function setTrackTempoKey(trackId: string, value: { bpm?: number; key?: ParsedKey }): Promise<boolean> {
  const { library, setLibrary, setNotice } = useStore.getState()
  const track = library.tracks.find((t) => t.id === trackId)
  if (!track) return false
  const owner = { bpm: value.bpm, key: value.key?.key, camelot: value.key?.camelot }
  setLibrary({ tracks: library.tracks.map((t) => (t.id === trackId ? applyOwnerMeta(t, owner) : t)) })
  try {
    await persistOwnerTempoKey(trackId, owner, {})
    return true
  } catch (err) {
    setNotice({
      text: `BPM/key for "${track.title ?? track.name}" applied but not saved: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'library',
    })
    return false
  }
}

/**
 * "Back to original" (v0.8.38): drops what the owner typed and puts back what
 * a rescan would show — the file's tag, else the analysis. Awaited before the
 * row changes, unlike `setTrackTempoKey`: the original has to be read from the
 * file first, and a row that briefly showed "–" would read as data lost.
 */
export async function revertTrackTempoKey(trackId: string, fields: { bpm: boolean; key: boolean }) {
  const { setNotice } = useStore.getState()
  const track = useStore.getState().library.tracks.find((t) => t.id === trackId)
  if (!track) return
  try {
    const hash = await ensureContentHash(trackId)
    const original = await readOriginalTempoKey(track, hash)
    await setOwnerTempoKey(hash, {}, fields)
    const { library, setLibrary } = useStore.getState()
    setLibrary({ tracks: library.tracks.map((t) => (t.id === trackId ? clearOwnerMeta(t, original, fields) : t)) })
  } catch (err) {
    setNotice({
      text: `"${track.title ?? track.name}" kept your BPM/key — going back to the original failed: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'library',
    })
  }
}

async function persistOwnerTempoKey(
  trackId: string,
  owner: { bpm?: number; key?: string; camelot?: string },
  clear: { bpm?: boolean; key?: boolean },
): Promise<void> {
  if (!useStore.getState().library.tracks.some((t) => t.id === trackId)) return // rescanned since — nothing to persist against
  const hash = await ensureContentHash(trackId)
  // Only the fields the owner actually typed: `undefined` would erase a value
  // he set earlier for the other field.
  const patch = Object.fromEntries(Object.entries(owner).filter(([, v]) => v !== undefined))
  await setOwnerTempoKey(hash, patch, clear)
}

/**
 * The owner's answers to artist suggestions (v0.9.41, `core/artist-suggest.ts`).
 * Same shape as `setTrackNote`: the rows change at once, each answer is kept by
 * content hash, and a save that failed is said on screen with how many and the
 * first track's name. Accepting several at once (the "Accept all" buttons) goes
 * through here too, one file at a time, so a hash that has to be computed for
 * each does not open a few hundred files together.
 */
export async function answerArtistSuggestions(answers: { trackId: string; artist: string; accept: boolean }[]): Promise<void> {
  if (answers.length === 0) return
  const byId = new Map(answers.map((a) => [a.trackId, a]))
  const { library, setLibrary, setNotice } = useStore.getState()
  setLibrary({
    tracks: library.tracks.map((t) => {
      const a = byId.get(t.id)
      if (!a) return t
      return a.accept
        ? { ...t, artist: a.artist, artistSource: 'owner' as const }
        : { ...t, artistRejected: [...new Set([...(t.artistRejected ?? []), a.artist])] }
    }),
  })
  const failed: string[] = []
  let firstError = ''
  for (const a of answers) {
    try {
      if (!useStore.getState().library.tracks.some((t) => t.id === a.trackId)) continue // rescanned since — nothing to keep it against
      const hash = await ensureContentHash(a.trackId)
      await setOwnerArtist(hash, a.accept ? { accept: a.artist } : { reject: a.artist })
    } catch (err) {
      const t = useStore.getState().library.tracks.find((x) => x.id === a.trackId)
      failed.push(t?.title ?? t?.name ?? a.trackId)
      firstError ||= err instanceof Error ? err.message : String(err)
    }
  }
  if (failed.length) {
    setNotice({
      text: `${failed.length} artist answer${failed.length === 1 ? '' : 's'} shown but not saved (first: "${failed[0]}"): ${firstError}`,
      tone: 'warn',
      source: 'library',
    })
  }
}

/**
 * "Search the web" on one row of the no-artist view (v0.9.44). Only the file's
 * name (no extension, no brackets) goes out, only when the owner presses the button, and what comes back is
 * a suggestion like any other — he still says yes or no. Returns null when the
 * request failed (said in a notice, not turned into "found nothing"), and []
 * when the store answered and nobody matched.
 */
export async function lookupArtistOnline(trackId: string): Promise<ArtistOption[] | null> {
  const { library, setNotice } = useStore.getState()
  const track = library.tracks.find((t) => t.id === trackId)
  if (!track || !canLookUp(track)) return []
  const term = lookupTerm(track)
  if (term.length < 2) return []
  try {
    return onlineOptions(term, await itunesLookup.search(term), track.artistRejected ?? [])
  } catch (err) {
    setNotice({ text: `Web search for "${term}" failed: ${err instanceof Error ? err.message : String(err)}`, tone: 'warn', source: 'library' })
    return null
  }
}

/**
 * Undo an artist the owner set in DeckMix (v0.9.41) — the row goes back to
 * having no artist, and to its suggestions. Same shape as the answers above:
 * the screen first, then the store, and a failure said out loud.
 */
export async function clearOwnerArtist(trackId: string): Promise<void> {
  const { library, setLibrary, setNotice } = useStore.getState()
  const track = library.tracks.find((t) => t.id === trackId)
  if (!track || track.artistSource !== 'owner') return
  setLibrary({ tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, artist: undefined, artistSource: undefined } : t)) })
  try {
    await setOwnerArtist(await ensureContentHash(trackId), { clear: true })
  } catch (err) {
    setNotice({
      text: `Undo of the artist "${track.artist}" shown but not saved — it comes back on the next scan: ${err instanceof Error ? err.message : String(err)}`,
      tone: 'warn',
      source: 'library',
    })
  }
}

/** The track's content hash, computed once on demand and kept on the track — same path as `persistTrackNote`. */
async function ensureContentHash(trackId: string): Promise<string> {
  const track = useStore.getState().library.tracks.find((t) => t.id === trackId)
  if (!track) throw new Error('the track is no longer in the library')
  if (track.contentHash) return track.contentHash
  const hash = await hashFile(track.handle)
  const { library, setLibrary } = useStore.getState()
  setLibrary({ tracks: library.tracks.map((t) => (t.id === trackId ? { ...t, contentHash: hash } : t)) })
  return hash
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

export function createSmartCrate(name: string, query: string, queryColumn: SearchColumn | null = null) {
  // Empty until the first explicit refresh — never auto-filled at creation,
  // consistent with "a smart crate updates only on a refresh click."
  const record: CrateRecord = {
    id: crypto.randomUUID(),
    name,
    kind: 'smart',
    query,
    ...(queryColumn ? { queryColumn } : {}),
    materialized: [],
  }
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
    .filter((t) => t.contentHash && matchesSearch(t, record.query!, record.queryColumn))
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


// ————————————————————————————————————————————————————————————————
// Tagging (v0.9.0; the "1" on the waveform since v0.9.1) — Shalom marks the
// "1" and vocals on a sample the app picks; the answers are what v0.9.5's
// detectors get graded on. Behind
// Settings › Library › Tagging, off by default: the screen covers the decks.
// Its audio goes through `engine.previewBus`, never a deck — nothing on a
// deck moves while he tags.
// ————————————————————————————————————————————————————————————————

let tagPlayer: TagPlayer | null = null
function getTagPlayer(): TagPlayer {
  tagPlayer ??= new TagPlayer(engine.ctx, engine.previewBus)
  return tagPlayer
}

/**
 * Bumped by every `tagPrepare` and by `tagClose`. A prepare takes seconds
 * (read, decode, analyse); one that finishes after a newer one started must
 * not become the current song, or the next answer is saved against a track
 * the screen is not showing (v0.9.0 review — the screen's own guard only hid it).
 */
let tagSeq = 0

/** The song on the tagging screen. Module state, like `activeTransition`: an `AudioBuffer` is not store material. */
let tagCurrent: {
  entry: SampleEntry
  name: string
  contentHash: string
  buffer: AudioBuffer
  detectorGrid: BeatGrid | null
  /** The grid the marker starts on — `startGrid` in core/tagging.ts. */
  shownGrid: BeatGrid | null
  /** The owner's saved phase correction `startGrid` did not start from — a save replaces it. */
  replaced: BeatGrid | null
  /** Where each of the song's vocal clips starts, and how it was chosen — one source for playing and for saving, so they cannot disagree. */
  vocalClips: { atSec: number[]; pick: VocalPick[] }
} | null = null

export interface TagTrackView {
  name: string
  genre: string
  holdout: boolean
  contentHash: string
  /** `null` when neither detection nor the owner has a grid for it — the screen says so and offers only "skip". */
  grid: BeatGrid | null
  /** Where the marker starts for each drop spot, biggest jump in energy first. Empty with no grid. */
  marks: number[]
  durationSec: number
  /** The deck waveform's own data, from the same analysis — `null` for the vocal question, which does not analyse. */
  peaks: Float32Array | null
  bands: Float32Array | null
  /** The song had a phase correction of the owner's that the marker does not start from, and saving will replace. */
  replacesCorrection: boolean
  /** How each vocal clip was chosen; all `random` outside the second round. */
  clipPicks: VocalPick[]
}

function tagFail(text: string): null {
  useStore.getState().setNotice({ text, tone: 'warn', source: 'tagging' })
  return null
}

/** Read, hash and decode one sample track, and find where to play it. `null` means it could not be prepared, with the reason on screen. */
export async function tagPrepare(
  entry: SampleEntry,
  opts: { needGrid: boolean; suspectClips?: boolean; reviewClips?: readonly ReviewClip[]; extraAvoid?: readonly number[] },
): Promise<TagTrackView | null> {
  tagStop()
  tagCurrent = null
  const seq = ++tagSeq
  await initAudio()
  const track = useStore.getState().library.tracks.find((t) => t.id === entry.trackId)
  if (!track) return tagFail(`"${entry.trackId}" is no longer in the library — skipped.`)
  const name = track.title ?? track.name
  let buffer: AudioBuffer
  let contentHash: string
  try {
    const data = await readTrackData(track)
    contentHash = await hashBytes(data) // before decode: decode neuters `data`
    buffer = await engine.decode(data)
  } catch (err) {
    return tagFail(`"${name}" could not be opened for tagging: ${err instanceof Error ? err.message : String(err)}`)
  }
  let detectorGrid: BeatGrid | null = null
  let shownGrid: BeatGrid | null = null
  let marks: number[] = []
  let peaks: Float32Array | null = null
  let bands: Float32Array | null = null
  let replaced: BeatGrid | null = null
  if (opts.needGrid) {
    try {
      const hintBpm = await readTagBpm(track)
      const cacheKey = analysisCacheKey(contentHash, hintBpm)
      let analysis = await analysisCache.get(cacheKey)
      if (!analysis) {
        // Copies, not views: the worker transfers what it is given, and this
        // buffer still has to play.
        const pcm = pcmFromAudioBuffer(buffer)
        analysis = await analyzerWorker.analyze({ ...pcm, channels: pcm.channels.map((c) => c.slice()) }, { hintBpm })
        await analysisCache.put(cacheKey, analysis)
      }
      detectorGrid = analysis.beatGrid
      const saved = applySavedGridResult(await loadGridCorrection(contentHash))
      shownGrid = startGrid(detectorGrid, saved ?? detectorGrid)
      // A saved phase that `startGrid` passed over is said on screen and kept in the tag — saving overwrites it.
      if (saved && shownGrid !== saved && Math.abs(saved.offsetSec - (shownGrid?.offsetSec ?? NaN)) > 1e-6) replaced = saved
      peaks = analysis.peaks
      bands = analysis.bands
      if (shownGrid) {
        const b = analysis.bands
        const energy = new Float32Array(b.length / 3)
        for (let i = 0; i < energy.length; i++) energy[i] = b[3 * i] + b[3 * i + 1] + b[3 * i + 2]
        const g = shownGrid
        const beatSec = 60 / g.bpm
        marks = dropSpots(energy, buffer.duration, g).map((spot) => {
          // Back by whole beats, not clamped — a clamp would leave the marker off the grid.
          let m = startMarkSec(spot, g)
          while (m > buffer.duration) m -= beatSec
          return m
        })
      }
    } catch (err) {
      return tagFail(`"${name}" could not be analysed for tagging: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (seq !== tagSeq) return null // a newer song was asked for meanwhile — this one is dropped, not shown
  let vocalClips = { atSec: vocalSpotsSec(entry.trackId, buffer.duration), pick: [] as VocalPick[] }
  vocalClips.pick = vocalClips.atSec.map(() => 'random' as const)
  if (opts.suspectClips) {
    // Main thread, a few seconds: the same detector the app ships, run once to find where it hears singing. A failure is not hidden —
    // the clips fall back to random spots, are saved as `random`, and the screen shows the count of suspect clips.
    // Let the "opening…" text paint first, and drop a song a newer request already replaced before spending seconds on it.
    await new Promise((res) => setTimeout(res, 0))
    if (seq !== tagSeq) return null
    const r = detectVocalTimeline(pcmFromAudioBuffer(buffer))
    if (r.timeline) vocalClips = vocalRound2Clips(entry.trackId, buffer.duration, r.timeline.cells)
    else {
      vocalClips = vocalRound2Clips(entry.trackId, buffer.duration, null)
      tagFail(`"${name}": גלאי השירה לא החזיר תוצאה (${r.state}), לכן כל הקטעים בשיר הזה אקראיים.`)
    }
  }
  if (opts.extraAvoid) {
    vocalClips = { atSec: vocalExtraSpotsSec(entry.trackId, buffer.duration, opts.extraAvoid), pick: vocalClips.atSec.map(() => 'random' as const) }
  }
  if (opts.reviewClips) {
    // The re-check asks the very clips of the first pass, so the spots are the stored ones, not picked again. A clip that is not
    // inside this decoded file (the file changed, or it is shorter than when it was tagged) is refused out loud: judging
    // different audio under the old clip's name would put a wrong pair into the comparison.
    const bad = opts.reviewClips.find((c) => c.contentHash !== contentHash || c.atSec < 0 || c.atSec + VOCAL_CLIP_SEC > buffer.duration + 0.05)
    if (bad) return tagFail(`"${name}": הקובץ השתנה מאז התיוג הראשון (או שהקטע כבר לא בתוכו), לכן אי אפשר לשאול עליו שוב. השיר דולג.`)
    vocalClips = { atSec: opts.reviewClips.map((c) => c.atSec), pick: opts.reviewClips.map(() => 'random' as const) }
  }
  tagCurrent = { entry, name, contentHash, buffer, detectorGrid, shownGrid, replaced, vocalClips }
  return {
    name,
    genre: entry.genre,
    holdout: entry.holdout,
    contentHash,
    grid: shownGrid,
    marks,
    durationSec: buffer.duration,
    peaks,
    bands,
    replacesCorrection: replaced != null,
    clipPicks: vocalClips.pick,
  }
}

/**
 * "Play from here": two bars before the marker, eight in all, a loud click on
 * every "1" counted from the marker. `false` = nothing played. `accent: false`
 * is the blind tie-break before anything is marked (v0.12.8): an even click on
 * every beat, since a loud one would say where somebody thinks the "1" is.
 */
export function tagPlayFrom(markSec: number, accent = true): boolean {
  const c = tagCurrent
  if (!c) return false
  if (!c.shownGrid) {
    tagFail(`"${c.name}" has no beat grid to play clicks on.`)
    return false
  }
  const beatSec = 60 / c.shownGrid.bpm
  const startSec = Math.max(0, markSec - PLAY_LEAD_BARS * BEATS_PER_BAR * beatSec)
  getTagPlayer().playFrom(c.buffer, startSec, PLAY_BARS * BEATS_PER_BAR * beatSec, beatSec, markSec, accent)
  return true
}

/** Where the tagging sound is in the track right now, or `null` — polled by the screen for its moving line. */
export function tagPlayheadSec(): number | null {
  return tagPlayer?.positionSec() ?? null
}

export function tagPlayVocal(clip: number) {
  const c = tagCurrent
  if (!c) return
  const at = c.vocalClips.atSec[clip]
  if (at == null) return
  getTagPlayer().playClip(c.buffer, at, VOCAL_CLIP_SEC)
}

/**
 * The picture of one vocal clip (v0.9.11), from the song already decoded for it — no second decode. `null` means there is no
 * clip to draw (nothing open, or a clip number the song does not have); a failure inside the maths is named on screen
 * and also returns `null`, and the screen says the picture is missing instead of leaving an empty box.
 */
export function tagClipSpectrogram(clip: number): Spectrogram | null {
  const c = tagCurrent
  const at = c?.vocalClips.atSec[clip]
  if (!c || at == null) return null
  try {
    const b = c.buffer
    const from = Math.max(0, Math.floor(at * b.sampleRate))
    const to = Math.min(b.length, Math.floor((at + VOCAL_CLIP_SEC) * b.sampleRate))
    const mono = new Float32Array(Math.max(0, to - from))
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const d = b.getChannelData(ch)
      for (let i = 0; i < mono.length; i++) mono[i] += d[from + i] / b.numberOfChannels
    }
    return clipSpectrogram(mono, b.sampleRate)
  } catch (e) {
    return tagFail(`התמונה של הקטע לא נוצרה (${e instanceof Error ? e.message : String(e)}). אפשר להחליט לפי השמיעה.`)
  }
}

/** Seconds into the vocal clip now playing (0–5), or `null` when it is not playing — the moving line on the picture. */
export function tagClipPlayhead(clip: number): number | null {
  const at = tagCurrent?.vocalClips.atSec[clip]
  const p = tagPlayer?.positionSec()
  if (at == null || p == null) return null
  return Math.max(0, p - at)
}

export function tagStop() {
  tagPlayer?.stop()
}

/** The screen closed: stop, and let the decoded song go — it can be ~100 MB, and the set that follows needs the memory. */
export function tagClose() {
  tagStop()
  tagSeq++
  tagCurrent = null
}

/**
 * The song an answer is for, checked against the one the screen shows. A
 * mismatch is refused out loud: saving it would write a wrong answer, and for
 * the "1" a wrong grid, that nothing on screen would ever reveal.
 */
function tagTarget(shownHash: string): NonNullable<typeof tagCurrent> | null {
  const c = tagCurrent
  if (c && c.contentHash === shownHash) return c
  tagFail('That answer was not saved: the song on screen is no longer the one loaded for tagging. Press Continue to reload it.')
  return null
}

export interface MarkInput {
  answer: MarkAnswer
  /** Required for 'marked'. */
  markSec: number | null
  startMarkSec: number | null
  answerMs: number
  plays: number
  /**
   * Which blind round the answer belongs to, each stored apart: v0.12.8's
   * tie-break (apart from the two answers it settles) or v0.9.5's fresh round.
   * Absent = the waveform round.
   */
  round?: 'decide' | 'fresh'
}

/**
 * Save the "1" as marked on the waveform (v0.9.1). A marked answer is also
 * the owner's grid correction — ROADMAP.md: one store, the tag *is* the fix —
 * and a deck that has this track on it takes the new grid at once. That is
 * also how the three wrong corrections from v0.9.0's first answers get
 * replaced: re-tagging the song overwrites them.
 */
export async function tagSaveMark(shownHash: string, input: MarkInput): Promise<boolean> {
  const c = tagTarget(shownHash)
  if (!c) return false
  const grid = c.shownGrid
  if (input.answer === 'marked' && (!grid || input.markSec == null)) {
    tagFail(`"${c.name}" has no beat grid, so a "1" cannot be saved for it — skip it instead.`)
    return false
  }
  const markSec = input.answer === 'marked' ? input.markSec : null
  const tag: MarkTag = {
    schema: MARK_SCHEMA,
    contentHash: c.contentHash,
    trackId: c.entry.trackId,
    name: c.name,
    genre: c.entry.genre,
    holdout: c.entry.holdout,
    answer: input.answer,
    markSec,
    bpm: grid?.bpm ?? null,
    startMarkSec: input.startMarkSec,
    moved: markSec != null && input.startMarkSec != null && Math.abs(markSec - input.startMarkSec) > 1e-6,
    answerMs: Math.round(input.answerMs),
    plays: input.plays,
    detectorGrid: c.detectorGrid,
    shownGrid: grid,
    replacedCorrection: c.replaced,
    taggedAt: Date.now(),
  }
  try {
    await (input.round === 'decide' ? putDecideTag(tag) : input.round === 'fresh' ? putFreshTag(tag) : putMarkTag(tag))
    if (markSec != null && grid) {
      const next = setDownbeatAt(grid.bpm, markSec)
      // A tempo he set by hand (÷2/×2/Tap) stays his when this answer only moves the "1" on it (v0.9.45).
      const prev = resolveGridCorrection(await getGridCorrection(c.contentHash).catch(() => null))
      const byHand = prev != null && 'grid' in prev && prev.tempoByHand && Math.abs(prev.grid.bpm - next.bpm) < 1e-6
      await putGridCorrection(c.contentHash, ownerCorrection(next, tag.taggedAt, byHand))
      markOwnerChecked(c.contentHash)
      const { decks, patchDeck } = useStore.getState()
      for (const id of ['A', 'B'] as DeckId[]) {
        if (decks[id].track?.contentHash !== c.contentHash) continue
        // The deck takes the new "1", counted as it already was: the answer was about the bar line, and putting the stored octave back on
        // a deck that load had recounted would show the 75 of a song playing at 150 again (v0.9.45 review).
        const deckBpm = decks[id].bpm
        const counted = deckBpm ? reconcileSavedGrid(next, deckBpm).grid : next
        tempoByHandOnDeck[id] = byHand
        patchDeck(id, { beatGrid: counted, bpm: counted.bpm, beatGridConfirmed: true, barOneUnsure: false })
      }
    }
    return true
  } catch (err) {
    tagFail(`Tag for "${c.name}" was not saved: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export async function tagSaveVocal(shownHash: string, answer: VocalAnswer, clip: number, clipIndexOffset = 0): Promise<boolean> {
  const c = tagTarget(shownHash)
  if (!c) return false
  const at = c.vocalClips.atSec[clip]
  if (at == null) return false
  try {
    await putVocalTag({
      schema: VOCAL_SCHEMA,
      contentHash: c.contentHash,
      trackId: c.entry.trackId,
      name: c.name,
      genre: c.entry.genre,
      holdout: c.entry.holdout,
      clipIndex: clip + clipIndexOffset,
      atSec: at,
      pick: c.vocalClips.pick[clip],
      answer,
      taggedAt: Date.now(),
    })
    return true
  } catch (err) {
    useStore.getState().setNotice({ text: `Vocal tag for "${c.name}" was not saved: ${err instanceof Error ? err.message : String(err)}`, tone: 'warn', source: 'tagging' })
    return false
  }
}

/** The regions the owner drew on one clip's picture, saved whole (the list as it is now, empty included) beside — never inside — his answer. */
export async function tagSaveVocalMarks(
  shownHash: string,
  clipIndex: number,
  clip: number,
  marks: VocalMarksTag['marks'],
  view: 'voices' | 'all',
): Promise<boolean> {
  const c = tagTarget(shownHash)
  const at = c?.vocalClips.atSec[clip]
  if (!c || at == null) return false
  try {
    await putVocalMarksTag({
      schema: VOCAL_MARKS_SCHEMA,
      contentHash: c.contentHash,
      trackId: c.entry.trackId,
      name: c.name,
      genre: c.entry.genre,
      clipIndex,
      atSec: at,
      marks: [...marks],
      hearsButNoPicture: false, // the button was removed (the owner: he cannot tell, so it answers nothing); the field stays for files already exported
      view,
      taggedAt: Date.now(),
    })
    return true
  } catch (err) {
    useStore.getState().setNotice({ text: `Voice regions for "${c.name}" were not saved: ${err instanceof Error ? err.message : String(err)}`, tone: 'warn', source: 'tagging' })
    return false
  }
}

/** The re-check answer for one clip of the song on screen — beside the first pass, never over it. */
export async function tagSaveVocalReview(shownHash: string, answer: VocalAnswer, rc: ReviewClip): Promise<boolean> {
  const c = tagTarget(shownHash)
  if (!c) return false
  try {
    await putVocalReviewTag({
      schema: VOCAL_REVIEW_SCHEMA,
      contentHash: c.contentHash,
      trackId: c.entry.trackId,
      name: c.name,
      genre: c.entry.genre,
      clipIndex: rc.clipIndex,
      atSec: rc.atSec,
      group: rc.group,
      previousAnswer: rc.previousAnswer,
      answer,
      taggedAt: Date.now(),
    })
    return true
  } catch (err) {
    useStore.getState().setNotice({ text: `Re-check answer for "${c.name}" was not saved: ${err instanceof Error ? err.message : String(err)}`, tone: 'warn', source: 'tagging' })
    return false
  }
}

/** Every tag so far, or `null` with the reason on screen — never an empty list standing in for "could not read". */
export async function tagLoadAll(): Promise<AllTags | null> {
  try {
    return await getAllTags()
  } catch (err) {
    return tagFail(`Saved tags could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function tagExport(): Promise<void> {
  const all = await tagLoadAll()
  if (!all) return
  const { setNotice } = useStore.getState()
  const day = new Date().toISOString().slice(0, 10)
  try {
    const manual = await getAllVocalManual() // throws on a blocked IndexedDB: an empty list there would read as "no marks"
    const r = await saveTagsJson(tagsExportText(all.bar, all.mark, all.vocal, Date.now(), all.decide, all.fresh, all.vocalReview, all.vocalMarks, manual), `deckmix-tags-${day}.json`)
    if (r === 'ok')
      setNotice({
        text: `Exported ${all.mark.length} waveform "1" tags, ${all.bar.length} earlier 4-button "1" tags, ${all.decide.length} tie-break answers, ${all.fresh.length} new-round answers and ${all.vocal.length} vocal tags and ${all.vocalReview.length} vocal re-check answers and ${all.vocalMarks.length} clips with voice regions drawn, and ${manual.length} songs with vocals marked by hand.`,
        tone: 'info',
        source: 'tagging',
      })
  } catch (err) {
    setNotice({ text: `Tags were not exported: ${err instanceof Error ? err.message : String(err)}`, tone: 'warn', source: 'tagging' })
  }
}
