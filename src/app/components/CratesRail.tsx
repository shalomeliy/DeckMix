import { useState } from 'react'
import * as ctl from '@/controls'
import { SEARCH_COLUMN_LABEL, matchesSearch } from '@/core/library-search'
import { useStore } from '@/app/state/store'
import { Button } from '@/app/components/controls'
import type { CrateRecord } from '@/platform/crates-idb/store'

/** Same drag payload `Library.tsx`'s rows already set and `Deck.tsx`/`PadGrid.tsx` already consume — a crate is a third drop target, not a new kind of drag. */
const TRACK_MIME = 'application/x-soundgrid-track'

/**
 * The crate rail (v0.8.1) — a flat list of named track groupings, collapsed
 * into the Library panel beside the table rather than a second header row
 * (the ~710px height budget is already nearly spent by the table's own
 * chrome; the rail spends width instead). No tree: a flat list is what the
 * feature spec settled on after the owner's real library — a few hundred
 * tracks in six genre folders — turned out not to need nesting.
 *
 * Clicking a crate row narrows the Library table to that crate's tracks
 * (`ctl.setActiveCrate`) — without this, a crate could be filled but never
 * looked at, which is not a track organizer, it is a write-only list.
 */
export function CratesRail() {
  const crates = useStore((s) => s.crates)
  const activeCrateId = useStore((s) => s.library.activeCrateId)
  const tracks = useStore((s) => s.library.tracks)
  const query = useStore((s) => s.library.query)
  const queryColumn = useStore((s) => s.library.queryColumn)
  const knownHashes = new Set(tracks.map((t) => t.contentHash).filter((h): h is string => h != null))
  // Same "not done yet" test `Library.tsx`'s header count uses. A fresh scan's
  // tracks start with no `contentHash` at all until the background queue
  // reaches them (`addTrackToCrate`'s comment above), so right after loading a
  // folder a crate's real members briefly fail to match anything in
  // `knownHashes` — not because they moved or were deleted, but because the
  // library hasn't caught up. Without this flag that transient state rendered
  // as "N not found" / an empty crate, which reads as permanent data loss.
  const analysisCatchingUp = tracks.some(
    (t) => t.analysisState === 'queued' || t.analysisState === 'analyzing',
  )

  function onNewCrate() {
    const name = window.prompt('New crate name:')
    if (name?.trim()) ctl.createCrate(name.trim())
  }

  function onSaveSearchAsCrate() {
    const name = window.prompt('Save the current search as a crate named:')
    if (name?.trim()) ctl.createSmartCrate(name.trim(), query, queryColumn)
  }

  function onDelete(crate: CrateRecord) {
    const count = (crate.kind === 'manual' ? crate.members : crate.materialized)?.length ?? 0
    const warning =
      count > 0
        ? `Delete "${crate.name}"? It has ${count} track${count === 1 ? '' : 's'} in it — the tracks themselves are not deleted, only this grouping.`
        : `Delete "${crate.name}"?`
    if (window.confirm(warning)) {
      if (crate.id === activeCrateId) ctl.setActiveCrate(null)
      ctl.deleteCrate(crate.id)
    }
  }

  function onSelect(crate: CrateRecord) {
    ctl.setActiveCrate(crate.id === activeCrateId ? null : crate.id)
  }

  return (
    <div className="flex w-40 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline p-2">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wide text-grid-dim">Crates</span>
      </div>
      <Button variant="ghost" size="sm" onClick={onNewCrate}>
        + New crate
      </Button>
      {query.trim() && (
        <Button variant="ghost" size="sm" onClick={onSaveSearchAsCrate} title={`Save "${query}" as a smart crate`}>
          ★ Save search
        </Button>
      )}
      <div className="mt-1 flex flex-col gap-0.5">
        {[...crates.values()].map((crate) => (
          <CrateRow
            key={crate.id}
            crate={crate}
            knownHashes={knownHashes}
            analysisCatchingUp={analysisCatchingUp}
            selected={crate.id === activeCrateId}
            onSelect={() => onSelect(crate)}
            onDelete={() => onDelete(crate)}
            onRename={() => {
              const name = window.prompt('Rename crate:', crate.name)
              if (name?.trim()) ctl.renameCrate(crate.id, name.trim())
            }}
          />
        ))}
      </div>
    </div>
  )
}

