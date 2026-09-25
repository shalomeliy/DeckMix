import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as ctl from '@/controls'
import { useStore } from '@/app/state/store'
import { HintIcon } from '@/app/components/controls'
import { BPM_MAX, BPM_MIN, parseBpm, parseKey } from '@/core/key-parse'
import { beatportSearch } from '@/core/source-lookup'
import type { Track } from '@/core/types'

/**
 * v0.8.38 — "check this track's BPM and key against Beatport", on request only
 * (Settings › Library turns the ↗ on; off by default, Shalom 25/09).
 *
 * A strip docked under the track list, not a popover on the row: the list is
 * virtualised, so a row scrolled out of view unmounts — and the owner is away
 * in the Beatport tab while this is open. Not modal either: the decks keep
 * working during a set.
 *
 * The app never reads Beatport; the owner types what it shows. Both fields
 * start empty with our values as placeholders — pre-filled fields would turn
 * "Update" into a one-click rubber stamp that saves nothing he checked.
 */
export function SourceCheckPanel({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const track = useStore((s) => s.library.tracks.find((t) => t.id === trackId))
  const onDeck = useStore(useShallow((s) => (['A', 'B'] as const).filter((d) => s.decks[d].track?.id === trackId)))
  const [bpmText, setBpmText] = useState('')
  const [keyText, setKeyText] = useState('')
  const [touched, setTouched] = useState({ bpm: false, key: false })
  const [saved, setSaved] = useState<string | null>(null)
  const bpmRef = useRef<HTMLInputElement>(null)

  // Fresh state per track comes from the caller's `key={trackId}` remount.
  useEffect(() => {
    bpmRef.current?.focus()
  }, [])

  if (!track) {
    // Rescanned or removed while the panel was open — said, never an empty strip.
    return (
      <Strip label="Check against Beatport" onClose={onClose}>
        <span className="text-grid-muted">That track is no longer in the list (the folder was rescanned).</span>
      </Strip>
    )
  }

  const search = beatportSearch(track)
  const bpm = bpmText.trim() ? parseBpm(bpmText) : undefined
  const key = keyText.trim() ? parseKey(keyText) : null
  const bpmError = bpmText.trim() && bpm == null ? `BPM must be a number between ${BPM_MIN} and ${BPM_MAX}.` : null
  const keyError =
    keyText.trim() && !key
      ? `Didn't recognise "${keyText.trim()}". Type it as Beatport shows it — e.g. A Minor, F♯ Minor — or as Camelot, e.g. 8A.`
      : null
  const bpmChanges = bpm != null && !(track.bpmSource === 'owner' && track.bpm === bpm)
  // The same key typed over a detected one still counts: that is how the owner
  // confirms a guess — `Am*` becomes his own `Am`.
  const keyChanges = key != null && !(track.keySource === 'owner' && track.camelot === key.camelot)
  const canUpdate = !bpmError && !keyError && (bpmChanges || keyChanges)
  // A half/double reading is the same tempo counted differently — a warning,
  // not a block, because it changes what SYNC matches against.
  const ratio = bpm != null && track.bpm ? bpm / track.bpm : null
  const octave =
    ratio != null && (Math.abs(ratio - 2) < 0.04 || Math.abs(ratio - 0.5) < 0.02)
      ? `${fmtBpm(bpm!)} is ${ratio > 1 ? 'double' : 'half'} ours (${fmtBpm(track.bpm!)}) — the same tempo counted differently. Update changes what SYNC matches against.`
      : null
  const hasOwner = track.bpmSource === 'owner' || track.keySource === 'owner'

  function update() {
    setTouched({ bpm: true, key: true })
    if (!canUpdate || !track) return
    const what = [bpmChanges && `BPM ${fmtBpm(bpm!)}`, keyChanges && key && `key ${key.key} (${key.camelot})`].filter(Boolean).join(' and ')
    const deckNote =
      bpmChanges && onDeck.length ? ` Deck ${onDeck.join(' and ')} keeps its tempo — the new BPM applies the next time you load this track.` : ''
    // "Saved" only once the save has actually landed — a failure is also said in
    // the banner, and the panel must not claim the opposite beside it.
    setSaved(`${what} applied — saving…`)
    void ctl
      .setTrackTempoKey(track.id, { bpm: bpmChanges ? bpm : undefined, key: keyChanges && key ? key : undefined })
      .then((ok) => setSaved(ok ? `${what} saved as yours.${deckNote}` : `${what} applied, but NOT saved — see the message at the top.`))
    setBpmText('')
    setKeyText('')
    setTouched({ bpm: false, key: false })
  }

  return (
    <Strip label={`Check against Beatport: ${track.title ?? track.name}`} onClose={onClose} onEnter={update}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-semibold text-grid-text">
          Checking: {track.title ?? track.name}
          {track.artist ? <span className="font-normal text-grid-muted"> — {track.artist}</span> : null}
        </span>
        <a
          href={search.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-[var(--radius-xs)] px-1.5 text-accent underline-offset-2 hover:underline focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          Beatport ↗
        </a>
        {search.basis !== 'artist and title' && (
          <span className="text-grid-dim">
            {search.basis === 'title only' ? 'No artist tag — searched by title only.' : 'No title tag — searched by the file name.'}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <span className="pt-1 text-grid-muted">
          Ours: {track.bpm ? `${fmtBpm(track.bpm)} BPM` : 'no BPM'}
          {track.bpmSource === 'owner' && ' (set by you)'} · {ourKey(track)}
        </span>
        <Field
          label="BPM"
          inputRef={bpmRef}
          value={bpmText}
          placeholder={track.bpm ? fmtBpm(track.bpm) : '125'}
          onChange={setBpmText}
          onBlur={() => setTouched((t) => ({ ...t, bpm: true }))}
          error={touched.bpm ? bpmError : null}
          width="w-20"
        />
        <Field
          label="Key"
          value={keyText}
          placeholder={track.key ?? 'A Minor'}
          onChange={setKeyText}
          onBlur={() => setTouched((t) => ({ ...t, key: true }))}
          error={touched.key ? keyError : null}
          preview={key ? `= ${key.key} · ${key.camelot}` : null}
          width="w-28"
        />
        <button
          type="button"
          onClick={update}
          disabled={!canUpdate}
          className="h-7 rounded-[var(--radius-xs)] bg-accent px-3 font-semibold text-surface-0 transition-opacity disabled:opacity-40 focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          Update
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-7 rounded-[var(--radius-xs)] border border-hairline px-3 text-grid-muted hover:bg-surface-2 focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          Keep ours
        </button>
        {hasOwner && (
          <button
            type="button"
            onClick={() => {
              setSaved(null)
              void ctl.revertTrackTempoKey(track.id, { bpm: track.bpmSource === 'owner', key: track.keySource === 'owner' })
            }}
            title="Drop what you typed and show the file's tag again — or, with no tag, what the app detected (marked *)."
            className="h-7 rounded-[var(--radius-xs)] px-2 text-grid-muted underline-offset-2 hover:text-grid-text hover:underline focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            Back to original
          </button>
        )}
        <HintIcon id="library.checkSource" />
      </div>
      {octave && <p className="mt-1 text-warn">{octave}</p>}
      {saved && (
        <p className="mt-1 text-grid-muted" role="status">
          {saved}
        </p>
      )}
    </Strip>
  )
}

function Strip({
  label,
  onClose,
  onEnter,
  children,
}: {
  label: string
  onClose: () => void
  onEnter?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      role="region"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'Enter' && onEnter && e.target instanceof HTMLInputElement) {
          e.preventDefault()
          onEnter()
        }
      }}
      className="relative shrink-0 border-t border-hairline bg-surface-1 px-3 py-2 pr-9 text-sm"
    >
      {children}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the check panel, keeping ours"
        className="absolute right-2 top-1.5 grid h-6 w-6 place-items-center rounded-[var(--radius-xs)] text-grid-dim hover:bg-surface-2 hover:text-grid-text focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        ×
      </button>
    </div>
  )
}

function Field({
  label,
  value,
  placeholder,
  onChange,
  onBlur,
  error,
  preview = null,
  width,
  inputRef,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (v: string) => void
  onBlur: () => void
  error: string | null
  preview?: string | null
  width: string
  inputRef?: React.Ref<HTMLInputElement>
}) {
  const errId = `source-check-${label}-err`
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className="text-grid-dim">{label}</span>
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          className={`${width} h-7 rounded-[var(--radius-xs)] border bg-surface-0 px-1.5 text-grid-text outline-none placeholder:text-grid-dim focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
            error ? 'border-warn' : 'border-hairline'
          }`}
        />
        {preview && <span className="tnum text-grid-muted">{preview}</span>}
      </span>
      {error && (
        <span id={errId} className="max-w-sm text-2xs text-warn">
          {error}
        </span>
      )}
    </label>
  )
}

function fmtBpm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '')
}

/** Our key and where it came from — the panel never claims a source it doesn't know. */
function ourKey(track: Track): string {
  if (!track.key && !track.camelot) return 'no key'
  const k = track.key ?? track.camelot
  if (track.keySource === 'owner') return `${k} (set by you)`
  if (track.keySource === 'detected') return `${k}${track.keyUncertain ? '?' : '*'} (detected from the audio${track.keyUncertain ? ', uncertain' : ''})`
  return `${k} (file tag)`
}
