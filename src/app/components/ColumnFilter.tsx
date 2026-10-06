import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NumberRange, TextFilter } from '@/core/library-filter'

/**
 * The ▾ button in a track-list column header and the list it opens — shared
 * by Genre (v0.9.24) and every other column (v0.9.36), so they all open,
 * place and close the same way.
 *
 * The list is portalled to `<body>` and placed `fixed` from the button's
 * rectangle: the table sits in a scrolling, sticky-header box that clipped it
 * when placed under a narrow header, and inside that box `fixed` was not
 * relative to the window (v0.9.24's first browser run lost the list off-screen).
 */
export function HeaderFilter({
  active,
  count,
  name,
  listLabel,
  summary,
  children,
}: {
  active: boolean
  /** Shown beside the ▾ while active (how many values are ticked); omitted for a text or range filter. */
  count?: number
  /** The column, for the button's label: "Filter by BPM". */
  name: string
  /** The open list's name for screen readers; `"<name> filter"` unless given. */
  listLabel?: string
  /** What the active filter keeps, for the tooltip and screen readers. */
  summary?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // The list is portalled to the end of <body>, so Tab from the ▾ never reaches
    // it: focus moves in (the text and range boxes already took it with autoFocus).
    const box = boxRef.current
    if (box && !box.contains(document.activeElement)) {
      box.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])')?.focus()
    }
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(null)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          if (open) return setOpen(null)
          // The library sits low on the owner's 710px screen — its header was at
          // y≈620 in the browser check — so the list opens upward when there is
          // more room above, and is never taller than the room it has.
          const r = btnRef.current!.getBoundingClientRect()
          const left = Math.max(8, Math.min(r.left, window.innerWidth - 216))
          const below = window.innerHeight - r.bottom - 12
          const above = r.top - 12
          setOpen(
            below >= 240 || below >= above
              ? { left, top: r.bottom + 4, maxHeight: below }
              : { left, bottom: window.innerHeight - r.top + 4, maxHeight: above },
          )
        }}
        aria-label={active ? `${name} filter: ${summary ?? 'on'}` : `Filter by ${name}`}
        aria-expanded={open != null}
        aria-haspopup="true"
        title={active ? `Showing only: ${summary ?? ''}` : `Filter by ${name}`}
        className={`ml-0.5 rounded-[var(--radius-xs)] px-0.5 text-2xs transition-colors hover:bg-surface-2 hover:text-grid-text ${
          active ? 'text-accent' : 'text-grid-dim'
        }`}
      >
        {active && count != null ? `▾${count}` : '▾'}
      </button>
      {open &&
        createPortal(
          <div
            ref={boxRef}
            role="group"
            aria-label={listLabel ?? `${name} filter`}
            className="fixed z-50 w-52 overflow-y-auto rounded-[var(--radius-sm)] border border-hairline bg-surface-1 p-1 text-left text-xs font-normal normal-case tracking-normal text-grid-text shadow-lg"
            style={{ left: open.left, top: open.top, bottom: open.bottom, maxHeight: open.maxHeight }}
          >
            {children}
            <p className="mt-1 px-2 text-2xs text-grid-dim">Esc to close</p>
          </div>,
          document.body,
        )}
    </>
  )
}

const ROW = 'flex cursor-pointer items-center gap-2 rounded-[var(--radius-xs)] px-2 py-0.5 hover:bg-surface-2'
const CLEAR = 'mb-1 w-full rounded-[var(--radius-xs)] px-2 py-1 text-left hover:bg-surface-2 disabled:opacity-50'
const INPUT =
  'w-full rounded-[var(--radius-xs)] border border-hairline bg-surface-2 px-1.5 py-0.5 text-xs text-grid-text placeholder:text-grid-dim focus:border-accent focus:outline-none'

/**
 * Tick-the-values-to-keep, like a spreadsheet column filter. Every value the
 * library holds is listed with its count; a value still ticked after its last
 * track left stays listed at 0, so it can be unticked.
 */
export function ChecklistFilterBody({
  rows,
  picked,
  onChange,
  noun,
}: {
  rows: { value: string; label: string; count: number; muted?: boolean }[]
  picked: readonly string[] | undefined
  onChange: (next: string[] | null) => void
  /** Plural, for the "Show all …" line. */
  noun: string
}) {
  const set = new Set(picked ?? [])
  const all = [
    ...rows,
    ...(picked ?? []).filter((v) => !rows.some((r) => r.value === v)).map((v) => ({ value: v, label: v || '—', count: 0, muted: false })),
  ]
  const toggle = (v: string) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next])
  }
  return (
    <>
      <button type="button" onClick={() => onChange(null)} disabled={!picked} className={CLEAR}>
        {picked ? `Show all ${noun}` : `All ${noun} shown — tick to narrow`}
      </button>
      {all.map((r) => (
        <label key={r.value || '(none)'} className={ROW}>
          <input type="checkbox" checked={set.has(r.value)} onChange={() => toggle(r.value)} />
          <span className={`min-w-0 flex-1 truncate ${r.muted ? 'italic text-grid-muted' : ''}`}>{r.label}</span>
          <span className="tnum text-grid-dim">{r.count}</span>
        </label>
      ))}
    </>
  )
}