function CrateRow({
  crate,
  knownHashes,
  analysisCatchingUp,
  selected,
  onSelect,
  onDelete,
  onRename,
}: {
  crate: CrateRecord
  knownHashes: Set<string>
  analysisCatchingUp: boolean
  selected: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: () => void
}) {
  const members = crate.kind === 'manual' ? (crate.members ?? []) : (crate.materialized ?? [])
  const missing = members.filter((h) => !knownHashes.has(h)).length
  const tracks = useStore((s) => s.library.tracks)
  // Stale = re-running the saved query against the library right now would
  // produce a different result than the last refresh froze into
  // `materialized`. This recomputes the match for comparison only — it is
  // never written back, so "updates only on a refresh click" still holds
  // for the stored data; only the badge is live.
  const stale =
    crate.kind === 'smart' &&
    crate.query != null &&
    (() => {
      const current = tracks.filter((t) => t.contentHash && matchesSearch(t, crate.query!, crate.queryColumn)).map((t) => t.contentHash)
      const before = crate.materialized ?? []
      return current.length !== before.length || current.some((h) => !before.includes(h!))
    })()
  // A track that matches the saved query but has no contentHash yet
  // (background analysis still running, e.g. right after a fresh scan) is
  // silently excluded from `refreshSmartCrate`'s result — named here rather
  // than left invisible, per the project's own central "never skip
  // silently" rule.
  const pending =
    crate.kind === 'smart' && crate.query != null
      ? tracks.filter((t) => !t.contentHash && matchesSearch(t, crate.query!, crate.queryColumn)).length
      : 0

  const [dragOver, setDragOver] = useState(false)
  const canAcceptDrop = crate.kind === 'manual'

  function onDragOver(e: React.DragEvent) {
    if (!canAcceptDrop || !e.dataTransfer.types.includes(TRACK_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  function onDrop(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(TRACK_MIME)) return
    e.preventDefault()
    setDragOver(false)
    if (!canAcceptDrop) {
      useStore.getState().setNotice({
        text: `"${crate.name}" is a smart crate — its tracks come from its saved search, not from dragging one in. Refresh it instead.`,
        tone: 'warn',
        source: 'library',
      })
      return
    }
    const id = e.dataTransfer.getData(TRACK_MIME)
    const track = useStore.getState().library.tracks.find((t) => t.id === id)
    if (track) ctl.addTrackToCrate(crate.id, track)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        // keydown bubbles: without this guard, Tab-ing to the nested rename/
        // delete/refresh <button>s and pressing Enter/Space would hit THIS
        // handler (via bubbling) before the button's own click, cancelling
        // the button's activation and toggling row selection instead —
        // found by change-reviewer on the first version of this handler.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`group cursor-pointer rounded-[var(--radius-sm)] px-2 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
        selected ? 'bg-surface-3' : 'hover:bg-surface-2'
      } ${dragOver ? 'outline-2 outline-[var(--color-accent)] -outline-offset-2' : ''}`}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate" title={crate.name}>
          {crate.kind === 'smart' ? '★ ' : ''}
          {crate.name}
        </span>
        <span className="tnum shrink-0 text-2xs text-grid-dim">{members.length}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRename()
          }}
          aria-label="Rename this crate"
          className="shrink-0 text-2xs text-grid-dim opacity-0 hover:text-grid-text group-hover:opacity-100"
          title="Rename this crate"
        >
          ✎
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          aria-label="Delete this crate"
          className="shrink-0 text-2xs text-grid-dim opacity-0 hover:text-warn group-hover:opacity-100"
          title="Delete this crate"
        >
          ✕
        </button>
      </div>
      {crate.kind === 'smart' && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              ctl.refreshSmartCrate(crate.id)
            }}
            className="text-2xs text-grid-dim hover:text-grid-text"
            title={`Re-run the saved search: ${crate.queryColumn ? `${SEARCH_COLUMN_LABEL[crate.queryColumn]} ▸ ` : ''}${crate.query}`}
          >
            ⟳ refresh
          </button>
          {stale && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1 py-0.5 text-2xs font-semibold text-warn"
              title="The library changed since this crate was last refreshed — click refresh to update it."
            >
              stale
            </span>
          )}
          {pending > 0 && (
            <span
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1 py-0.5 text-2xs font-semibold text-grid-muted"
              title="These tracks match the saved search but are still being analyzed — refresh again once analysis catches up to include them."
            >
              {pending} pending
            </span>
          )}
        </div>
      )}
      {missing > 0 && analysisCatchingUp && (
        <div
          className="mt-0.5 text-2xs text-grid-muted"
          title="The library is still analyzing tracks after a scan — these will match again once it catches up. If they still don't after that, they were moved or deleted outside DeckMix."
        >
          {missing} checking…
        </div>
      )}
      {missing > 0 && !analysisCatchingUp && (
        <div
          className="mt-0.5 text-2xs text-warn"
          title="These tracks are no longer in the library — moved or deleted outside DeckMix."
        >
          {missing} not found
        </div>
      )}
    </div>
  )
}
