import { get, set } from 'idb-keyval'
import { genreFolderFor, matchGenre, parentFolderName } from '@/core/genres'
import { detectedKeyFields } from '@/core/key-detect'
import type { SavedPermission } from '@/core/library-boot'
import type { Track } from '@/core/types'
import type { VocalResult } from '@/core/sound/vocal-timeline'
import { readTags } from '@/platform/source-fsaccess/tags'
import { analysisCacheKey } from '@/core/analysis-cache'
import { takeNextForAnalysis } from '@/core/analysis-order'
import { hashBytes } from '@/platform/source-fsaccess/hash'
import { engine } from '@/platform/audio-webaudio/engine'
import { pcmFromAudioBuffer } from '@/platform/analyzer-js/analyze'
import { analyzerWorker } from '@/platform/analyzer-worker'
import { analysisCache } from '@/platform/analyze-cache-idb/store'
import { classicalEmbedder } from '@/platform/embed-classical'
import { embeddingCache } from '@/platform/embed-cache-idb/store'
import { getVocalStrip, putVocalStrip } from '@/platform/vocal-strip-idb/store'
import { analyseVocalStrip } from '@/platform/vocal-strip-worker'

const HANDLE_KEY = 'deckmix:libraryDir'

/**
 * Everything Chromium's `decodeAudioData` can actually play. Kept as an
 * allowlist rather than "try to decode anything" because a music folder is full
 * of things that are not tracks — artwork, playlists, and the stem caches
 * below — and a library that lists them is worse than one that misses a format.
 */
const AUDIO_EXT = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'm4b',
  'mp4',
  'aac',
  'ogg',
  'oga',
  'opus',
  'weba',
  'webm',
  'aiff',
  'aif',
])

/**
 * Companion files that sit next to a real track and must never become rows of
 * their own. The first is a stem-separation cache another DJ program leaves
 * beside each song it processed — the extension is named only because the
 * files are really there in the owner's folders: every one has a playable
 * source file alongside it, so listing them would show those songs twice.
 */
const COMPANION_EXT = new Set(['serato-stems', 'asd', 'reapeaks', 'ovw'])

export interface LibraryFolder {
  handle: FileSystemDirectoryHandle
  name: string
}

export function fileSystemAccessSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker === 'function'
}

/**
 * `startIn: 'music'` opens the dialog already inside the OS music folder, so a
 * first visit is one click instead of one click plus a walk down the tree. It
 * does **not** load Music itself: the user's library is `Music/Tracks`, and
 * scanning all of Music would drag in recordings and voice memos that are not
 * a set. Music is where the dialog starts, not what gets chosen.
 *
 * `id` outranks `startIn` once it has remembered a directory, which is the
 * behaviour we want and the reason both are passed: first visit starts in
 * Music, every visit after that starts where they last were.
 */
export async function pickLibraryFolder(): Promise<LibraryFolder | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (o?: {
        mode?: 'read' | 'readwrite'
        id?: string
        startIn?: string
      }) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
  try {
    const handle = await picker({ mode: 'read', id: 'soundgrid-music', startIn: 'music' })
    await set(HANDLE_KEY, handle)
    return { handle, name: handle.name }
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return null
    throw err
  }
}

/**
 * Pick individual tracks instead of a whole folder.
 *
 * The folder picker is the right default for a DJ library, but it is the wrong
 * tool for "just add this one song" — it forces you to import a directory to
 * reach a single file. Same File System Access API, different entry point.
 *
 * Returns tracks the caller merges into the existing list rather than replacing
 * it, so adding a file never costs you the library you already scanned.
 */
export async function pickTrackFiles(): Promise<Track[]> {
  const picker = (
    window as unknown as {
      showOpenFilePicker?: (o?: {
        multiple?: boolean
        id?: string
        types?: { description: string; accept: Record<string, string[]> }[]
      }) => Promise<FileSystemFileHandle[]>
    }
  ).showOpenFilePicker
  if (typeof picker !== 'function') return []
  try {
    const handles = await picker({
      multiple: true,
      // shares the folder picker's id so the dialog opens where they last were
      id: 'soundgrid-music',
      types: [
        {
          description: 'Audio',
          accept: { 'audio/*': [...AUDIO_EXT].map((e) => `.${e}`) },
        },
      ],
    })
    return handles.map((handle) => {
      const name = handle.name
      return {
        id: `file:${name}`,
        name: name.replace(/\.[^.]+$/, ''),
        path: name,
        kind: name.split('.').pop()?.toLowerCase() ?? '',
        handle,
      }
    })
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return []
    throw err
  }
}