/**
 * Title / Artist / Note: the text appears anywhere in the cell. Where a cell
 * can be empty (`blankLabel`), "empty only" and "hide empty" sit beside it —
 * the tracks with no artist are something to find, not only to lose.
 */
export function TextFilterBody({
  value,
  onChange,
  noun,
  blankLabel,
}: {
  value: TextFilter | undefined
  onChange: (next: TextFilter | null) => void
  noun: string
  /** e.g. "No artist"; omitted where a cell is never empty (Title falls back to the file name). */
  blankLabel?: string
}) {
  const blank = value?.blank
  return (
    <div className="flex flex-col gap-1 p-1">
      <button type="button" onClick={() => onChange(null)} disabled={!value} className={CLEAR}>
        {value ? `Show every ${noun}` : `Every ${noun} shown`}
      </button>
      <input
        type="text"
        autoFocus
        value={value?.contains ?? ''}
        disabled={blank === 'only'}
        onChange={(e) => onChange({ ...value, contains: e.target.value })}
        placeholder={`${noun[0].toUpperCase()}${noun.slice(1)} contains…`}
        aria-label={`${noun} contains`}
        className={INPUT}
      />
      {blankLabel && (
        <div className="mt-1 flex flex-col">
          {(
            [
              [undefined, 'Any'],
              ['hide', `Hide "${blankLabel}"`],
              ['only', `Only "${blankLabel}"`],
            ] as const
          ).map(([b, label]) => (
            <label key={label} className={ROW}>
              <input
                type="radio"
                name={`${noun}-blank`}
                checked={blank === b}
                onChange={() => onChange({ contains: b === 'only' ? undefined : value?.contains, blank: b })}
              />
              <span className="flex-1">{label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * BPM / Time: from–to, either end optional. What a range hides because the
 * track has no value yet is counted under the boxes (`missing`), and a box
 * that can't be read is marked rather than quietly read as 0.
 */
export function RangeFilterBody({
  value,
  onChange,
  noun,
  parse,
  format,
  placeholder,
  missing,
  missingNoun,
}: {
  value: NumberRange | undefined
  onChange: (next: NumberRange | null) => void
  noun: string
  parse: (raw: string) => number | undefined
  format: (n: number) => string
  placeholder: [string, string]
  /** Tracks in the library with no value for this column. */
  missing: number
  missingNoun: string
}) {
  // The boxes keep what was typed ("12" on the way to "128"); the store keeps the parsed range.
  const [from, setFrom] = useState(value?.min != null ? format(value.min) : '')
  const [to, setTo] = useState(value?.max != null ? format(value.max) : '')
  const apply = (f: string, t: string) => onChange({ min: parse(f), max: parse(t) })
  const bad = (s: string) => s.trim() !== '' && parse(s) == null
  return (
    <div className="flex flex-col gap-1 p-1">
      <button
        type="button"
        onClick={() => {
          setFrom('')
          setTo('')
          onChange(null)
        }}
        disabled={!value}
        className={CLEAR}
      >
        {value ? `Show every ${noun}` : `Every ${noun} shown`}
      </button>
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          autoFocus
          value={from}
          onChange={(e) => {
            setFrom(e.target.value)
            apply(e.target.value, to)
          }}
          placeholder={placeholder[0]}
          aria-label={`${noun} from`}
          aria-invalid={bad(from)}
          className={`${INPUT} ${bad(from) ? 'border-warn' : ''}`}
        />
        <span className="text-grid-dim">to</span>
        <input
          type="text"
          inputMode="decimal"
          value={to}
          onChange={(e) => {
            setTo(e.target.value)
            apply(from, e.target.value)
          }}
          placeholder={placeholder[1]}
          aria-label={`${noun} to`}
          aria-invalid={bad(to)}
          className={`${INPUT} ${bad(to) ? 'border-warn' : ''}`}
        />
      </div>
      {(bad(from) || bad(to)) && <p className="px-1 text-2xs text-warn">Can't read that — not applied</p>}
      {missing > 0 && (
        <p className="px-1 text-2xs text-grid-dim">
          {value ? `${missing} ${missingNoun} hidden while this is on` : `${missing} ${missingNoun} — a range hides them`}
        </p>
      )}
    </div>
  )
}
