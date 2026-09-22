import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as ctl from '@/controls'
import { GENRES } from '@/core/genres'
import { getGenreOverrides, getGenreOverridesByHash } from '@/platform/genre-overrides-idb/store'
import { migrateGenreOverridesToHash } from '@/platform/genre-overrides-idb/migrate'
import { getTrackMetaByHash } from '@/platform/track-meta-idb/store'
import {
  ensureReadPermission,
  fileSystemAccessSupported,
  pickLibraryFolder,
  pickTrackFiles,
  queueEmbeddingBackfill,
  queueLibraryAnalysis,
  readLibraryTags,
  restoreLibraryFolder,
  scanLibrary,
} from '@/platform/source-fsaccess/library'
import { useShallow } from 'zustand/react/shallow'
import { bootCopy, bootFor, bootForScanError } from '@/core/library-boot'
import { findSimilarTracks } from '@/core/embedding-search'
import { libraryEmptyCopy } from '@/core/library-list-copy'
import { mixRecommendations, orderMixList, type MixMatch } from '@/core/recommend'
import { settings } from '@/platform/settings-idb/store'
import { useSettings } from '@/app/hooks/useSettings'
import { useStore } from '@/app/state/store'
import type { KeyMode } from '@/core/settings'
import type { Track } from '@/core/types'
import type { SortDir, SortKey } from '@/core/library-sort'
import { useVirtualRows } from '@/app/hooks/useVirtualRows'
import { Button, HintIcon } from '@/app/components/controls'
import { CratesRail } from '@/app/components/CratesRail'

/** Matches the `h-9` row height below — fixed regardless of `libraryTextScale`, which only scales font-size (see the comment on the table itself). */
const ROW_HEIGHT = 36
/** Header `<Th>` count — keep in step with the `<thead>` row below; only used to span the two virtualization padding rows. */
const COLUMN_COUNT = 10

const DECK_COLOR = { A: 'var(--color-deck-a)', B: 'var(--color-deck-b)' } as const

/**
 * The key spelling was this component's own `localStorage` entry until v0.2.5 —
 * one of the three settings the app saved with no schema, no version and no
 * owner. It lives in the settings port now; the header button and the Settings
 * screen are two views of the same value, and the old key is migrated once on
 * first load (`core/settings.ts`, `migrate`).
 */

/** Camelot when asked for and known, musical otherwise — never an empty cell. */
function keyLabel(track: Track, mode: KeyMode): string | undefined {
  return mode === 'camelot' ? (track.camelot ?? track.key) : track.key
}

/**
 * Colour the key by its position on the Camelot wheel.
 *
 * Serato colours keys too, but its palette is arbitrary — the colour is just a
 * second name for the label. Deriving hue from the wheel makes it carry the
 * thing you actually care about: neighbouring numbers mix, so compatible keys
 * land on neighbouring hues and a clash is visibly far away. OKLCH keeps every
 * hue at the same perceived lightness, so no key is harder to read than another
 * (plain HSL would make the blues muddy and the yellows glare).
 */
function keyColor(camelot: string | undefined): string | null {
  const m = camelot ? /^(\d{1,2})([AB])$/.exec(camelot) : null
  if (!m) return null
  const hue = (Number(m[1]) - 1) * 30
  // minor keys sit deeper and more saturated than their relative majors
  return m[2] === 'A' ? `oklch(0.78 0.15 ${hue})` : `oklch(0.85 0.11 ${hue})`
}