/**
 * The saved folder plus **the permission it still holds**.
 *
 * Until v0.2.6 this queried the permission and then threw the answer away —
 * both branches returned the same object — so the caller could not tell "open
 * it now, no click needed" from "this needs a gesture first", and the app
 * asked for a click either way. `bootFor` in `core/library-boot.ts` is what
 * consumes this, and `prompt` vs `denied` is the distinction that matters:
 * `prompt` is one click away, `denied` needs the picker again.
 */
export type Restored =
  | { kind: 'none' }
  /** something is stored, but it is not a directory handle this build can use */
  | { kind: 'unusable' }
  | { kind: 'saved'; handle: FileSystemDirectoryHandle; name: string; permission: SavedPermission }

export async function restoreLibraryFolder(): Promise<Restored> {
  const stored = await get<FileSystemDirectoryHandle>(HANDLE_KEY)
  if (!stored) return { kind: 'none' }
  /**
   * A record written by an older build, or one the browser can no longer
   * revive. Without this branch `queryPermission` is called on it, throws, and
   * the app lands on either the first-visit screen or a raw TypeError — both of
   * which tell the user there is no saved folder while there plainly is one.
   * `unusable` is a state of its own so the screen can say which it is.
   */
  if (typeof stored.queryPermission !== 'function' || typeof stored.name !== 'string') {
    return { kind: 'unusable' }
  }
  const permission = (await stored.queryPermission({ mode: 'read' })) as SavedPermission
  return { kind: 'saved', handle: stored, name: stored.name, permission }
}

/**
 * **Call this from a click, never from an effect.** `requestPermission` needs
 * transient user activation; without it Chromium raises no dialog at all, so a
 * page-load call is a guaranteed silent no.
 */
export async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true
  return (await handle.requestPermission({ mode: 'read' })) === 'granted'
}

export interface ScanProgress {
  found: number
  currentDir: string
}

export interface ScanResult {
  tracks: Track[]
  /** files we walked past, by extension — surfaced so a skip is never silent */
  skipped: Record<string, number>
  /**
   * Tracks whose immediate parent folder name matched no known genre, tallied
   * by that folder name — same shape as `skipped`, same reasoning: a track
   * imported without a genre is a fact the library owes its owner, not a
   * silently blank column (v0.3.2).
   */
  unrecognizedGenre: Record<string, number>
}

