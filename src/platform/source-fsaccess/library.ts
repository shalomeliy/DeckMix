import { get, set } from 'idb-keyval'
import { matchGenre, parentFolderName } from '@/core/genres'
import type { SavedPermission } from '@/core/library-boot'
import type { Track } from '@/core/types'
import { readTags } from '@/platform/source-fsaccess/tags'
import { analysisCacheKey } from '@/core/analysis-cache'
import { hashBytes } from '@/platform/source-fsaccess/hash'
import { engine } from '@/platform/audio-webaudio/engine'
import { pcmFromAudioBuffer, pcmCopyFromAudioBuffer } from '@/platform/analyzer-js/analyze'
import { analyzerWorker } from '@/platform/analyzer-worker'
import { analysisCache } from '@/platform/analyze-cache-idb/store'
import { classicalEmbedder } from '@/platform/embed-classical'
import { embeddingCache } from '@/platform/embed-cache-idb/store'

const HANDLE_KEY = 'soundgrid:libraryDir'

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
 * their own. `.serato-stems` is Serato's stem-separation cache: every one of
 * them has a playable source file alongside it, so listing them would show
 * those songs twice.
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
        const genre = matchGenre(folder)
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
 * concurrency and reports per-track rather than in batches: the point of
 * `'analyzing'` as its own state is a live signal, and holding it back for a
 * flush window would make the icon lie about what's happening right now.
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
  opts: { concurrency?: number; signal?: { cancelled: boolean } } = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? 2
  const total = tracks.length
  let next = 0
  let done = 0
  let failed = 0

  async function worker() {
    while (next < total) {
      if (opts.signal?.cancelled) return
      const track = tracks[next++]
      onUpdate(new Map([[track.id, { analysisState: 'analyzing' }]]), { done, total, failed })
      try {
        const file = await track.handle.getFile()
        const data = await file.arrayBuffer()
        const contentHash = await hashBytes(data)
        // Surfaced the moment the (comparatively cheap) hash is known, not
        // bundled with the 'analyzed' patch below — decode+analyze on a
        // cache miss is the expensive part, and anything keyed on
        // `contentHash` alone (a saved sampler slot, a genre override, a hot
        // cue) can resolve now instead of waiting behind it. Found by
        // testing a real library-sized reload end-to-end: bundling the two
        // meant a saved sampler slot near the end of a real library stayed
        // "not yet resolved" for as long as the whole queue's decode work
        // took, which reads exactly like "it never came back".
        if (opts.signal?.cancelled) return
        onUpdate(new Map([[track.id, { contentHash }]]), { done, total, failed })
        const hintBpm = await readTagBpm(track)
        const cacheKey = analysisCacheKey(contentHash, hintBpm)
        let analysis = await analysisCache.get(cacheKey)
        // v0.8.5 M3: resolved on BOTH branches below (cache hit and miss) —
        // M1 only ever set this on a miss, so a track whose analysis was
        // already cached (every track analyzed before v0.8.5 existed, i.e.
        // most of a real library on a normal reload) never got an embedding
        // at all. `queueEmbeddingBackfill` below is the actual backfill pass
        // for those; this `get` just picks up whatever it (or an earlier
        // session) already computed, so a reload doesn't forget it.
        let embedding: Float32Array | undefined
        let embeddingFailed = false
        if (!analysis) {
          const buffer = await engine.decode(data)
          analysis = await analyzerWorker.analyze(pcmFromAudioBuffer(buffer), { hintBpm })
          await analysisCache.put(cacheKey, analysis)
          // v0.8.5: piggybacks on this exact decode rather than a second
          // queue/pass — `workshop-output/PLAN.md` §3. A failure here never
          // fails the track's analysis (BPM/waveform already succeeded).
          try {
            embedding = await classicalEmbedder.embed(pcmCopyFromAudioBuffer(buffer))
            await embeddingCache.put(contentHash, classicalEmbedder.modelId, embedding)
          } catch {
            embeddingFailed = true
          }
        } else {
          embedding = (await embeddingCache.get(contentHash, classicalEmbedder.modelId)) ?? undefined
        }
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
                ...(embedding
                  ? { embedding, embeddingState: 'embedded' as const }
                  : embeddingFailed
                    ? { embeddingState: 'failed' as const }
                    : {}),
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
 * Fourth pass, v0.8.5 M3: fills the gap `queueLibraryAnalysis` above
 * deliberately left open — a track whose analysis was already cached before
 * this feature existed never went through the cache-miss branch that
 * computes an embedding, so on a real library (already analyzed in earlier
 * sessions) almost nothing has one after a normal reload. Decided with
 * Shalom (15/09, `HANDOFF.md`): runs automatically, in the background,
 * right after `queueLibraryAnalysis` settles — never gated behind a manual
 * action, never running *during* the main scan (the caller is responsible
 * for sequencing, not this function).
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
        const file = await track.handle.getFile()
        const data = await file.arrayBuffer()
        const buffer = await engine.decode(data)
        const embedding = await classicalEmbedder.embed(pcmFromAudioBuffer(buffer))
        await embeddingCache.put(contentHash, classicalEmbedder.modelId, embedding)
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