function fmtTime(sec?: number) {
  if (!sec || !isFinite(sec)) return '–'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Coarse relative time for the "Played" column (v0.8.0) — "3h ago", not a timestamp nobody wants to parse mid-set. `undefined` (never loaded since this became trackable) reads as "–", same convention as every other unset cell in this table. */
function fmtRelative(ts?: number): string {
  if (!ts) return '–'
  const deltaSec = Math.max(0, (Date.now() - ts) / 1000)
  if (deltaSec < 60) return 'just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export function Library() {
  const library = useStore((s) => s.library)
  const setLibrary = useStore((s) => s.setLibrary)
  const crates = useStore((s) => s.crates)
  const [mixOnly, setMixOnly] = useState(false)
  // v0.8.10: drop already-played suggestions instead of ranking them last.
  // Same local-state shape as `mixOnly` — a view choice, not a setting.
  const [hidePlayed, setHidePlayed] = useState(false)
  // "More like this" (v0.8.5 M3): a seed track id, or null when not active.
  // Same local-state shape as `mixOnly` — a view filter, not something any
  // other part of the app needs to know about.
  const [similarTo, setSimilarTo] = useState<string | null>(null)
  // Which key notation to show. DJs are split between musical and Camelot and
  // nobody wants to relearn theirs, so it's a preference that sticks.
  const { keyMode, libraryTextScale } = useSettings()
  /**
   * Three clicks cycle a column: asc -> desc -> off (back to scan order).
   * Clicking a *different* column always starts it fresh at asc, rather
   * than carrying over whatever direction the previous column was on.
   */
  function handleSort(key: SortKey) {
    if (library.sortKey !== key) {
      setLibrary({ sortKey: key, sortDir: 'asc' })
    } else if (library.sortDir === 'asc') {
      setLibrary({ sortDir: 'desc' })
    } else {
      setLibrary({ sortKey: null, sortDir: 'asc' })
    }
  }
  const activeSort: { key: SortKey; dir: SortDir } | null = library.sortKey
    ? { key: library.sortKey, dir: library.sortDir }
    : null
  const skippedTotal = Object.values(library.skipped).reduce((a, b) => a + b, 0)
  const unrecognizedGenreTotal = Object.values(library.unrecognizedGenre).reduce(
    (a, b) => a + b,
    0,
  )
  // Derived straight from the tracks themselves (v0.4.0) — same shape as the
  // two counts above, no separate store slice needed. 'analyzing' counts as
  // still-queued from the header's point of view: both mean "not done yet".
  const queuedTotal = library.tracks.filter(
    (t) => t.analysisState === 'queued' || t.analysisState === 'analyzing',
  ).length
  const analysisFailedTotal = library.tracks.filter((t) => t.analysisState === 'failed').length
  // Background embedding backfill (M3, `applyEmbeddingBackfill` below) — a
  // track already past BPM/waveform analysis but still missing an
  // embedding, and not one whose embedding attempt already failed (that
  // one is done, just unsuccessfully; counting it here would keep this
  // badge stuck above zero forever on a track it will never retry).
  const embeddingBackfillTotal = library.tracks.filter(
    (t) => t.analysisState === 'analyzed' && !t.embedding && t.embeddingState !== 'failed',
  ).length
  // lets a new scan abandon the tag pass of the one it replaced
  const tagScan = useRef({ cancelled: false })

  // Narrow subscription to primitives only: the playhead moves every frame, but
  // recommendations depend just on play state / bpm / tempo / loaded track, so
  // the whole library list doesn't re-render 60×/s. useShallow compares each
  // element, so this must stay a flat array of primitives — never add
  // positionSec, peaks, or anything else that ticks at frame rate here; that
  // would re-render the entire table 60×/s the same way subscribing to `s.decks`
  // wholesale would (v0.8.2's "now playing" contentHash fields below are safe
  // because a load/eject is the only thing that changes them).
  // Only the length: `history` is read whole, once, inside the memo below —
  // see the note on `history` in store.ts about why it never sits in a
  // selector next to a frame-rate field.
  const historyLen = useStore((s) => s.history.length)
  const [aP, aB, aT, aId, aK, bP, bB, bT, bId, bK, aHash, bHash] = useStore(
    useShallow((s) => [
      s.decks.A.playing, s.decks.A.bpm, s.decks.A.tempo, s.decks.A.track?.id ?? null,
      s.decks.A.track?.camelot ?? null,
      s.decks.B.playing, s.decks.B.bpm, s.decks.B.tempo, s.decks.B.track?.id ?? null,
      s.decks.B.track?.camelot ?? null,
      s.decks.A.track?.contentHash ?? null,
      s.decks.B.track?.contentHash ?? null,
    ]),
  )
  // Mix Assist (v0.4.6): a track that just came off a deck stays out of the
  // suggestion list for 30s (`ctl.recentlyRemovedTrackIds`) — this ticks the
  // memo below on its own timer so an id ages back out without needing any
  // *other* state to change first. 5s granularity is plenty against a 30s
  // window; nothing here needs frame-accurate timing.
  const [recentlyRemovedTick, setRecentlyRemovedTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setRecentlyRemovedTick((n) => n + 1), 5000)
    return () => window.clearInterval(id)
  }, [])
  const recommendations = useMemo(
    () =>
      mixRecommendations(
        [
          { id: 'A', playing: aP, bpm: aB, tempo: aT, trackId: aId, camelot: aK },
          { id: 'B', playing: bP, bpm: bB, tempo: bT, trackId: bId, camelot: bK },
        ],
        library.tracks,
        ctl.recentlyRemovedTrackIds(),
        { playedHashes: new Set(useStore.getState().history.map((h) => h.contentHash)) },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recentlyRemovedTick only forces a recheck of the time-based exclusion set, its value is never read
    [aP, aB, aT, aId, aK, bP, bB, bT, bId, bK, library.tracks, recentlyRemovedTick, historyLen],
  )
  const recs = recommendations.matches
  const anyPlaying = aP || bP
  // Mix Assist (v0.4.6): suggestions must be "always available", not one more
  // click behind the toggle a DJ's hands are busy to reach. This defaults the
  // existing toggle on at the instant either deck starts playing (edge-
  // triggered off a ref, since the effect must fire only on that transition,
  // not on every render while a deck keeps playing) — a manual click back to
  // the full list during that same playback is still respected afterward.
  // It must also turn itself back off the instant *both* decks stop: the
  // toggle button only renders while `anyPlaying` is true (below), so once
  // playback ends there is no control left on screen to undo it — with
  // mixOnly stuck on and no deck playing to recommend against, the whole
  // library silently disappears behind an empty "no mixable tracks" filter
  // the panel can no longer explain (a real folder read as "no audio files
  // found" — exactly the silent-skip this project forbids).
  const wasPlayingForMixOnly = useRef(false)
  useEffect(() => {
    if (anyPlaying && !wasPlayingForMixOnly.current) setMixOnly(true)
    else if (!anyPlaying && wasPlayingForMixOnly.current) setMixOnly(false)
    wasPlayingForMixOnly.current = anyPlaying
  }, [anyPlaying])

  /**
   * Every path below can throw something the browser invented, and an async
   * handler that throws produces an unhandled rejection — which is to say
   * nothing on screen at all. That is the silent skip this version exists to
   * remove, so it must not be how this version fails: `queryPermission` on a
   * folder that is gone, an IndexedDB that will not open (private window,
   * blocked storage, a corrupt profile), and `requestPermission` losing its
   * activation all land here and become copy.
   */
  function reportFailure(err: unknown) {
    const e = err as DOMException
    setLibrary({
      boot: bootForScanError(e?.name ?? ''),
      bootDetail: e?.message || e?.name || String(err),
      scanning: false,
      scanMsg: '',
    })
  }

  /**
   * Startup (v0.2.6). The only branch that scans unattended is the one where
   * the saved handle still reads `granted` — everything else waits for a
   * gesture and says on screen what it is waiting for. Nothing here calls
   * `requestPermission`: outside a click it raises no dialog, so it would fail
   * with nothing visible, which is the exact failure this version removes.
   */
  useEffect(() => {
    const supported = fileSystemAccessSupported()
    setLibrary({ supported })
    if (!supported) {
      setLibrary({ boot: 'unsupported' })
      return
    }
    void (async () => {
      try {
        const saved = await restoreLibraryFolder()
        const boot = bootFor(true, saved)
        setLibrary({ boot, folderName: saved.kind === 'saved' ? saved.name : null })
        if (boot === 'restoring' && saved.kind === 'saved') {
          await runScan(saved.handle, saved.name)
        }
      } catch (err) {
        // without this the panel sits on "Looking for your library…" forever
        reportFailure(err)
      }
    })()
    // runScan is stable for the component's lifetime; re-running this effect
    // would re-scan the folder on every render that touches the library.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setLibrary])

  /**
   * The single click that mode 2 asks for. This is the one place allowed to
   * call `requestPermission`, because it is reached from a real click.
   */
  async function reconnect() {
    try {
      const saved = await restoreLibraryFolder()
      // 'none' and 'unusable' both mean there is nothing here to reconnect to;
      // the picker is the only way forward from either.
      if (saved.kind !== 'saved') return pickNew()
      if (!(await ensureReadPermission(saved.handle))) {
        setLibrary({ boot: 'blocked', folderName: saved.name })
        return
      }
      await runScan(saved.handle, saved.name)
    } catch (err) {
      // a click that does nothing and says nothing is the worst of the three
      reportFailure(err)
    }
  }

  async function pickNew() {
    try {
      const folder = await pickLibraryFolder()
      if (!folder) return
      await runScan(folder.handle, folder.name)
    } catch (err) {
      reportFailure(err)
    }
  }

  async function runScan(handle: FileSystemDirectoryHandle, name: string) {
    tagScan.current.cancelled = true // a previous tag pass must not write into this list
    const scan = { cancelled: false }
    tagScan.current = scan

    setLibrary({ scanning: true, folderName: name, scanMsg: 'Scanning…', bootDetail: null })

    let tracks: Track[]
    let skipped: Record<string, number>
    let unrecognizedGenre: Record<string, number>
    try {
      ;({ tracks, skipped, unrecognizedGenre } = await scanLibrary(handle, (p) =>
        setLibrary({ scanMsg: `${p.found} tracks · ${p.currentDir}` }),
      ))
    } catch (err) {
      // A folder that was renamed throws here, and an empty list looks exactly
      // like a folder with no music in it — so the failure gets a name and a
      // sentence rather than a blank panel.
      const e = err as DOMException
      setLibrary({
        boot: bootForScanError(e?.name ?? ''),
        bootDetail: e?.message || e?.name || String(err),
        scanning: false,
        scanMsg: '',
        tracks: [],
        skipped: {},
        unrecognizedGenre: {},
      })
      return
    }

    const queued = tracks.map((t) => ({ ...t, analysisState: 'queued' as const }))
    setLibrary({
      tracks: queued,
      skipped,
      unrecognizedGenre,
      boot: 'loaded',
      scanning: false,
      scanMsg: `${tracks.length} tracks · reading tags…`,
      selectedId: tracks[0]?.id ?? null,
    })

    // Only from a full folder scan, never `addFiles`'s small ad-hoc batch —
    // the migration marks itself done after one run, and a partial track
    // list would fail to match most existing overrides and never get a
    // second chance against the real library. Awaited (not fire-and-forget)
    // because `applyAnalysisQueue` reads the hash-keyed store exactly once,
    // up front — a migration still in flight when that read happens would
    // miss the very entries it just wrote, on this first post-upgrade scan.
    const migration = await migrateGenreOverridesToHash(queued)
    // A dropped entry here is exactly the class of gap this app's skipped/
    // unreadable/unrecognized-genre badges exist for — a migration that ran
    // once and quietly lost some overrides is worse than one the owner is
    // told about.
    if (migration && migration.orphaned > 0) {
      useStore.getState().setNotice({
        text: `${migration.orphaned} genre override${migration.orphaned === 1 ? '' : 's'} from before this version couldn't be matched to a file in this scan and were not carried forward.`,
        tone: 'warn',
        source: 'library',
      })
    }
    await applyGenreOverrides(scan)
    // Sampler slots saved from a previous session (v0.6.0) key on content
    // hash, same as genre overrides — this is what turns a saved-but-not-
    // yet-matched slot into a loaded one once its file is back on screen.
    // A `contentHash` is filled in lazily (`core/types.ts`), not at scan
    // time — this first call, right here, essentially never matches
    // anything on a real scan, because no track has one yet. The second
    // call below, once tagging/analysis has actually hashed the library,
    // is what really resolves a saved bank — found by testing a real cold
    // reload end-to-end rather than injecting an already-hashed track
    // straight into the store the way this version's own closing
    // verification had (`docs/handoff/v0.6.0.md`), which never exercised
    // this ordering at all. `silent: true` here and on every call before
    // the library has finished getting identities (below, and the
    // per-patch call in `applyAnalysisQueue`) — at this point almost no
    // track has a `contentHash` yet, so "unresolved" here almost never
    // means genuinely missing, only "not hashed yet". Reporting it here
    // flashed a scary, wrong "couldn't be matched" warning on every real
    // scan with a saved bank, found live: it read exactly like the bug
    // this whole fix exists to close. Only the final call, once nothing
    // else will hash any more tracks this scan, reports for real.
    await ctl.resolveSamplerSlots({ silent: true })
    await Promise.all([applyTags(queued, scan), applyAnalysisQueue(queued, scan)])
    if (!scan.cancelled) await ctl.resolveSamplerSlots()
    void applyEmbeddingBackfill(scan)
  }

  /**
   * Add individual tracks without touching the ones already loaded. Folder scan
   * replaces the library; this merges, so grabbing one song never costs you the
   * folder you just imported.
   */
  async function addFiles() {
    const picked = await pickTrackFiles()
    if (!picked.length) return

    const current = useStore.getState().library.tracks
    const known = new Set(current.map((t) => t.id))
    const fresh = picked.filter((t) => !known.has(t.id))
    if (!fresh.length) {
      setLibrary({ scanMsg: `${picked.length} already in the library` })
      return
    }
    // A scan already in flight (from `runScan` or an earlier `addFiles`)
    // must not keep tagging/resolving after this one starts — `runScan`
    // already does this; missing here let two overlapping scans' own
    // `resolveSamplerSlots()` calls run concurrently against the same
    // slots (harmless — same content-hash match either way — but wasted
    // decode work, found reviewing this diff, not from a live report).
    // After the "nothing new to add" check above, not before it: this
    // function can still return with the previous scan's own tagging
    // usefully in flight, and that one must not be cancelled for nothing.
    tagScan.current.cancelled = true
    const scan = { cancelled: false }
    tagScan.current = scan
    const queued = fresh.map((t) => ({ ...t, analysisState: 'queued' as const }))
    setLibrary({
      tracks: [...current, ...queued].sort((a, b) => a.path.localeCompare(b.path)),
      selectedId: fresh[0].id,
      folderName: useStore.getState().library.folderName ?? 'Added files',
      // tracks are on screen now, so the startup sentence must give way
      boot: 'loaded',
      scanMsg: `+${fresh.length} · reading tags…`,
    })
    await applyGenreOverrides(scan)
    // Sampler slots saved from a previous session (v0.6.0) key on content
    // hash, same as genre overrides — see the matching call in `runScan`
    // for why this needs a second pass after tagging/analysis actually
    // hashes these files. `silent: true` for the same reason as `runScan`'s
    // matching call — almost nothing has a `contentHash` yet at this point.
    await ctl.resolveSamplerSlots({ silent: true })
    await Promise.all([applyTags(queued, scan), applyAnalysisQueue(queued, scan)])
    if (!scan.cancelled) await ctl.resolveSamplerSlots()
    void applyEmbeddingBackfill(scan)
  }

  /**
   * Overlay stored manual genre overrides (v0.3.2) onto whatever tracks are
   * currently on screen. Runs after the fast, synchronous folder-derived list
   * is already visible — same two-pass shape as `applyTags` below — so a
   * rescan of the same, unmoved files does not clobber a manual pick with the
   * freshly re-derived folder genre.
   */
  async function applyGenreOverrides(scan: { cancelled: boolean }) {
    const overrides = await getGenreOverrides()
    if (scan.cancelled || overrides.size === 0) return
    const store = useStore.getState()
    store.setLibrary({
      tracks: store.library.tracks.map((t) => {
        const override = overrides.get(t.id)
        return override ? { ...t, genre: override } : t
      }),
    })
  }

  /** Second pass: BPM/key/artist straight out of the file headers (v0.1.7). */
  async function applyTags(tracks: Track[], scan: { cancelled: boolean }) {
    await readLibraryTags(
      tracks,
      (patch, progress) => {
        if (scan.cancelled) return
        const store = useStore.getState()
        if (patch.size > 0) {
          store.setLibrary({
            tracks: store.library.tracks.map((t) => {
              const p = patch.get(t.id)
              // never clobber values analysis already produced
              return p ? { ...p, ...t, bpm: t.bpm ?? p.bpm } : t
            }),
          })
        }
        const total = store.library.tracks.length
        store.setLibrary({
          unreadable: progress.unreadable,
          scanMsg:
            progress.done < progress.total
              ? `${total} tracks · tags ${progress.done}/${progress.total}`
              : `${total} tracks · ${progress.tagged} with BPM`,
        })
      },
      { signal: scan },
    )
  }

  /**
   * Third pass: background continuous analysis (v0.4.0), running alongside
   * `applyTags` rather than after it — a track's identity and cache entry
   * don't depend on its tags. Safe to run concurrently only because the
   * merge below never trusts a value carried in the patch over one already
   * on the track: same "existing wins" rule `applyTags` uses, so whichever
   * pass fills in `bpm` first, a tag never loses to a detected guess.
   */
  async function applyAnalysisQueue(tracks: Track[], scan: { cancelled: boolean }) {
    // Fetched once up front, not per track: this is the actual fix for the
    // v0.3.2 move bug on genre. `applyGenreOverrides` above already applied
    // the path-keyed store for tracks that haven't moved; a track that HAS
    // moved has no `contentHash` yet at that point (nothing does, right
    // after a scan), so its override only surfaces here, the moment this
    // pass gives it an identity to look up by.
    const hashOverrides = await getGenreOverridesByHash()
    // Same reasoning as `hashOverrides` above, for note/lastPlayedAt
    // (v0.8.0): track-meta-idb is hash-only from the start (no legacy
    // path-keyed predecessor the way genre has), so this merge — the
    // moment a track first gets an identity — is the *only* place a note
    // or a play stamp survives a rescan. There is no earlier, path-keyed
    // pass for it to also run in.
    const trackMetaByHash = await getTrackMetaByHash()
    // Progress isn't read here — the header's "N queued"/"K failed" badges
    // (below) derive straight from `library.tracks[].analysisState`, the
    // same way the skipped/unrecognized-genre counts already do, so there is
    // no separate counter to thread through this callback.
    await queueLibraryAnalysis(
      tracks,
      (patch) => {
        if (scan.cancelled || patch.size === 0) return
        const store = useStore.getState()
        store.setLibrary({
          tracks: store.library.tracks.map((t) => {
            const p = patch.get(t.id)
            if (!p) return t
            const merged = { ...t, ...p, bpm: t.bpm ?? p.bpm, durationSec: t.durationSec ?? p.durationSec }
            const hash = p.contentHash ?? t.contentHash
            const override = hash ? hashOverrides.get(hash) : undefined
            const meta = hash ? trackMetaByHash.get(hash) : undefined
            return {
              ...merged,
              ...(override ? { genre: override } : {}),
              ...(meta?.note != null ? { note: meta.note } : {}),
              ...(meta?.lastPlayedAt != null ? { lastPlayedAt: meta.lastPlayedAt } : {}),
            }
          }),
        })
        // A saved sampler slot's track can be anywhere in a real library —
        // waiting for the WHOLE analysis queue to finish (the call after
        // `Promise.all` below) means a slot near the end of a large, real
        // library stays visibly empty for as long as the rest of the scan
        // takes, which reads exactly like "it didn't come back" even though
        // it eventually would. Re-checking after every patch (the same
        // "resolve the moment this pass gives it an identity" shape the hash
        // override lookup above already uses) resolves it the instant ITS
        // track gets hashed, not the library's last one. Silent — most other
        // slots still have no hash yet at any given patch, so "unresolved"
        // here is not evidence of anything; the one call after the whole
        // queue settles (below) is what actually reports for real.
        if ([...patch.values()].some((p) => p.contentHash)) void ctl.resolveSamplerSlots({ silent: true })
      },
      { signal: scan },
    )
  }

  /**
   * Fourth pass (v0.8.5 M3), fire-and-forget after the other three settle
   * (`runScan`/`addFiles` above — `void`, never awaited by the caller: this
   * is real background work, nothing else waits on it). Fills in the
   * embedding `applyAnalysisQueue`'s cache-hit branch could only read, never
   * compute — in practice almost the whole library on the first scan after
   * this version, since every track analyzed before v0.8.5 hits that branch.
   * Reads `library.tracks` fresh from the store rather than taking the
   * `queued` array the other two passes use: that array is a snapshot frozen
   * at `analysisState:'queued'` for the whole scan (`runScan`, above), so
   * `queueEmbeddingBackfill`'s own `analysisState === 'analyzed'` filter
   * would never match anything from it.
   */
  async function applyEmbeddingBackfill(scan: { cancelled: boolean }) {
    await queueEmbeddingBackfill(
      useStore.getState().library.tracks,
      (patch) => {
        if (scan.cancelled || patch.size === 0) return
        const store = useStore.getState()
        store.setLibrary({
          tracks: store.library.tracks.map((t) => {
            const p = patch.get(t.id)
            return p ? { ...t, ...p } : t
          }),
        })
      },
      { signal: scan },
    )
  }

  // "More like this" (M3): a seed track id in `similarTo` re-sorts/filters
  // the list to its matches, taking over from `mixOnly` the same way mixOnly
  // takes over from the plain list — the two are different questions
  // ("what mixes with what's playing" vs "what sounds like this one track")
  // and picking one seed at a time keeps the table's meaning unambiguous.
  const similarMatches = useMemo(
    () => (similarTo ? findSimilarTracks(similarTo, library.tracks) : []),
    [similarTo, library.tracks],
  )
  const similarScoreById = useMemo(() => new Map(similarMatches.map((m) => [m.id, m.score])), [similarMatches])
  const similarToTrack = similarTo ? (library.tracks.find((t) => t.id === similarTo) ?? null) : null

  // Kept separate from `list` so the empty state below can tell "mixOnly
  // filtered everything out" apart from "the folder genuinely has nothing" —
  // the two used to render the identical "no audio files" message.
  const preMixList = ctl.sortedFilteredTracks()
  const list = similarTo
    ? preMixList
        .filter((t) => similarScoreById.has(t.id))
        .sort((a, b) => (similarScoreById.get(b.id) ?? -Infinity) - (similarScoreById.get(a.id) ?? -Infinity))
    : mixOnly
      ? orderMixList(preMixList, recs, { hidePlayed, keepOrder: library.sortKey != null })
      : preMixList
  // Decided from what this view would show, not from library-wide counts: a
  // crate or text filter can leave a view whose suggestions are all played
  // while others exist elsewhere (or the reverse), and the message has to
  // describe the table the owner is actually looking at.
  const allSuggestionsPlayedHidden =
    mixOnly &&
    !similarTo &&
    hidePlayed &&
    list.length === 0 &&
    orderMixList(preMixList, recs, { hidePlayed: false, keepOrder: true }).length > 0
  const activeCrate = library.activeCrateId ? (crates.get(library.activeCrateId) ?? null) : null
  const emptyCopy = libraryEmptyCopy(
    library.query,
    mixOnly,
    preMixList.length,
    activeCrate?.name ?? null,
    queuedTotal > 0,
    similarToTrack ? (similarToTrack.title ?? similarToTrack.name) : null,
    allSuggestionsPlayedHidden,
  )
  // Only a manual crate's membership can be edited from here — a smart
  // crate's contents are entirely rule-derived (`refreshSmartCrate`), so
  // there is nothing for a per-row "remove" action to do to one.
  const removableFromCrateId = activeCrate?.kind === 'manual' ? activeCrate.id : null
  // v0.8.0: windowed rendering so a large library doesn't cost a DOM node
  // per track. Called unconditionally (not inside the empty-state branch
  // below) — `list.length` is 0 in every empty state anyway, which
  // `visibleRange` already treats as "nothing to render".
  const { containerRef, start, end, padTop, padBottom } = useVirtualRows(list.length, ROW_HEIGHT)

  // null once tracks are on screen — that is the only state with no sentence
  const boot = bootCopy(library.boot, library.folderName, library.bootDetail ?? undefined)

  return (
    <section className="panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hairline p-2">
        {/*
          The header keeps the *other* choice, never a second copy of the one
          the panel is already asking for: while a startup state is on screen
          its own button is the call to action, and offering the same action
          twice next to a third, louder button read as three ways out of one
          situation.
        */}
        <span className="relative inline-flex">
          <Button
            variant="toggle"
            active={library.boot === 'new'}
            tone="var(--color-accent)"
            onClick={pickNew}
            disabled={!library.supported}
          >
            {library.boot === 'new' ? 'Load my music folder' : 'Change folder'}
          </Button>
          <HintIcon id="library.folder" className="absolute -right-1.5 -top-1.5" />
        </span>
        <span className="relative inline-flex">
          <Button
            variant="ghost"
            size="sm"
            onClick={addFiles}
            disabled={!library.supported}
            title="Pick one or more individual tracks and add them to the list"
          >
            + Files
          </Button>
          <HintIcon id="library.addFiles" className="absolute -right-1.5 -top-1.5" />
        </span>
        {library.folderName && (
          <span className="max-w-[12rem] truncate text-xs text-grid-muted">{library.folderName}</span>
        )}
        {/*
          Named, not silent: without this, a crate filter hiding most of the
          library would look identical to "the library only has 5 tracks" —
          the header's own track count already changes, but nothing says why.
        */}
        {activeCrate && (
          <button
            onClick={() => ctl.setActiveCrate(null)}
            className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-text hover:bg-surface-3"
            title="Showing only this crate's tracks — click to see the whole library again"
          >
            Crate: {activeCrate.name} ✕
          </button>
        )}
        {/* Same reasoning as the crate chip above: a seed-track filter that
            silently narrowed the list with no visible way back would look
            identical to "the library shrank". */}
        {similarToTrack && (
          <button
            onClick={() => setSimilarTo(null)}
            className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-text hover:bg-surface-3"
            title="Similar = same tempo range (±8%, or half/double time), same genre first, then closest sound. Tracks with no BPM are left out. Click to see the whole library again."
          >
            Similar to: {similarToTrack.title ?? similarToTrack.name}
            {similarToTrack.bpm != null && ` · ${Math.round(similarToTrack.bpm)} BPM`}
            {similarToTrack.genre && ` · ${similarToTrack.genre}`} ✕
          </button>
        )}
        {/* Zero-size anchor: the badge is absolutely placed off it, so it never
            grows this header row (the row wraps to the search box at some
            widths, and a real flex sibling here would move that wrap point). */}
        <span className="relative h-0 w-0">
          <HintIcon id="library.rows" className="absolute left-1 top-1/2 -translate-y-1/2" />
        </span>

        {anyPlaying &&
          (recs.size > 0 ? (
            <span className="relative ml-auto inline-flex">
              <Button
                variant="toggle"
                size="sm"
                // "More like this" (M3) always wins over Mix Only in `list`
                // below — showing this lit while it's actually inert would
                // be the same silent-skip failure the empty-state fix above
                // exists to close, just as a toggle instead of a message.
                active={mixOnly && !similarTo}
                tone="var(--color-live)"
                onClick={() => setMixOnly((v) => !v)}
                title={
                  similarTo
                    ? "Showing tracks similar to the selected one — clear that filter to use Mix Only again"
                    : "Show only tracks that mix with what's playing"
                }
              >
                ♫ {recs.size} mixable
              </Button>
              <HintIcon id="library.mixOnly" className="absolute -right-1.5 -top-1.5" />
            </span>
          ) : (
            // A deck is playing but nothing in the library currently mixes —
            // said explicitly, not left as an absent button a first-time user
            // can't tell apart from "this feature isn't here." When the
            // reason is a missing BPM on the playing deck itself (rather than
            // "nothing in the library is in range"), name that too — the
            // difference matters: one is fixed by waiting for analysis, the
            // other isn't fixed by anything.
            <span
              className="ml-auto rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-muted"
              title="No track in the library currently mixes with what's playing."
            >
              ♫ no mixable tracks
              {recommendations.reason === 'no-bpm-on-playing-deck' &&
                ` · BPM unknown on deck ${[aP && aB == null ? 'A' : null, bP && bB == null ? 'B' : null].filter(Boolean).join(' & ')}`}
            </span>
          ))}
        {/* Tracks the scan excluded from suggestions for carrying no BPM tag
            at all — counted, not just silently absent from the list above.
            Same shape as the library-wide "skipped" badge further down. */}
        {/* v0.8.10: suggested tracks already loaded this session. Shown only
            when there is something to say — a "0 played" badge on a fresh
            session would read as a fault. It is also the way back: hidden
            tracks are named and counted here, never just gone. */}
        {anyPlaying && mixOnly && !similarTo && recommendations.playedCount > 0 && (
          // Mix Only only: that is the one list it reorders/hides, so outside
          // it the badge would report a state the table doesn't show.
          <span className="relative inline-flex">
            <Button
              variant="toggle"
              size="sm"
              active={hidePlayed}
              tone="var(--color-live)"
              aria-pressed={hidePlayed}
              onClick={() => setHidePlayed((v) => !v)}
              title={
                hidePlayed
                  ? 'Played tracks are hidden from the suggestions — click to show them again.'
                  : 'These suggestions were already loaded to a deck this session, so they sit at the bottom of Mix Only. Click to hide them.'
              }
            >
              {recommendations.playedCount} {hidePlayed ? 'hidden' : 'played'}
            </Button>
            <HintIcon id="library.played" className="absolute -right-1.5 -top-1.5" />
          </span>
        )}
        {/* A hash is filled in lazily, so a track never loaded or analyzed
            cannot be matched against the set history. Named, not assumed. */}
        {anyPlaying && historyLen > 0 && recommendations.unverifiedAgainstHistory > 0 && (
          <span
            className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-muted"
            title="These suggestions have no content hash yet (they are hashed when loaded or analyzed), so they could not be checked against what you already played this session."
          >
            {recommendations.unverifiedAgainstHistory} not checked against set history
          </span>
        )}
        {anyPlaying && recommendations.noBpmSkipped > 0 && (
          <span
            className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-muted"
            title="Tracks with no BPM tag are never suggested as a mix, but still counted here."
          >
            {recommendations.noBpmSkipped} skipped · no BPM
          </span>
        )}

        <label className={`relative ${aP || bP ? '' : 'ml-auto'}`}>
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-grid-dim">⌕</span>
          <input
            value={library.query}
            onChange={(e) => setLibrary({ query: e.target.value })}
            placeholder="Filter tracks…"
            className="w-52 rounded-[var(--radius-sm)] border border-hairline bg-surface-0 py-1 pl-6 pr-2 text-xs outline-none transition-colors focus-visible:border-transparent focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          />
          <HintIcon id="library.search" className="absolute -right-1.5 -top-1.5" />
        </label>
        <span className="tnum flex items-center gap-1.5 text-xs text-grid-muted">
          {library.scanning && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          )}
          {library.scanMsg || (library.tracks.length ? `${library.tracks.length} tracks` : '')}
          {!library.scanning && skippedTotal > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-warn"
              title={`Files in this folder the browser cannot play, so they are not listed: ${Object.entries(
                library.skipped,
              )
                .map(([ext, n]) => `${n} × .${ext}`)
                .join(', ')}`}
            >
              {skippedTotal} skipped
            </span>
          )}
          {/*
            Files that ARE tracks and could not be read: deleted between the
            scan and the tag pass, or access pulled. Until v0.2.8 an empty catch
            counted them as "no tags", so a folder half of which had vanished
            looked identical to a folder of untagged files.
          */}
          {!library.scanning && library.unreadable > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-warn"
              title="Listed tracks whose file could not be read — moved, deleted, or access withdrawn since the scan."
            >
              {library.unreadable} unreadable
            </span>
          )}
          {/*
            Folders that don't match a known genre (v0.3.2) — same shape and
            reasoning as the skipped/unreadable badges: named, not silently
            blank. `+ Files` tracks have no folder to report, so they never
            add to this count.
          */}
          {!library.scanning && unrecognizedGenreTotal > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-warn"
              title={`Tracks imported from folders not recognized as a genre — rename the folder to the genre name for it to be picked up automatically: ${Object.entries(
                library.unrecognizedGenre,
              )
                .map(([folder, n]) => `${n} × ${folder}`)
                .join(', ')}`}
            >
              {unrecognizedGenreTotal} unrecognized genre
            </span>
          )}
          {!library.scanning && queuedTotal > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-muted"
              title="Waveform/BPM/beat-grid detection running behind the list — each track already plays, this fills in the row as it catches up."
            >
              {queuedTotal} queued
            </span>
          )}
          {!library.scanning && analysisFailedTotal > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-warn"
              title="Tracks whose background analysis failed — hover a row's dot for the reason. Still listed; loading one to a deck tries again."
            >
              {analysisFailedTotal} analysis failed
            </span>
          )}
          {!library.scanning && embeddingBackfillTotal > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-grid-muted"
              title="Filling in similarity data for tracks analyzed before this feature existed — the rest of the app already works while this runs."
            >
              {embeddingBackfillTotal} analyzing for similarity
            </span>
          )}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/*
          A crate is metadata independent of what the table happens to be
          showing right now — it must not disappear just because the current
          filter (or a still-loading library) makes `list` empty, which is
          exactly when a crate's own "not found"/"stale" badges are most
          worth seeing. So this sits beside the whole state machine below,
          not inside its one "tracks are on screen" branch.
        */}
        <CratesRail />
        {library.scanning && list.length === 0 ? (
          <EmptyState title="Scanning your folder…" body={library.scanMsg} pulse />
        ) : boot ? (
        /*
          One sentence per startup situation (v0.2.6). The panel is never
          allowed to be empty and silent: `bootCopy` returns copy for every
          state except `loaded`, and a test in tests/core/ holds that.
        */
        <EmptyState
          title={boot.title}
          body={boot.body}
          pulse={library.boot === 'checking' || library.boot === 'restoring'}
          action={
            boot.cta ? (
              <Button
                variant="toggle"
                active
                tone="var(--color-accent)"
                onClick={library.boot === 'needs-click' ? reconnect : pickNew}
              >
                {boot.cta}
              </Button>
            ) : undefined
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          title={emptyCopy.title}
          body={emptyCopy.body}
          action={
            similarTo ? (
              <Button variant="toggle" active tone="var(--color-accent)" onClick={() => setSimilarTo(null)}>
                Clear similar filter
              </Button>
            ) : activeCrate ? (
              <Button variant="toggle" active tone="var(--color-accent)" onClick={() => ctl.setActiveCrate(null)}>
                Clear crate filter
              </Button>
            ) : emptyCopy.offerMixOnlyReset ? (
              <Button variant="toggle" active tone="var(--color-accent)" onClick={() => setMixOnly(false)}>
                Show all tracks
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
          {/*
            Sized against Serato on the same 14" panel: it fits ~31px rows with
            ~16px type, i.e. denser *and* far more legible than a tall row full
            of small text. Rows are 36px with 14px type — you see more tracks
            than before and read them at a glance.
          */}
          {/* The scale rides on the table's own font-size and everything inside
              is in `em`-equivalent Tailwind steps, so rows, headers and the key
              cell grow together. On the owner's 157-PPI panel every CSS pixel
              renders at ~0.76 of its nominal size, which is why this is a
              legibility control and not a cosmetic one. */}
          <table
            className="w-full table-fixed border-collapse text-sm"
            style={libraryTextScale === 1 ? undefined : { fontSize: `${libraryTextScale * 0.875}rem` }}
          >
            <thead className="sticky top-0 z-10 bg-surface-1">
              <tr className="border-b border-hairline">
                {/* explicit widths: the title/artist cells use max-w-0 to truncate,
                    which collapses them to nothing without a column width to size against.
                    Title was 46% and the owner cut it to 25%.

                    The percentages have to add to 100 under `table-fixed`, and
                    that is the point: with auto layout the 21% Title gave up did
                    not go to Artist, it collected in the Type column as a dead
                    band between Artist and MP3. Fixed layout is what makes the
                    number mean what it says. */}
                <Th className="w-[20%] pl-3 text-left" sortKey="title" activeSort={activeSort} onSort={handleSort}>
                  Title
                </Th>
                <Th className="w-[21%] text-left" sortKey="artist" activeSort={activeSort} onSort={handleSort}>
                  Artist
                </Th>
                {/* Reclaimed from Type (8%→4%) and Time (10%→7%) — Title, Artist,
                    BPM, Key and Load are load-bearing and stay untouched.
                    v0.8.0 reclaimed 5% more (Title/Artist/BPM/Key/Time each
                    shrank a bit further) to make room for Note + Last played. */}
                <Th className="w-[5%] text-left">Genre</Th>
                <Th className="w-[3%] text-left">Type</Th>
                <Th className="w-[8%] text-right tnum" sortKey="bpm" activeSort={activeSort} onSort={handleSort}>
                  BPM
                </Th>
                <Th className="w-[8%] text-right">
                  {/*
                    Two separate controls sharing one header on purpose: the
                    label toggles *display* (musical/Camelot spelling,
                    unchanged since before this version), the arrow toggles
                    *order* (v0.8.0) — folding sort into the same click would
                    make one gesture do two unrelated things.
                  */}
                  <button
                    onClick={() => handleSort('key')}
                    title="Sort by key (Camelot wheel order)"
                    className="rounded-[var(--radius-xs)] px-0.5 py-0.5 transition-colors hover:bg-surface-2 hover:text-grid-text"
                    aria-sort={
                      activeSort?.key === 'key' ? (activeSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    {activeSort?.key === 'key' && (
                      <span aria-hidden="true" className="text-2xs">
                        {activeSort.dir === 'asc' ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      void settings.set('keyMode', keyMode === 'musical' ? 'camelot' : 'musical')
                    }}
                    title={
                      keyMode === 'musical'
                        ? 'Showing musical keys — click for Camelot'
                        : 'Showing Camelot codes — click for musical keys'
                    }
                    className="label -mr-1 rounded-[var(--radius-xs)] px-1 py-0.5 transition-colors hover:bg-surface-2 hover:text-grid-text"
                  >
                    {keyMode === 'musical' ? 'Key' : 'Camelot'}
                  </button>
                </Th>
                <Th
                  className="w-[6%] text-right tnum"
                  sortKey="durationSec"
                  activeSort={activeSort}
                  onSort={handleSort}
                >
                  Time
                </Th>
                <Th className="w-[12%] text-left" sortKey="note" activeSort={activeSort} onSort={handleSort}>
                  Note
                </Th>
                <Th
                  className="w-[9%] text-right tnum"
                  sortKey="lastPlayedAt"
                  activeSort={activeSort}
                  onSort={handleSort}
                >
                  Played
                </Th>
                <Th className="w-[8%] pr-3 text-right">Load</Th>
              </tr>
            </thead>
            <tbody>
              {/*
                Windowed (v0.8.0): a plain `<tr style={{height}}>` on each
                side instead of `position:absolute` rows, so the table stays
                a real `<table>` (sticky header, column widths) rather than
                needing its own manually-positioned layout.
              */}
              {padTop > 0 && (
                <tr aria-hidden="true" style={{ height: padTop }}>
                  <td colSpan={COLUMN_COUNT} />
                </tr>
              )}
              {list.slice(start, end).map((t) => (
                <Row
                  key={t.id}
                  track={t}
                  selected={t.id === library.selectedId}
                  match={recs.get(t.id)}
                  keyMode={keyMode}
                  onSelect={() => ctl.selectTrack(t.id)}
                  onFindSimilar={() => setSimilarTo(t.id)}
                  removableFromCrateId={removableFromCrateId}
                  loadedOnA={aHash != null && aHash === t.contentHash}
                  loadedOnB={bHash != null && bHash === t.contentHash}
                />
              ))}
              {padBottom > 0 && (
                <tr aria-hidden="true" style={{ height: padBottom }}>
                  <td colSpan={COLUMN_COUNT} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </section>
  )
}

/**
 * A plain header cell, or a sortable one when `sortKey`+`onSort` are given
 * (v0.8.0) — the same clickable-button shape the Key/Camelot header already
 * used for its mode toggle, extended to actual ordering. Three clicks per
 * column: asc -> desc -> off, `aria-sort` carries the state for assistive
 * tech rather than relying on the arrow glyph alone.
 */
function Th({
  children,
  className = '',
  sortKey,
  activeSort,
  onSort,
}: {
  children: React.ReactNode
  className?: string
  sortKey?: SortKey
  activeSort?: { key: SortKey; dir: SortDir } | null
  onSort?: (key: SortKey) => void
}) {
  if (!sortKey || !onSort) {
    return <th className={`label py-1.5 font-semibold ${className}`}>{children}</th>
  }
  const active = activeSort?.key === sortKey
  return (
    <th
      className={`label py-1.5 font-semibold ${className}`}
      aria-sort={active ? (activeSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        onClick={() => onSort(sortKey)}
        className="-mx-0.5 inline-flex items-center gap-0.5 rounded-[var(--radius-xs)] px-0.5 transition-colors hover:bg-surface-2 hover:text-grid-text"
      >
        {children}
        {active && (
          <span aria-hidden="true" className="text-2xs">
            {activeSort.dir === 'asc' ? '▲' : '▼'}
          </span>
        )}
      </button>
    </th>
  )
}

/**
 * Title-cell leading icon (v0.4.0), driven by `track.analysisState` — never
 * inferred from `bpm`, which fills in from a tag before analysis has run and
 * would otherwise make an unanalyzed-but-tagged track look identical to an
 * analyzed one. `undefined` (never queued at all, e.g. a `+ Files` import)
 * and `'queued'` share the same neutral dot; the distinction only matters
 * internally. `'analyzed'` — the common case, most rows — shows nothing:
 * a checkmark on every row would be noise, not information.
 */
/**
 * This dot is also the "identity not yet confirmed" state the escape hatch
 * in `workshop-output/FEATURE_SPEC.md` (identity unification section) calls
 * for: `contentHash` — what a genre override or a saved cue is actually
 * looked up by — is unknown until analysis reaches this row, so the genre
 * shown before that (a folder guess, or a stale path-keyed override) can
 * still change once it does. The queued/analyzing tooltips say so; the
 * dot's presence at all is the visible signal, same as `analyzed` having
 * none is the signal that nothing here is still provisional.
 */
function AnalysisIcon({ track }: { track: Track }) {
  if (track.analysisState === 'analyzing') {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
        title="Analyzing… genre and hot cues may still update once this finishes."
      />
    )
  }
  if (track.analysisState === 'failed') {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
        title={`Background analysis failed${
          track.analysisError ? `: ${track.analysisError}` : ''
        } — still listed; loading it to a deck tries analysis again.`}
      />
    )
  }
  if (!track.analysisState || track.analysisState === 'queued') {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-grid-dim/40"
        title="Queued for background analysis — genre and hot cues may still update once it runs."
      />
    )
  }
  return null
}

function Row({
  track,
  selected,
  match,
  keyMode,
  onSelect,
  onFindSimilar,
  removableFromCrateId,
  loadedOnA,
  loadedOnB,
}: {
  track: Track
  selected: boolean
  match?: MixMatch
  removableFromCrateId: string | null
  keyMode: KeyMode
  onSelect: () => void
  /** M3: seeds "more like this" with this row's track. */
  onFindSimilar: () => void
  /** v0.8.2: this row's track is currently loaded on deck A/B (loaded, not necessarily playing — paused counts). */
  loadedOnA: boolean
  loadedOnB: boolean
}) {
  const key = keyLabel(track, keyMode)
  const tone = keyColor(track.camelot)
  // The one fact not already visible elsewhere in the row: BPM and key are
  // already dedicated columns, so the chip carries only the tempo transform —
  // and nothing at all for a plain 1:1 match, keeping the common case quiet.
  // multiplier is what `t.bpm` is multiplied by to reach the reference bpm —
  // 2 means the candidate's own tag is *half* the reference tempo (so it
  // plays in half-time relative to what's on the deck), and 0.5 the mirror.
  const chipLabel = match?.multiplier === 2 ? 'half-time' : match?.multiplier === 0.5 ? 'double-time' : null
  const matchTitle = match
    ? `Mixes with deck ${match.deck}${match.strong ? '' : ' (loose)'}` +
      (chipLabel ? ` · ${match.trackBpm}→${match.refBpm} ${chipLabel}` : '') +
      (match.keyMatch === undefined ? '' : match.keyMatch ? ' · key compatible' : ' · key clashes') +
      (match.played ? ' · already loaded this set' : '')
    : undefined
  // aria-describedby's value is parsed as a whitespace-separated list of
  // IDREFs — track.id is a scan-relative file path, and any space in a
  // filename or folder name (the common case in a real library) would split
  // the reference and silently break it for assistive tech. encodeURIComponent
  // leaves no whitespace and stays unique per track.
  const matchDescId = match ? `match-desc-${encodeURIComponent(track.id)}` : undefined
  return (
    <tr
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-soundgrid-track', track.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onSelect}
      // A suggested row (has a `match`) is a Mix Assist pick — it must land on
      // the empty deck, never always deck A, and never overwrite a paused-
      // but-loaded deck (`loadSuggestionToDeck`'s own rule). A plain row keeps
      // today's manual-load behaviour unchanged.
      onDoubleClick={() =>
        match ? ctl.loadSuggestionToDeck(track, match.deck) : void ctl.loadTrackToDeck('A', track)
      }
      // v0.8.7: the row itself was mouse-only — `onClick`/`onDoubleClick` with
      // no `tabIndex` — which broke the project's own "never break the
      // keyboard path" rule (a11y audit, 12/09). Enter/Space only select the
      // row, same as a click; loading to a deck stays the bracket keys in
      // App.tsx (which deck is a separate, unresolved product question).
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      aria-selected={selected}
      // The match reason otherwise lived only in a hover title — undiscoverable
      // without a mouse. aria-describedby appends to the row's own computed
      // name (title/artist/bpm/key) instead of replacing it, which aria-label
      // would have done.
      aria-describedby={matchDescId}
      className={`h-9 cursor-grab border-b border-hairline/50 outline-none transition-colors active:cursor-grabbing focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[-2px] ${
        selected ? 'bg-accent/15' : 'hover:bg-surface-2'
      }`}
    >
      <td
        className={`relative max-w-0 py-1.5 pl-3 pr-2 leading-tight ${
          match?.strong ? 'font-bold text-grid-text' : 'font-medium'
        }`}
      >
        {selected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
        <span className="flex items-center gap-1.5">
          <AnalysisIcon track={track} />
          {match && (
            // Strong = filled disc, loose = hollow ring — a shape difference,
            // not a shade of the same dot. Opacity alone measured at ~4.6px
            // physical on the owner's screen and wasn't reliably legible while
            // scrolling; a ring survives that scale where a faded fill doesn't.
            <span
              aria-hidden="true"
              className={
                match.strong
                  ? 'ms-0.5 h-2 w-2 shrink-0 rounded-full'
                  : 'ms-0.5 h-2 w-2 shrink-0 rounded-full border-[1.5px] bg-transparent'
              }
              style={
                match.strong
                  ? { background: DECK_COLOR[match.deck] }
                  : { borderColor: DECK_COLOR[match.deck] }
              }
              title={matchTitle}
            />
          )}
          {match?.played && (
            // v0.8.10: a mark, not a faded row — opacity alone was already
            // measured unreadable at this screen's physical scale (see the
            // ring-vs-fill note above), so this is a glyph in a box like the
            // A/B letters below.
            <span
              aria-label="Already loaded this set"
              title="Already loaded to a deck this session"
              className="grid h-4 w-4 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-surface-2 text-[10px] font-bold leading-none text-grid-muted"
            >
              ✓
            </span>
          )}
          {match && (
            <span id={matchDescId} className="sr-only">
              {matchTitle}
            </span>
          )}
          {(loadedOnA || loadedOnB) && (
            // v0.8.2: a letter, not a colored dot — the Mix Assist dot above
            // already spends this exact color/position pair on a different
            // meaning ("mixes with"), and at the physical size this table
            // renders at on the owner's screen a same-shaped dot in the same
            // spot would be indistinguishable from it (see the ring-vs-fill
            // comment above, same underlying measurement).
            <span className="flex shrink-0 items-center gap-0.5">
              {loadedOnA && (
                <span
                  aria-label="Loaded on deck A"
                  title="Loaded on deck A"
                  className="grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] text-[10px] font-bold leading-none"
                  style={{
                    background: 'color-mix(in srgb, var(--color-deck-a), transparent 82%)',
                    color: 'var(--color-deck-a)',
                  }}
                >
                  A
                </span>
              )}
              {loadedOnB && (
                <span
                  aria-label="Loaded on deck B"
                  title="Loaded on deck B"
                  className="grid h-4 w-4 place-items-center rounded-[var(--radius-xs)] text-[10px] font-bold leading-none"
                  style={{
                    background: 'color-mix(in srgb, var(--color-deck-b), transparent 82%)',
                    color: 'var(--color-deck-b)',
                  }}
                >
                  B
                </span>
              )}
            </span>
          )}
          <span className="truncate">{track.title ?? track.name}</span>
          {chipLabel && <span className="shrink-0 text-2xs text-grid-dim">{chipLabel}</span>}
        </span>
      </td>
      <td className="max-w-0 truncate py-1.5 pr-2 text-grid-muted">{track.artist}</td>
      {/*
        A native <select> rather than a plain cell that swaps to one on click:
        it gets keyboard/focus/screen-reader semantics for free and isn't
        clipped by the table's own scroll container. Transparent at rest,
        matching the Key-mode header toggle's hover-reveal styling — the only
        signal it's editable is the hover state, which is fine for this
        mouse-driven, Chromium-only app. `stopPropagation` on both handlers
        keeps opening it from also selecting the row or loading the deck.
      */}
      <td
        className="max-w-0 py-1.5 pr-2"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <select
          value={track.genre ?? ''}
          onChange={(e) => e.target.value && ctl.setTrackGenre(track.id, e.target.value)}
          title={track.genre ?? 'No genre — pick one'}
          className={`w-full truncate rounded-[var(--radius-xs)] border border-transparent bg-transparent py-0.5 pl-1 pr-0.5 outline-none transition-colors hover:border-hairline hover:bg-surface-2 hover:text-grid-text focus-visible:border-transparent focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
            track.genre ? 'text-grid-muted' : 'text-grid-dim'
          }`}
        >
          <option value="" disabled hidden>
            –
          </option>
          {GENRES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-2 text-2xs uppercase text-grid-dim">{track.kind}</td>
      {/* BPM is a primary mixing datum, not metadata — it reads at full brightness */}
      <td className="tnum py-1.5 pr-2 text-right font-medium text-grid-text">
        {track.bpm ? track.bpm.toFixed(0) : <span className="font-normal text-grid-dim">–</span>}
      </td>
      <td className="py-1.5 pr-2 text-right">
        {key ? (
          <span
            className="tnum rounded-[var(--radius-xs)] px-1.5 py-0.5 font-semibold"
            style={
              tone
                ? { color: tone, background: `color-mix(in oklab, ${tone}, transparent 88%)` }
                : { color: 'var(--color-grid-muted)', background: 'var(--color-surface-2)' }
            }
            title={track.camelot && track.key ? `${track.key} · Camelot ${track.camelot}` : key}
          >
            {key}
          </span>
        ) : (
          <span className="text-grid-dim">–</span>
        )}
      </td>
      <td className="tnum py-1.5 pr-2 text-right text-grid-muted">{fmtTime(track.durationSec)}</td>
      <td
        className="max-w-0 py-1.5 pr-2"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <NoteInput track={track} />
      </td>
      <td className="tnum py-1.5 pr-2 text-right text-2xs text-grid-dim">{fmtRelative(track.lastPlayedAt)}</td>
      <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right">
        {removableFromCrateId && track.contentHash && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              ctl.removeTrackFromCrate(removableFromCrateId, track.contentHash!)
            }}
            aria-label="Remove from this crate"
            title="Remove from this crate"
            className="mr-1 inline-grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-2xs font-bold text-grid-dim transition-colors hover:bg-surface-2 hover:text-warn"
          >
            −
          </button>
        )}
        <SimilarBtn track={track} onFindSimilar={onFindSimilar} />
        <LoadBtn deck="A" track={track} />
        <LoadBtn deck="B" track={track} />
      </td>
    </tr>
  )
}

/**
 * "More like this" (v0.8.5 M3). Disabled per-row on `!track.embedding` —
 * no artificial threshold ("only past 50 tracks" etc.) the way the header
 * badge above also avoids one: the button already says why it can't be
 * clicked yet, there is nothing a count-based gate would add.
 */
function SimilarBtn({ track, onFindSimilar }: { track: Track; onFindSimilar: () => void }) {
  const title = track.embedding
    ? 'Find similar tracks'
    : track.embeddingState === 'failed'
      ? `Similarity analysis failed${track.embeddingError ? `: ${track.embeddingError}` : ''} — still listed; loading it to a deck tries again.`
      : 'Not yet analyzed for similarity'
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onFindSimilar()
      }}
      disabled={!track.embedding}
      aria-label="Find similar tracks"
      title={title}
      className="ml-1 inline-grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-2xs font-bold text-grid-muted transition-colors hover:bg-surface-2 hover:text-grid-text disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-grid-muted"
    >
      ≈
    </button>
  )
}

function LoadBtn({ deck, track }: { deck: 'A' | 'B'; track: Track }) {
  const tone = deck === 'A' ? 'var(--color-deck-a)' : 'var(--color-deck-b)'
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        void ctl.loadTrackToDeck(deck, track)
      }}
      aria-label={`Load to deck ${deck}`}
      className="ml-1 inline-grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-2xs font-bold transition-colors"
      style={{ background: `color-mix(in srgb, ${tone}, transparent 82%)`, color: tone }}
    >
      {deck}
    </button>
  )
}