/** Recursively walk the folder collecting audio files. */
export async function scanLibrary(
  root: FileSystemDirectoryHandle,
  onProgress?: (p: ScanProgress) => void,
): Promise<ScanResult> {
  const out: Track[] = []
  const skipped: Record<string, number> = {}
  const unrecognizedGenre: Record<string, number> = {}
  async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
    onProgress?.({ found: out.length, currentDir: prefix || '/' })
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`)
      } else {
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        if (!AUDIO_EXT.has(ext)) {
          // companions are expected and uninteresting; anything else is a file
          // the user may well think of as a track, so it gets counted and shown
          if (!COMPANION_EXT.has(ext) && !name.startsWith('.')) {
            skipped[ext || '(no extension)'] = (skipped[ext || '(no extension)'] ?? 0) + 1
          }
          continue
        }
        const folder = parentFolderName(prefix)
        const genre = matchGenre(genreFolderFor(prefix, root.name))
        // a file at the scan root has no folder to blame, so it is excluded
        // from the notice rather than reported as "unrecognized" — there is
        // nothing actionable to tell the owner about it
        if (!genre && folder) {
          unrecognizedGenre[folder] = (unrecognizedGenre[folder] ?? 0) + 1
        }
        out.push({
          id: `${prefix}${name}`,
          name: name.replace(/\.[^.]+$/, ''),
          path: `${prefix}${name}`,
          kind: ext,
          handle: entry as FileSystemFileHandle,
          genre,
        })
      }
    }
  }
  await walk(root, '')
  out.sort((a, b) => a.path.localeCompare(b.path))
  return { tracks: out, skipped, unrecognizedGenre }
}

/** The tempo the file's own tag names, or `null` — the hint grid detection refines around. Same reader the scan uses, so a load and the background queue agree. */
export async function readTagBpm(track: Track): Promise<number | null> {
  try {
    return (await readTags(await track.handle.getFile())).bpm ?? null
  } catch {
    return null
  }
}

/**
 * The BPM and key a rescan would give this track, ignoring anything the owner
 * typed (v0.8.38, "back to original"): the file's tag first, else the cached
 * analysis — the same precedence `mergeTagPatch`/`mergeAnalysisPatch` apply.
 * A field neither source has comes back `undefined`, which the row shows as
 * "–", never a leftover of the owner's value. The analysis is only read from
 * the cache, never re-run: a track with no cached result just has no detected
 * value until the queue reaches it again.
 */
export async function readOriginalTempoKey(track: Track, contentHash: string | undefined): Promise<Partial<Track>> {
  const tags = await readTags(await track.handle.getFile())
  // `readTags` reports a file it could not open as `unreadable` rather than
  // throwing. Reading that as "no tag" would delete the owner's value and put
  // back a guess — or nothing — without a word (found in review).
  if (tags.unreadable) throw new Error('the file could not be read, so its original values are unknown')
  const analysis = contentHash ? await analysisCache.get(analysisCacheKey(contentHash, tags.bpm ?? null)) : null
  const detectedKey = analysis?.key ? detectedKeyFields(analysis.key) : {}
  const tagKey = tags.key || tags.camelot ? { key: tags.key, camelot: tags.camelot } : null
  return {
    bpm: tags.bpm ?? analysis?.bpm ?? undefined,
    ...(tagKey ?? detectedKey),
  }
}

export async function readTrackData(track: Track): Promise<ArrayBuffer> {
  const file = await track.handle.getFile()
  return await file.arrayBuffer()
}

export interface TagProgress {
  /** tracks whose tags have been read so far */
  done: number
  total: number
  /** how many of them actually carried a BPM */
  tagged: number
  /**
   * how many could not be read at all. Separate from `tagged` because "no BPM"
   * and "no file" are different facts, and the badge names this one (v0.2.8).
   */
  unreadable: number
}

/**
 * Second scan pass: read BPM/key/artist from the file headers (v0.1.7).
 *
 * Runs after `scanLibrary` so the list appears immediately and fills in — the
 * reads are byte ranges, not decodes, but a few hundred files still take a
 * moment. Results arrive in batches so the table isn't rebuilt per file.
 * Existing values win: anything the analysis engine wrote stays.
 */
export async function readLibraryTags(
  tracks: Track[],
  onBatch: (patch: Map<string, Partial<Track>>, progress: TagProgress) => void,
  opts: { concurrency?: number; signal?: { cancelled: boolean } } = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? 8
  const total = tracks.length
  let next = 0
  let done = 0
  let tagged = 0
  let unreadable = 0
  let batch = new Map<string, Partial<Track>>()
  let lastFlush = performance.now()

  const flush = () => {
    if (batch.size === 0) return
    onBatch(batch, { done, total, tagged, unreadable })
    batch = new Map()
    lastFlush = performance.now()
  }

  async function worker() {
    while (next < total) {
      if (opts.signal?.cancelled) return
      const track = tracks[next++]
      try {
        const file = await track.handle.getFile()
        const tags = await readTags(file)
        if (tags.unreadable) unreadable++
        if (tags.bpm != null) tagged++
        const patch: Partial<Track> = {}
        if (tags.bpm != null) patch.bpm = tags.bpm
        if (tags.durationSec != null) patch.durationSec = tags.durationSec
        if (tags.key) patch.key = tags.key
        if (tags.camelot) patch.camelot = tags.camelot
        if (tags.artist) patch.artist = tags.artist
        if (tags.title) patch.title = tags.title
        if (tags.album) patch.album = tags.album
        if (Object.keys(patch).length > 0) batch.set(track.id, patch)
      } catch {
        // `getFile()` itself rejected: the entry is gone or access was pulled
        // between the scan and now. Counted, never skipped — a row that cannot
        // be read is a fact the library owes its owner (v0.2.8).
        unreadable++
      }
      done++
      if (batch.size >= 50 || performance.now() - lastFlush > 400) flush()
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  flush()
  if (!opts.signal?.cancelled) onBatch(new Map(), { done, total, tagged, unreadable })
}

export interface AnalysisQueueProgress {
  /** tracks whose analysis has settled (analyzed or failed) so far */
  done: number
  total: number
  failed: number
}

/**
 * Third pass: background continuous analysis (v0.4.0) — the same
 * "scan renders immediately, this fills in behind it" shape as
 * `readLibraryTags`, but heavier per track (hash + decode + Worker analysis,
 * against tag-reading's byte-range peek), so it runs at a lower default
 * concurrency and reports analysis per-track rather than in batches: the point
 * of `'analyzing'` as its own state is a live signal, and holding it back for a
 * flush window would make the icon lie about what's happening right now. The
 * hash pass that runs first (v0.8.29) *is* batched — it only carries
 * `contentHash`, and ~360 separate store writes in a few seconds would cost
 * more than they show. Measured 24/09: hashing all 362 files (4.8GB) of the
 * owner's library takes ~12s in Node, during which rows sit at "queued" while
 * their genre picks fill in.
 *
 * A cache hit (this exact file content already analyzed, by this analyzer
 * version) skips `engine.decode` entirely — the expensive step — which is
 * why this checks the cache itself rather than delegating to
 * `analyzerWorker.analyze` the way `loadTrackToDeck` does: that path always
 * needs the decoded buffer anyway (to hand to the deck), this one doesn't.
 *
 * A hash failure here is treated as an analysis failure, not "not yet
 * identified" — unlike `loadTrackToDeck`, where the track still has to play,
 * this pass exists *only* to produce an identity and a cached result, so a
 * track it can't hash has nothing for it to do.
 */
export async function queueLibraryAnalysis(
  tracks: Track[],
  onUpdate: (patch: Map<string, Partial<Track>>, progress: AnalysisQueueProgress) => void,
  opts: {
    concurrency?: number
    signal?: { cancelled: boolean }
    /** asked at every pick: true = take this track ahead of queue order (`core/analysis-order.ts`) */
    needsFirst?: (trackId: string) => boolean
    /** settles once `needsFirst` can answer — the tag pass. Awaited before the first decode. */
    priorityReady?: Promise<unknown>
  } = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? 2
  const total = tracks.length
  const remaining = [...tracks]
  const needsFirst = opts.needsFirst ?? (() => false)
  let done = 0
  let failed = 0

  // Identity first, for every track, before any decode (24/09). Anything keyed
  // on `contentHash` alone — the owner's genre picks, notes, play stamps, a
  // saved sampler slot — can only appear once its track is hashed. Hashing per
  // track inside the analysis loop below meant a track waited behind every
  // decode ahead of it: invisible while the cache answered in milliseconds, but
  // the day ANALYZER_VERSION 3 re-analysed Shalom's whole library, every row he
  // had given a genre by hand showed none for as long as the queue took. A hash
  // is a file read and a digest; the decode is what's slow.
  const hashes = new Map<string, string>()
  const hashErrors = new Map<string, string>()
  {
    let hashNext = 0
    let batch = new Map<string, Partial<Track>>()
    let lastFlush = performance.now()
    const flush = () => {
      if (batch.size === 0 || opts.signal?.cancelled) return
      onUpdate(batch, { done, total, failed })
      batch = new Map()
      lastFlush = performance.now()
    }
    const hasher = async () => {
      while (hashNext < total) {
        if (opts.signal?.cancelled) return
        const track = tracks[hashNext++]
        try {
          const contentHash = await hashBytes(await (await track.handle.getFile()).arrayBuffer())
          hashes.set(track.id, contentHash)
          batch.set(track.id, { contentHash })
        } catch (err) {
          // not dropped: the analysis loop below reports it as this track's failure
          hashErrors.set(track.id, err instanceof Error ? err.message : String(err))
        }
        if (batch.size >= 25 || performance.now() - lastFlush > 300) flush()
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, total) }, hasher))
    flush()
  }

  // Until the tags are in, every track looks like it lacks BPM and key, and
  // the first picks fall back to folder order. Caught by
  // scripts/verify-analysis-priority.mjs: the untagged track went third of
  // five. Reading tags is byte-range peeks, and it overlaps the hash pass
  // above, so this wait is usually already over. A tag pass that throws must
  // not stall the analysis, hence the catch — it only costs the ordering.
  await opts.priorityReady?.catch(() => {})

  async function worker() {
    for (;;) {
      if (opts.signal?.cancelled) return
      const track = takeNextForAnalysis(remaining, (t) => needsFirst(t.id))
      if (!track) return
      onUpdate(new Map([[track.id, { analysisState: 'analyzing' }]]), { done, total, failed })
      try {
        const contentHash = hashes.get(track.id)
        if (!contentHash) throw new Error(hashErrors.get(track.id) ?? 'could not read the file')
        if (opts.signal?.cancelled) return
        const hintBpm = await readTagBpm(track)
        const cacheKey = analysisCacheKey(contentHash, hintBpm)
        let analysis = await analysisCache.get(cacheKey)
        if (!analysis) {
          // read only now: a cache hit (every track, on a normal reload) needs no bytes at all
          const data = await (await track.handle.getFile()).arrayBuffer()
          const buffer = await engine.decode(data)
          analysis = await analyzerWorker.analyze(pcmFromAudioBuffer(buffer), { hintBpm })
          await analysisCache.put(cacheKey, analysis)
        }
        // The embedding is never computed here, only picked up if already cached
        // (v0.8.32). Measured 25/09 on 20 of the owner's tracks
        // (scripts/measure-analysis-time.mjs): 8.5s per track, 85% of it the
        // embedding, 0.5s for BPM+key. Computing it in this pass made every row
        // wait ~8s for a BPM it needed ~1s for — and after an ANALYZER_VERSION
        // bump it recomputed embeddings that were still valid in their own
        // cache (keyed by EMBEDDER_VERSION, which didn't move). Tracks without
        // one are `queueEmbeddingBackfill`'s job, which runs once this settles.
        const embedding = (await embeddingCache.get(contentHash, classicalEmbedder.modelId)) ?? undefined
        done++
        if (opts.signal?.cancelled) return
        // Raw detected values, not resolved against `track` here — `track` is
        // this worker's snapshot from when the queue started, which can be
        // stale by the time this settles (`applyTags` runs concurrently in
        // `Library.tsx` and may have since filled in a tag's own bpm). The
        // "existing wins" precedence is applied once, by the caller, against
        // whatever the store actually holds at merge time.
        onUpdate(
          new Map([
            [
              track.id,
              {
                contentHash,
                analysisState: 'analyzed',
                bpm: analysis.bpm ?? undefined,
                durationSec: analysis.durationSec,
                // offered, not applied: the caller's `fillDetectedKey` lets a key tag win
                ...(analysis.key ? detectedKeyFields(analysis.key) : {}),
                ...(embedding ? { embedding, embeddingState: 'embedded' as const } : {}),
              },
            ],
          ]),
          { done, total, failed },
        )
      } catch (err) {
        done++
        failed++
        if (opts.signal?.cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        onUpdate(new Map([[track.id, { analysisState: 'failed', analysisError: message }]]), {
          done,
          total,
          failed,
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
}

/**
 * Fourth pass (v0.8.5 M3): the "more like this" embedding for every analyzed
 * track that doesn't have one yet. Decided with
 * Shalom (15/09, `HANDOFF.md`): runs automatically, in the background,
 * right after `queueLibraryAnalysis` settles — never gated behind a manual
 * action, never running *during* the main scan (the caller is responsible
 * for sequencing, not this function).
 *
 * Since v0.8.32 this is also the *only* place an embedding is computed: the
 * main queue stopped doing it (8s of a track's 8.5s, measured), so a library's
 * BPM and keys all land first and "more like this" fills in behind them.
 *
 * Only re-decodes tracks that actually need it — `analysisState === 'analyzed'`
 * (so BPM/waveform work is never repeated) and no `embedding` yet. Deliberately
 * `concurrency: 1` by default: this is real CPU work the app didn't already
 * have to do for these tracks, and it has nowhere to be — unlike the main
 * queue, nothing in the UI is waiting on it.
 */
export async function queueEmbeddingBackfill(
  tracks: Track[],
  onUpdate: (patch: Map<string, Partial<Track>>, progress: AnalysisQueueProgress) => void,
  opts: { concurrency?: number; signal?: { cancelled: boolean } } = {},
): Promise<void> {
  const pending = tracks.filter((t) => t.analysisState === 'analyzed' && !t.embedding)
  const concurrency = opts.concurrency ?? 1
  const total = pending.length
  let next = 0
  let done = 0
  let failed = 0
  if (total === 0) return

  async function worker() {
    while (next < total) {
      if (opts.signal?.cancelled) return
      const track = pending[next++]
      onUpdate(new Map([[track.id, { embeddingState: 'embedding' }]]), { done, total, failed })
      try {
        // `analysisState === 'analyzed'` guarantees a `contentHash` was
        // already resolved for this track — same invariant `loadTrackToDeck`
        // and the rest of this file already rely on.
        const contentHash = track.contentHash as string
        // Cache first: a backfill cancelled by a rescan has already stored
        // the vector for the track it was on, then dropped the store patch.
        // Without this the next scan spends ~7s recomputing it.
        let embedding = await embeddingCache.get(contentHash, classicalEmbedder.modelId)
        if (!embedding) {
          const file = await track.handle.getFile()
          const data = await file.arrayBuffer()
          const buffer = await engine.decode(data)
          // This decode feeds the embedder alone. If it ever feeds a second
          // Worker too, copy the PCM *before* the first transfer: afterwards
          // Chromium's copyFromChannel returns zeros and throws nothing, which
          // wrote 349 all-zero embeddings for Shalom's library on 20/09.
          embedding = await classicalEmbedder.embed(pcmFromAudioBuffer(buffer))
          await embeddingCache.put(contentHash, classicalEmbedder.modelId, embedding)
        }
        done++
        if (opts.signal?.cancelled) return
        onUpdate(new Map([[track.id, { embedding, embeddingState: 'embedded' }]]), { done, total, failed })
      } catch (err) {
        done++
        failed++
        if (opts.signal?.cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        onUpdate(new Map([[track.id, { embeddingState: 'failed', embeddingError: message }]]), {
          done,
          total,
          failed,
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
}

/**
 * Fifth pass (v0.9.10b): the vocal strip, one track after another, after everything else has landed (the owner's choice 03/10: "in the
 * background, song after song"). Same shape as `queueEmbeddingBackfill`, and for the same reasons: only tracks whose BPM analysis is done
 * (so a `contentHash` exists), concurrency 1, nothing in the UI waits on it.
 *
 * Every outcome is written to the track — a finished strip, a named state (too short, silent, mono, Trance rule) or `failed` with the
 * reason — so the library can count how many are done and how many failed instead of leaving a silent gap.
 */
export async function queueVocalStripBackfill(
  tracks: Track[],
  onUpdate: (patch: Map<string, Partial<Track>>, progress: AnalysisQueueProgress) => void,
  opts: { signal?: { cancelled: boolean }; isUrgent?: (id: string) => boolean } = {},
): Promise<void> {
  // `queued`/`analysing` are picked up too: a pass cancelled mid-track (a rescan, files added) leaves its track in `analysing`, and skipping it would count it as waiting forever.
  const pending = tracks.filter((t) => t.analysisState === 'analyzed' && (!t.vocal || t.vocal.state === 'queued' || t.vocal.state === 'analysing'))
  const total = pending.length
  let done = 0
  let failed = 0
  while (pending.length > 0) {
    if (opts.signal?.cancelled) return
    // A song on a deck is the one the owner is about to look at: it goes first.
    const urgent = opts.isUrgent ? pending.findIndex((t) => opts.isUrgent!(t.id)) : -1
    const track = pending.splice(urgent >= 0 ? urgent : 0, 1)[0]
    onUpdate(new Map([[track.id, { vocal: { state: 'analysing', timeline: null } }]]), { done, total, failed })
    let result: VocalResult
    try {
      const contentHash = track.contentHash as string
      const genre = track.genre ?? ''
      const cached = await getVocalStrip(contentHash, genre)
      if (cached) result = cached
      else {
        const data = await (await track.handle.getFile()).arrayBuffer()
        const buffer = await engine.decode(data)
        result = await analyseVocalStrip(pcmFromAudioBuffer(buffer), genre)
        try {
          await putVocalStrip(contentHash, genre, result)
        } catch {
          // Not stored: this session still shows the strip; the next one recomputes it.
        }
      }
    } catch (err) {
      result = { state: 'failed', timeline: null, note: err instanceof Error ? err.message : String(err) }
    }
    done++
    if (result.state === 'failed') failed++
    if (opts.signal?.cancelled) return
    onUpdate(new Map([[track.id, { vocal: result }]]), { done, total, failed })
  }
}
