import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '@/app/state/store'
import { Button } from '@/app/components/controls'
import type { MisnamedFile } from '@/core/audio-format'
import { canRenameFiles, currentScanRoot, renameTrackExtension } from '@/platform/source-fsaccess/misnamed'

const FORMAT_NAME: Record<MisnamedFile['actual'], string> = {
  mp3: 'MP3',
  m4a: 'M4A (AAC)',
  wav: 'WAV',
  flac: 'FLAC',
  ogg: 'Ogg',
  aiff: 'AIFF',
  webm: 'WebM',
}

type RowState = { kind: 'busy' } | { kind: 'failed'; why: string }

/**
 * v0.9.59 — files whose name says one format and whose content is another. The owner decides **file by file**: there is no
 * "fix all" button on purpose, because this is the one place the app changes a file of his that already existed.
 * What a click does is spelled out above the list — only the ending of the name changes.
 */
export function MisnamedDialog() {
  const { misnamed, unverified, unreadable, tracks } = useStore(
    useShallow((s) => ({
      misnamed: s.library.misnamed,
      unverified: s.library.misnamedUnverified,
      unreadable: s.library.misnamedUnreadable,
      tracks: s.library.tracks,
    })),
  )
  const decks = useStore(useShallow((s) => ({ A: s.decks.A.track?.id ?? null, B: s.decks.B.track?.id ?? null })))
  const setLibrary = useStore((s) => s.setLibrary)
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [renamedNames, setRenamedNames] = useState<string[]>([])
  const canRename = canRenameFiles()
  const closeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const close = () => setLibrary({ misnamedOpen: false })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fix(m: MisnamedFile) {
    const root = currentScanRoot()
    const track = tracks.find((t) => t.id === m.trackId)
    if (!root || !track) {
      setRows((r) => ({ ...r, [m.trackId]: { kind: 'failed', why: 'The folder is not open any more. Scan it again.' } }))
      return
    }
    // the owner can load the song onto a deck (MIDI, library) between the render and this click landing
    const live = useStore.getState().decks
    if (live.A.track?.id === m.trackId || live.B.track?.id === m.trackId) {
      setRows((r) => ({ ...r, [m.trackId]: { kind: 'failed', why: 'It is loaded on a deck now. Eject it first.' } }))
      return
    }
    setRows((r) => ({ ...r, [m.trackId]: { kind: 'busy' } }))
    const out = await renameTrackExtension(root, track, m)
    if (!out.ok) {
      setRows((r) => ({ ...r, [m.trackId]: { kind: 'failed', why: out.why } }))
      return
    }
    const store = useStore.getState()
    // `id` stays what it was: running tag and analysis passes address the track by it, and a changed id would drop their
    // results. `path` and `kind` follow the file, so the row and the next read show the true name.
    const newPath = track.path.slice(0, track.path.length - m.fileName.length) + out.newName
    store.setLibrary({
      tracks: store.library.tracks.map((t) => (t.id === m.trackId ? { ...t, path: newPath, kind: m.suggestedExt } : t)),
      misnamed: store.library.misnamed.filter((x) => x.trackId !== m.trackId),
    })
    setRows((r) => {
      const { [m.trackId]: _gone, ...rest } = r
      return rest
    })
    setRenamedNames((n) => [...n, `${m.fileName} → ${out.newName}`])
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Files with the wrong extension" className="absolute inset-0 z-40 flex items-center justify-center bg-surface-0/80 p-4 backdrop-blur-sm">
      <div ref={closeRef} tabIndex={-1} className="flex max-h-full w-full max-w-[640px] outline-none flex-col rounded-[var(--radius-sm)] border border-hairline bg-surface-1 shadow-[var(--shadow-control)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2.5">
          <h2 className="text-sm font-bold tracking-tight">Files with the wrong extension</h2>
          <span className="tnum text-2xs text-warn">{misnamed.length} left</span>
          <span className="ml-auto text-2xs text-grid-dim">Esc to close</span>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3 text-xs">
          <p className="mb-2 text-grid-muted">
            These files are not what their name says (for example an M4A saved as “.mp3”). Other players and DJ programs trust the name, and this app opens such a
            file more slowly. Fixing one <strong className="text-grid-text">renames that file</strong>: only the ending changes, the music inside is not touched,
            and nothing is created or deleted. Settings saved under the old file name (for example a saved tempo found by path) may need setting again after the next folder scan. You confirm each file on its own; the browser asks permission the first time.
          </p>
          {!canRename && (
            <p className="mb-2 rounded-[var(--radius-xs)] bg-surface-2 px-2 py-1.5 text-warn">
              This browser cannot rename files from a page, so the buttons are off. Rename them in your file explorer to the ending shown on each row.
            </p>
          )}
          {misnamed.length === 0 ? (
            <p className="py-3 text-grid-text">No file with the wrong extension is left in the list.</p>
          ) : (
            <ul className="divide-y divide-hairline/60">
              {misnamed.map((m) => {
                const track = tracks.find((t) => t.id === m.trackId)
                const onDeck = (['A', 'B'] as const).find((d) => decks[d] === m.trackId)
                const st = rows[m.trackId]
                return (
                  <li key={m.trackId} className="flex items-start gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-grid-text" title={track?.path ?? m.fileName}>
                        {m.fileName}
                      </div>
                      <div className="text-2xs text-grid-muted">
                        Really a {FORMAT_NAME[m.actual]} file, named “.{m.currentExt}”
                        {track && track.path.includes('/') ? ` · in ${track.path.slice(0, track.path.lastIndexOf('/'))}` : ''}
                      </div>
                      {st?.kind === 'failed' && <div className="mt-0.5 text-2xs text-warn">{st.why}</div>}
                      {onDeck && !st && <div className="mt-0.5 text-2xs text-grid-dim">Loaded on deck {onDeck}: eject it first, then fix it.</div>}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canRename || !!onDeck || st?.kind === 'busy'}
                      onClick={() => void fix(m)}
                      title={`Rename this file from .${m.currentExt} to .${m.suggestedExt}`}
                    >
                      {st?.kind === 'busy' ? 'Renaming…' : `Rename to .${m.suggestedExt}`}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {renamedNames.length > 0 && (
            <div className="mt-3 border-t border-hairline pt-2 text-2xs text-grid-muted">
              <div className="mb-0.5 font-semibold text-grid-text">Renamed now</div>
              {renamedNames.map((n) => (
                <div key={n} className="truncate">
                  {n}
                </div>
              ))}
            </div>
          )}
          {(unverified > 0 || unreadable > 0) && (
            <p className="mt-3 text-2xs text-grid-dim">
              Not checked (usually MP3 files with no tag at the start, which carry no safe signature): {unverified} file{unverified === 1 ? '' : 's'} whose content could not be identified from the first bytes
              {unreadable > 0 ? `, ${unreadable} that could not be opened` : ''}. They are left alone.
            </p>
          )}
        </div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-2.5">
          <span className="text-2xs text-grid-dim">“Not now” keeps the amber badge in the library header until they are fixed.</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={close}>
            {misnamed.length === 0 ? 'Close' : 'Not now'}
          </Button>
        </footer>
      </div>
    </div>
  )
}