/**
 * Free-text note cell (v0.8.0). Uncontrolled — saved on blur, not
 * `onChange`, which would fire `setTrackNote` (and its IndexedDB write)
 * on every keystroke. `key={track.note ?? ''}` remounts the input (fresh
 * `defaultValue`) whenever the stored note changes from outside this
 * input — a rescan resolving the hash-keyed store, or this same blur
 * handler's own optimistic update — without needing an effect to
 * re-sync local state.
 */
function NoteInput({ track }: { track: Track }) {
  return (
    <input
      key={track.note ?? ''}
      defaultValue={track.note ?? ''}
      onBlur={(e) => {
        const value = e.target.value
        if (value !== (track.note ?? '')) ctl.setTrackNote(track.id, value)
      }}
      placeholder="–"
      title={track.note}
      className="w-full truncate rounded-[var(--radius-xs)] border border-transparent bg-transparent py-0.5 px-1 text-2xs text-grid-muted outline-none transition-colors placeholder:text-grid-dim hover:border-hairline hover:bg-surface-2 hover:text-grid-text focus-visible:border-transparent focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
    />
  )
}

function EmptyState({
  title,
  body,
  pulse = false,
  action,
}: {
  title: string
  body?: string
  pulse?: boolean
  /** the one button that resolves this state, when one can */
  action?: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <span
        className={`grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-grid-muted ${
          pulse ? 'animate-pulse' : ''
        }`}
      >
        ♫
      </span>
      <p className="text-sm font-medium text-grid-text">{title}</p>
      {body && <p className="max-w-sm text-xs leading-relaxed text-grid-muted">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
