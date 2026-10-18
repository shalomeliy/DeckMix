import { latencyCushioned } from '@/platform/settings-idb/boot-latency'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as ctl from '@/controls'
import { DEFAULTS, FIELDS, FIELD_BY_KEY, type Field, type Settings } from '@/core/settings'
import {
  PANEL_ENTRIES,
  SEARCH_SUGGESTIONS,
  SETTINGS_SECTIONS,
  searchSettings,
  type Range,
  type SettingsHit,
  type SettingsSearchResult,
  type SettingsSection,
} from '@/core/settings-search'
import { settings } from '@/platform/settings-idb/store'
import { getPredecodeStatus, subscribePredecodeStatus } from '@/platform/audio-webaudio/predecode-slot'
import { useSettings } from '@/app/hooks/useSettings'
import { useStore } from '@/app/state/store'
import { Button, HintIcon } from '@/app/components/controls'
import { MIN_SONGS_FOR_GENRE_MODEL, genreCoverage, modelSongCounts } from '@/core/sound/genre-coverage'
import genreModelsJson from '@/core/sound/vocal-genre-models.json'
import { getAllVocalManual } from '@/platform/vocal-manual-idb/store'
import { getAllPairRecords } from '@/platform/mix-pairs-idb/store'
import { pairRows, pairTotals, type PairRow } from '@/core/pair-entries'
import { summarizeDrift } from '@/core/grid-drift'
import {
  COPYRIGHT_NOTICE,
  ossNoticeCount,
  ossNotices,
  PRIVACY_KEPT_LOCALLY,
  PRIVACY_NEVER,
  PRIVACY_NOT_APPLICABLE,
  TERMS_TEXT,
  TRADEMARK_NOTICE,
} from '@/app/legal-content'

/**
 * The Settings screen.
 *
 * **Generated from `FIELDS`, not hand-written.** Which controls exist is a
 * decision recorded once in `core/settings.ts`; a screen that listed them again
 * could grow a control the schema never sanctioned — including one for a
 * calibration constant that exists to pin a fixed bug, which is exactly what
 * v0.2.5's own scope forbids.
 *
 * Laid out for ~710 CSS px of viewport height: a fixed header and a single
 * scrolling column, so nothing important can end up below the fold on the
 * owner's screen.
 */

type Group = SettingsSection
const GROUPS = SETTINGS_SECTIONS

export function SettingsScreen({
  onClose,
  initialGroup = 'hardware',
}: {
  onClose: () => void
  initialGroup?: Group
}) {
  const values = useSettings()
  const [group, setGroup] = useState<Group>(initialGroup)
  // v0.9.55: free-text search. While the box holds text the tabs give way to
  // one list from every tab (the owner's pick, 07/10); clearing it puts back
  // the tab that was open, because `group` is never touched by typing.
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const result = useMemo(() => searchSettings(query), [query])
  const searching = query.trim().length > 0
  const queryRef = useRef(query)
  useEffect(() => {
    queryRef.current = query
  }, [query])

  // Esc closes. A full-screen panel with no keyboard way out is a trap, and the
  // decks keep playing behind it — this must never be the thing between the DJ
  // and the crossfader. With text in the search box the first Esc clears it;
  // the second always closes, so it costs one extra press at worst.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (queryRef.current.trim()) setQuery('')
        else onClose()
        return
      }
      // Ctrl+F here means this screen's search: the browser's own find cannot
      // see the tabs that are not open, so it would report "0 of 0" for a
      // setting that exists.
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Ready to type the moment the screen opens. App.tsx already ignores keys
  // while Settings is open, so typing here can never bend a playing deck.
  useEffect(() => inputRef.current?.focus(), [])

  // After a jump: bring the setting into view and flash it once, so it is
  // seen next to its neighbours rather than alone in a result list.
  useEffect(() => {
    if (!flash) return
    document.getElementById(`setting-${flash}`)?.scrollIntoView({ block: 'center' })
    const t = window.setTimeout(() => setFlash(null), 1600)
    return () => window.clearTimeout(t)
  }, [flash, group])

  function jumpTo(hit: SettingsHit) {
    setQuery('')
    setGroup(hit.section)
    setFlash(hit.id)
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = result.hits.length
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault()
      setActive((a) => (a + 1) % n)
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault()
      setActive((a) => (a - 1 + n) % n)
    } else if (e.key === 'Enter' && n) {
      e.preventDefault()
      jumpTo(result.hits[Math.min(active, n - 1)])
    }
  }

  const activeId = searching ? result.hits[Math.min(active, result.hits.length - 1)]?.id : undefined

  // A one-letter query lists 20-30 settings, taller than the 710px screen;
  // without this the arrows walk the highlight out of sight and Enter opens
  // a setting the owner never saw picked.
  useEffect(() => {
    if (activeId) document.getElementById(`result-${activeId}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-surface-0/97 backdrop-blur-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-bold tracking-tight">Settings</h2>
        <div className="relative">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onSearchKey}
            aria-controls="settings-search-results"
            aria-activedescendant={activeId ? `result-${activeId}` : undefined}
            placeholder="Search settings · חיפוש"
            aria-label="Search settings"
            dir="auto"
            className="w-56 rounded-[var(--radius-sm)] border border-hairline bg-surface-2 py-1 pl-2 pr-6 text-xs text-grid-text outline-none placeholder:text-grid-dim focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-[var(--radius-xs)] px-1 text-2xs text-grid-muted hover:text-grid-text"
            >
              ✕
            </button>
          )}
          <HintIcon id="settings.search" className="absolute -right-1.5 -top-1.5" />
        </div>
        <nav className={`flex items-center gap-1 ${searching ? 'opacity-50' : ''}`}>
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                setQuery('')
                setGroup(g.id)
              }}
              className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs transition-colors ${
                group === g.id && !searching
                  ? 'bg-surface-3 text-grid-text'
                  : 'text-grid-muted hover:bg-surface-2 hover:text-grid-text'
              }`}
            >
              {g.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-2xs text-grid-dim">Ctrl+F to search · Esc to close</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>

      <StorageReport />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {searching ? (
          <SearchResults
            query={query.trim()}
            result={result}
            values={values}
            activeId={activeId}
            onJump={jumpTo}
            onSuggest={(s) => {
              setQuery(s)
              setActive(0)
              inputRef.current?.focus()
            }}
          />
        ) : (
          <>
            <p className="mb-3 text-2xs text-grid-dim">{GROUPS.find((g) => g.id === group)?.blurb}</p>

            {group === 'system' ? (
              <div id="setting-system" className={flash === 'system' ? FLASH : undefined}>
                <SystemPanel />
              </div>
            ) : group === 'legal' ? (
              <div id="setting-legal" className={flash === 'legal' ? FLASH : undefined}>
                <LegalPanel />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {group === 'hardware' && (
                  <div id="setting-jogMeasure" className={flash === 'jogMeasure' ? FLASH : undefined}>
                    <JogMeasure />
                  </div>
                )}
                {group === 'library' && (
                  <div id="setting-samplerBank" className={flash === 'samplerBank' ? FLASH : undefined}>
                    <SamplerBankIO />
                  </div>
                )}
                {group === 'library' && (
                  <div id="setting-genreCoverage" className={flash === 'genreCoverage' ? FLASH : undefined}>
                    <GenreCoverage />
                  </div>
                )}
                {group === 'library' && (
                  <div id="setting-mixPairs" className={flash === 'mixPairs' ? FLASH : undefined}>
                    <MixPairsPanel />
                  </div>
                )}
                {group === 'library' && (
                  <div id="setting-gridCheck" className={flash === 'gridCheck' ? FLASH : undefined}>
                    <GridCheckPanel />
                  </div>
                )}
                {FIELDS.filter((f) => f.group === group).map((f) => (
                  <FieldRow key={f.key} field={f} values={values} flash={flash === f.key} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const FLASH = 'rounded-[var(--radius-sm)] ring-2 ring-[var(--color-accent)] transition-shadow'

/** Marks the matched parts of `text`. Ranges come from `searchSettings`, in this string's own indices. */
function Marked({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (ranges.length === 0) return <>{text}</>
  const out: React.ReactNode[] = []
  let at = 0
  for (const [a, b] of ranges) {
    if (a > at) out.push(text.slice(at, a))
    out.push(
      <mark key={a} className="rounded-[2px] bg-[var(--color-accent)]/30 text-grid-text">
        {text.slice(a, b)}
      </mark>,
    )
    at = b
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

/** "matched: סולם" — for a result whose reason is not marked anywhere on it. */
function Reasons({ hit }: { hit: SettingsHit }) {
  if (hit.reasons.length === 0) return null
  return <div className="mt-0.5 text-2xs text-grid-dim">matched: {hit.reasons.join(', ')}</div>
}

function SearchResults({
  query,
  result,
  values,
  activeId,
  onJump,
  onSuggest,
}: {
  query: string
  result: SettingsSearchResult
  values: Settings
  activeId: string | undefined
  onJump: (hit: SettingsHit) => void
  onSuggest: (s: string) => void
}) {
  if (result.hits.length === 0) {
    // Not a blank screen and not the full list pretending something matched:
    // say so, and hand over words that are known to find something.
    return (
      <div className="flex flex-col gap-2 text-xs" data-testid="settings-search-empty">
        <p className="text-grid-text" aria-live="polite">
          No setting matches “<span dir="auto">{query}</span>”.
        </p>
        <p className="flex items-center gap-1.5 text-2xs text-grid-dim">
          Try:
          {SEARCH_SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => onSuggest(s)}
              className="rounded-[var(--radius-xs)] bg-surface-2 px-1.5 py-0.5 text-grid-muted hover:bg-surface-3 hover:text-grid-text"
            >
              {s}
            </button>
          ))}
        </p>
        <p className="text-2xs text-grid-dim">Hebrew works too — אפשר לחפש גם בעברית.</p>
      </div>
    )
  }

  const n = result.hits.length
  const g = result.groups.length
  return (
    <div id="settings-search-results" className="flex flex-col gap-3" data-testid="settings-search-results">
      <p className="text-2xs text-grid-dim" aria-live="polite">
        {n} {n === 1 ? 'setting' : 'settings'} in {g} {g === 1 ? 'section' : 'sections'} · ↑↓ to move, Enter to open in its tab
      </p>
      {result.groups.map((grp) => {
        const sec = SETTINGS_SECTIONS.find((s) => s.id === grp.section)!
        return (
          <section key={grp.section} className="flex flex-col gap-2">
            <button
              onClick={() => onJump(grp.hits[0])}
              className="self-start text-2xs font-semibold uppercase tracking-wide text-grid-muted hover:text-grid-text"
              title={`Open ${sec.label}`}
            >
              {sec.label} ›
            </button>
            {grp.hits.map((hit) =>
              hit.kind === 'field' ? (
                <FieldRow
                  key={hit.id}
                  field={FIELD_BY_KEY.get(hit.id as keyof Settings)!}
                  values={values}
                  hit={hit}
                  active={hit.id === activeId}
                  onOpen={() => onJump(hit)}
                />
              ) : (
                <PanelHit key={hit.id} hit={hit} active={hit.id === activeId} onOpen={() => onJump(hit)} />
              ),
            )}
          </section>
        )
      })}
    </div>
  )
}

/** A block that is not a single control (jog measure, sampler export, System, Privacy): shown as a way in. */
function PanelHit({ hit, active, onOpen }: { hit: SettingsHit; active: boolean; onOpen: () => void }) {
  const p = PANEL_ENTRIES.find((e) => e.id === hit.id)!
  return (
    <div
      id={`result-${hit.id}`}
      className={`flex items-center gap-3 rounded-[var(--radius-sm)] border bg-surface-1 px-3 py-2.5 ${
        active ? 'border-[var(--color-accent)]' : 'border-hairline'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-grid-text">
          <Marked text={p.label} ranges={hit.label} />
        </div>
        <div className="text-2xs text-grid-dim">
          <Marked text={p.help} ranges={hit.help} />
        </div>
        <Reasons hit={hit} />
      </div>
      <Button variant="ghost" size="sm" onClick={onOpen}>
        Open
      </Button>
    </div>
  )
}

/**
 * What the stored settings could not give us, and what is being used instead.
 *
 * The project's central rule applied to the settings file itself: a value that
 * was repaired on the way in is a thing the user has to be able to find out.
 * Silence here would mean tuning a number the app quietly replaced.
 */
function StorageReport() {
  const { issues, migrated } = settings
  if (issues.length === 0 && migrated.length === 0) return null
  return (
    <div className="shrink-0 border-b border-hairline bg-warn/10 px-4 py-2 text-2xs">
      {migrated.length > 0 && (
        <p className="text-grid-muted">
          Carried over from an earlier version: <b>{migrated.join(', ')}</b>
        </p>
      )}
      {issues.map((i) => (
        <p key={i.key + i.got} className="text-warn">
          <b>{i.key}</b> — stored {i.got}, using {i.used} ({i.reason.replace(/-/g, ' ')})
        </p>
      ))}
    </div>
  )
}

function FieldRow({
  field,
  values,
  hit,
  active = false,
  flash = false,
  onOpen,
}: {
  field: Field
  values: Settings
  /** Set when shown as a search result: what to mark, and why it matched. */
  hit?: SettingsHit
  active?: boolean
  flash?: boolean
  /** Search results only: open this setting in its own tab. */
  onOpen?: () => void
}) {
  const value = values[field.key]
  const isDefault = value === DEFAULTS[field.key]

  return (
    <div
      id={hit ? `result-${field.key}` : `setting-${field.key}`}
      className={`rounded-[var(--radius-sm)] border bg-surface-1 px-3 py-2.5 ${
        active ? 'border-[var(--color-accent)]' : 'border-hairline'
      } ${flash ? FLASH : ''}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-grid-text">
            {onOpen ? (
              <button onClick={onOpen} className="text-left hover:underline" title="Open in its tab">
                <Marked text={field.label} ranges={hit?.label ?? []} />
              </button>
            ) : (
              field.label
            )}
            {field.premium && (
              <span className="ml-2 rounded-[var(--radius-xs)] border border-hairline px-1 py-px align-middle text-2xs font-normal text-grid-muted" title="Labelled Premium; open to everyone for now">
                Premium
              </span>
            )}
          </div>
          <div className="text-2xs text-grid-dim">
            <Marked text={field.help} ranges={hit?.help ?? []} />
          </div>
          {hit && <Reasons hit={hit} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Control field={field} value={value} />
          {/* A value the user broke has to be reversible in one click, or the
              screen is a place to get stuck rather than a place to tune. */}
          <button
            onClick={() => void settings.reset(field.key)}
            disabled={isDefault}
            title={`Default: ${String(DEFAULTS[field.key])}`}
            className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-2xs text-grid-muted transition-colors hover:bg-surface-3 hover:text-grid-text disabled:opacity-30"
          >
            Reset
          </button>
        </div>
      </div>
      {field.requiresReload && (
        <p className="mt-1.5 text-2xs text-warn">
          Takes effect after a reload — the audio engine fixes this when it starts.
        </p>
      )}
      {field.key === 'latency' && latencyCushioned() && (
        <p className="mt-1.5 text-2xs text-warn">
          הדף הזה עלה על Balanced עד שהניתוח ברקע ייגמר (v0.9.52), כדי שהסאונד לא יקפוץ. רענון אחרי סוף הניתוח מחזיר את מה שבחרת כאן.
        </p>
      )}
      {field.pending && <p className="mt-1.5 text-2xs text-warn">{field.pending}</p>}
      {field.key === 'predecodeNext' && value === true && <PredecodeStatusLine />}
    </div>
  )
}

/** What the ahead-of-time decode is doing, or why it did not: told here, never silently dropped. */
function PredecodeStatusLine() {
  const st = useSyncExternalStore(subscribePredecodeStatus, getPredecodeStatus)
  if (st.state === 'idle') return <p className="mt-1.5 text-2xs text-grid-dim">Waiting for a song to stay selected.</p>
  if (st.state === 'decoding') return <p className="mt-1.5 text-2xs text-grid-dim">Decoding "{st.name}"…</p>
  if (st.state === 'ready') return <p className="mt-1.5 text-2xs text-grid-dim">Ready: "{st.name}" ({st.megabytes} MB in memory).</p>
  return (
    <p className="mt-1.5 text-2xs text-warn">
      {st.state === 'skipped' ? 'Not decoded ahead' : 'Decoding ahead failed'}: "{st.name}" — {st.why}. It loads the normal way.
    </p>
  )
}

function Control({ field, value }: { field: Field; value: Settings[keyof Settings] }) {
  if (field.kind === 'toggle') {
    return (
      <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-grid-muted">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => void settings.set(field.key, e.target.checked as never)}
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
        {value === true ? 'On' : 'Off'}
      </label>
    )
  }

  if (field.kind === 'choice') {
    return (
      <select
        value={String(value)}
        onChange={(e) => {
          const picked = field.options.find((o) => String(o.value) === e.target.value)
          if (picked) void settings.set(field.key, picked.value as never)
        }}
        className="rounded-[var(--radius-sm)] border border-hairline bg-surface-2 px-2 py-1 text-xs text-grid-text outline-none transition-colors hover:bg-surface-3 focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        {field.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  const scale = field.displayScale ?? 1
  const shown = (value as number) * scale
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value as number}
        onChange={(e) => void settings.set(field.key, Number(e.target.value) as never)}
        className="w-36 accent-[var(--color-accent)]"
      />
      <span className="tnum w-16 text-right text-xs text-grid-text">
        {Number.isInteger(shown) ? shown : shown.toFixed(2)}
        {field.unit ? <span className="text-grid-dim">{field.unit}</span> : null}
      </span>
    </div>
  )
}

/**
 * Measure `jogTicksPerRev` against the wheel itself.
 *
 * This is the button the whole version was reordered for: the constant is a
 * property of the controller, it differs between models, and the only way to
 * get it right is to count the ticks the hardware actually sends in one turn.
 */
function JogMeasure() {
  const midiStatus = useStore((s) => s.midi.status)
  const [deckId, setDeckId] = useState<'A' | 'B'>('A')
  const [ticks, setTicks] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const stopRef = useRef<(() => number) | null>(null)

  // A measurement left running would keep swallowing jog ticks after the screen
  // closed, and the wheel would look dead with nothing on screen to explain it.
  useEffect(
    () => () => {
      stopRef.current?.()
      stopRef.current = null
    },
    [],
  )

  const ready = midiStatus === 'ready'

  function start() {
    setTicks(0)
    stopRef.current = ctl.beginJogMeasure(deckId, setTicks)
    setRunning(true)
  }

  function finish() {
    const total = stopRef.current?.() ?? 0
    stopRef.current = null
    setRunning(false)
    setTicks(total)
    // A turn that produced nothing saves nothing: writing 0 would put the jog
    // resolution at the bottom of its range and make every scratch useless,
    // from a button press that looked successful.
    if (total > 0) void settings.set('jogTicksPerRev', Math.round(total))
  }

  return (
    <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
      <div className="text-xs font-semibold text-grid-text">Measure the jog wheel</div>
      <div className="text-2xs text-grid-dim">
        Press Start, turn the wheel exactly one full revolution back to where it began, then
        press Done. The wheel will not move the deck while measuring.
      </div>

      {/* No MIDI, no measurement — and the button says which, rather than
          appearing to work and counting to zero. */}
      {!ready ? (
        <p className="mt-2 text-2xs text-warn">
          Connect the controller first — MIDI is {midiStatus}. Nothing to count until then.
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <select
            value={deckId}
            onChange={(e) => setDeckId(e.target.value as 'A' | 'B')}
            disabled={running}
            className="rounded-[var(--radius-sm)] border border-hairline bg-surface-2 px-2 py-1 text-xs text-grid-text disabled:opacity-50"
          >
            <option value="A">Deck A wheel</option>
            <option value="B">Deck B wheel</option>
          </select>
          {running ? (
            <Button variant="toggle" active tone="var(--color-accent)" size="sm" onClick={finish}>
              Done — save {ticks ?? 0}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={start}>
              Start
            </Button>
          )}
          <span className="tnum text-xs text-grid-muted">
            {ticks == null ? '' : `${ticks} ticks`}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * v0.9.69: the beat-grid experiment's result on screen. The rule is in `docs/handoff/v0.9.69.md`: over 15% of the songs he corrected
 * off by more than 25 ms (or at another tempo) means a bass-start marking flow is worth building.
 */
function GridCheckPanel() {
  const trackCount = useStore((st) => st.library.tracks.length)
  const [data, setData] = useState<Awaited<ReturnType<typeof ctl.loadGridCheckRows>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  useEffect(() => {
    let live = true
    ctl
      .loadGridCheckRows()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [rev])
  const s = data ? summarizeDrift(data.rows) : null
  const pct = (x: number | null) => (x == null ? '–' : `${Math.round(x * 100)}%`)
  const off = data ? data.rows.filter((r) => r.verdict === 'drift' || r.verdict === 'octave' || r.verdict === 'differs') : []
  return (
    <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5" data-testid="grid-check">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-grid-text">Beat grid check: your fixes against the computer</span>
        <button
          onClick={() => {
            setError(null)
            setRev((n) => n + 1)
          }}
          className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-2xs text-grid-muted transition-colors hover:bg-surface-3 hover:text-grid-text"
        >
          Refresh
        </button>
        <button
          onClick={() => void ctl.exportGridCheck()}
          className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-2xs text-grid-muted transition-colors hover:bg-surface-3 hover:text-grid-text"
        >
          Export
        </button>
      </div>
      {error ? (
        <p className="text-2xs text-warn">The saved grids could not be read, so no count is shown: {error}</p>
      ) : !data || !s ? (
        <p className="text-2xs text-grid-dim">Reading saved grids…</p>
      ) : (
        <>
          <p className="mb-1.5 text-2xs text-grid-muted">
            <b className="tnum text-grid-text">{s.corrected}</b> songs with a saved grid, including ones you only confirmed or set the bar line on (library: {trackCount}). Of the <b className="tnum text-grid-text">{s.comparable}</b> that
            have a current computer detection and a known length: <b className="tnum text-grid-text">{s.ok}</b> within 25 ms, <b className="tnum text-live">{s.drift}</b> drifting,{' '}
            <b className="tnum text-live">{s.octave}</b> half/double tempo, <b className="tnum text-live">{s.differs}</b> another tempo. Off: <b className="tnum text-grid-text">{pct(s.offShare)}</b>.{' '}
            <span className="text-grid-dim">
              {s.verdict === 'not-enough-data'
                ? 'Not enough songs yet (10 needed).'
                : s.verdict === 'build-marking'
                  ? 'Over 15%: a bass-start marking flow is worth building.'
                  : '15% or less: improve the automatic detection instead.'}{' '}
              This counts only songs you opened and saved, so it is not the rate for the whole library. The computer's grid may have been refined around the file's BPM tag. It judges beat position and tempo only, not which beat is the bar line.
            </span>
          </p>
          {s.noDetection > 0 && (
            <p className="mb-1.5 text-2xs text-grid-dim">{s.noDetection} fixed songs have no current computer detection saved (load them once or let the background analysis reach them) and are not in the percentage.</p>
          )}
          {data.detectorRecords > 0 && <p className="mb-1.5 text-2xs text-grid-dim">{data.detectorRecords} saved grids came from the computer itself, not from you, and are not compared.</p>}
          {data.refused > 0 && <p className="mb-1.5 text-2xs text-warn">{data.refused} saved grids could not be read and are not counted ({data.firstRefusal}).</p>}
          {off.length > 0 && (
            <div className="max-h-40 overflow-y-auto">
              <table className="w-full text-2xs">
                <tbody>
                  {off.map((r) => (
                    <tr key={r.contentHash} className="border-t border-hairline">
                      <td className="py-1 pr-2 text-grid-text">{r.name ?? 'not in this library'}</td>
                      <td className="py-1 tabular-nums text-live">{r.verdict === 'drift' ? `${Math.round(r.worstMs ?? 0)} ms` : r.verdict === 'octave' ? 'half/double' : 'other tempo'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * v0.9.68: the experiment's count, on screen. The pass rule is in `docs/handoff/v0.9.68.md` (10+ pairs, 3+ with two or more points).
 * A song missing from the scanned library is shown by "not in this library", never dropped from the list.
 */
function MixPairsPanel() {
  const tracks = useStore((st) => st.library.tracks)
  const [rows, setRows] = useState<PairRow[] | null>(null)
  const [unreadable, setUnreadable] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)
  useEffect(() => {
    let live = true
    getAllPairRecords()
      .then((all) => {
        if (!live) return
        setRows(pairRows(all.records))
        setUnreadable(all.unreadable)
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [rev])
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of tracks) if (t.contentHash && !m.has(t.contentHash)) m.set(t.contentHash, t.title ?? t.name)
    return m
  }, [tracks])
  const totals = rows ? pairTotals(rows) : null
  // A track's content hash is filled in lazily (types.ts), so an unmatched hash is only "not in this library" once every scanned track has one.
  const unhashed = useMemo(() => tracks.filter((t) => !t.contentHash).length, [tracks])
  const unknownName = unhashed > 0 ? 'name not known yet' : 'not in this library'
  return (
    <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5" data-testid="mix-pairs">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-grid-text">Mix pairs: songs that worked after each other</span>
        <button
          onClick={() => setRev((n) => n + 1)}
          className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-2xs text-grid-muted transition-colors hover:bg-surface-3 hover:text-grid-text"
        >
          Refresh
        </button>
      </div>
      {error ? (
        <p className="text-2xs text-warn">The saved pairs could not be read, so no count is shown: {error}</p>
      ) : !rows || !totals ? (
        <p className="text-2xs text-grid-dim">Reading saved pairs…</p>
      ) : (
        <>
          <p className="mb-1.5 text-2xs text-grid-muted">
            <b className="tnum text-grid-text">{totals.pairs}</b> pairs saved · <b className="tnum text-grid-text">{totals.withMultiple}</b> with 2 or more mix-in points ·{' '}
            <b className="tnum text-grid-text">{totals.points}</b> points in all.{' '}
            <span className="text-grid-dim">The test passes at 10+ pairs and 3+ with 2 or more points.</span>
          </p>
          {unhashed > 0 && (
            <p className="mb-1.5 text-2xs text-grid-dim">
              {unhashed} library songs are not identified yet (the background analysis fills this in), so some names below may show as not known yet.
            </p>
          )}
          {unreadable > 0 && (
            <p className="mb-1.5 text-2xs text-warn">{unreadable} saved records could not be read and are not counted.</p>
          )}
          <div className="max-h-48 overflow-y-auto">
            <table className="w-full text-2xs">
              <thead>
                <tr className="text-left text-grid-dim">
                  <th className="py-1 pr-2 font-normal">After</th>
                  <th className="py-1 pr-2 font-normal">Then</th>
                  <th className="py-1 font-normal">Points</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.fromHash + r.toHash} className="border-t border-hairline">
                    <td className="py-1 pr-2 text-grid-text">{names.get(r.fromHash) ?? unknownName}</td>
                    <td className="py-1 pr-2 text-grid-text">{names.get(r.toHash) ?? unknownName}</td>
                    <td className={r.entries.length > 1 ? 'py-1 tabular-nums text-live' : 'py-1 tabular-nums text-grid-dim'}>{r.entries.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/** v0.9.38: which genres the vocal strip learned from his marks, and how many finished songs the others lack. */
function GenreCoverage() {
  const tracks = useStore((st) => st.library.tracks)
  const [marked, setMarked] = useState<(string | undefined)[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getAllVocalManual()
      .then((all) => live && setMarked(all.filter((t) => t.finished).map((t) => t.genre)))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [])
  const rows = useMemo(
    () => (marked ? genreCoverage(tracks.map((t) => t.genre), marked, modelSongCounts(genreModelsJson)) : []),
    [tracks, marked],
  )
  return (
    <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5" data-testid="genre-coverage">
      <div className="mb-1 text-xs font-semibold text-grid-text">Vocal strip: genres learned from your marks</div>
      <p className="mb-1.5 text-2xs text-grid-dim">
        A genre gets its own model only after enough songs you finished marking ({MIN_SONGS_FOR_GENRE_MODEL}+), and only if it beat the general one in a test on songs it never saw.
      </p>
      {error ? (
        <p className="text-2xs text-warn">Your marks could not be read, so this table is not shown: {error}</p>
      ) : !marked ? (
        <p className="text-2xs text-grid-dim">Reading your marks…</p>
      ) : (
        <table className="w-full text-2xs">
          <thead>
            <tr className="text-left text-grid-dim">
              <th className="py-1 pr-2 font-normal">Genre</th>
              <th className="py-1 pr-2 font-normal">Marked</th>
              <th className="py-1 pr-2 font-normal">In library</th>
              <th className="py-1 font-normal">Vocal strip</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.genre} className="border-t border-hairline">
                <td className="py-1 pr-2 font-semibold text-grid-text">{r.genre}</td>
                <td className="py-1 pr-2 tabular-nums">{r.marked}</td>
                <td className="py-1 pr-2 tabular-nums">{r.inLibrary}</td>
                <td className={r.state === 'learned' ? 'py-1 text-live' : 'py-1 text-grid-dim'}>
                  {r.state === 'learned'
                    ? `learned from ${r.detail} songs`
                    : r.state === 'unassigned'
                      ? 'general model · set a genre to use a learned one'
                      : r.state === 'rule'
                      ? 'fixed rule: no strip, not measured'
                      : r.detail > 0
                        ? `general model · ${r.detail} more marked songs needed${r.genre === 'Hip Hop' && r.marked > 0 ? ' (tried 08/10: the models missed more of your singing, so it stays general)' : ''}`
                        : 'general model · enough marks, not yet beating the general model'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * Save-as / open for the sampler bank (ROADMAP.md v0.6.0's "export/import").
 * The functions already existed in `controls.ts` — `exportSamplerBank` and
 * `importSamplerBank` — but v0.6.0 shipped with no button anywhere calling
 * them, so the feature was unreachable even though HANDOFF.md counted it as
 * built. Both functions already report success/failure through the notice
 * banner, so this button is a thin trigger, same shape as `JogMeasure`
 * above — no local result state to manage here.
 */
function SamplerBankIO() {
  const [busy, setBusy] = useState<'export' | 'import' | 'exportFolder' | 'importFolder' | null>(null)
  const caps = useStore((s) => s.capabilities)
  // v0.8.9: the plain export leaves a recorded slot's audio out entirely
  // (it isn't portable in a JSON file) — this count is what decides whether
  // "Export bank + recordings" has anything to do, shown on the button
  // itself, before the folder dialog even opens.
  const recordedCount = useStore((s) => s.sampler.slots.filter((sl) => sl.recordingId).length)

  async function run(kind: 'export' | 'import') {
    setBusy(kind)
    try {
      await (kind === 'export' ? ctl.exportSamplerBank() : ctl.importSamplerBank())
    } finally {
      setBusy(null)
    }
  }

  async function runFolder(kind: 'exportFolder' | 'importFolder') {
    setBusy(kind)
    try {
      await (kind === 'exportFolder'
        ? ctl.exportSamplerBankWithRecordingsToFolder()
        : ctl.importSamplerBankWithRecordingsFromFolder())
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
      <div className="text-xs font-semibold text-grid-text">Sampler bank</div>
      <div className="text-2xs text-grid-dim">
        Save the 16 sampler slots to a file, or load a bank saved earlier. Importing replaces
        every slot. A live-recorded pad's audio only travels with "+ recordings", into a folder.
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('export')}>
          {busy === 'export' ? 'Saving…' : 'Export bank'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('import')}>
          {busy === 'import' ? 'Loading…' : 'Import bank'}
        </Button>
        {caps.fsAccess && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null || recordedCount === 0}
              title={recordedCount === 0 ? 'No recordings in this bank — export as file instead.' : undefined}
              onClick={() => void runFolder('exportFolder')}
            >
              {busy === 'exportFolder' ? 'Saving…' : `Export bank + recordings${recordedCount > 0 ? ` (${recordedCount})` : ''}`}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void runFolder('importFolder')}>
              {busy === 'importFolder' ? 'Loading…' : 'Import from folder'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What this machine supports, what DeckMix will not do, and the keyboard.
 *
 * The capability list is `Capabilities` made visible in one place. It was
 * already resolved at boot and only partly surfaced, so a missing feature could
 * previously only be discovered by the feature not working.
 */
function SystemPanel() {
  const caps = useStore((s) => s.capabilities)
  const output = useStore((s) => s.output)
  const scratchReady = useStore((s) => s.scratchReady)
  const scratchError = useStore((s) => s.scratchError)

  const rows: [string, boolean, string][] = [
    ['Web MIDI', caps.webmidi, 'The controller. Without it, mouse and keyboard only.'],
    ['File System Access', caps.fsAccess, 'Reading your library folder.'],
    ['AudioWorklet', caps.audioWorklet, 'Scratching. Without it decks still play, but cannot reverse.'],
    ['Per-device output', caps.setSinkId, 'Sending the mix to the controller. Without it, use the system default.'],
    ['WebGPU', caps.webgpu, 'Reserved for on-device stems (v0.20).'],
    ['OffscreenCanvas', caps.offscreenCanvas, 'Reserved for moving the waveform off the main thread (v0.12).'],
  ]

  return (
    <div className="flex flex-col gap-3">
      <p className="text-2xs text-grid-dim">DeckMix v{__APP_VERSION__}</p>

      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">This machine</div>
        <table className="w-full text-2xs">
          <tbody>
            {rows.map(([name, ok, why]) => (
              <tr key={name} className="border-b border-hairline last:border-0">
                <td className="py-1 pr-2 font-semibold text-grid-text">{name}</td>
                <td className="py-1 pr-2">
                  <span className={ok ? 'text-live' : 'text-warn'}>{ok ? 'yes' : 'no'}</span>
                </td>
                <td className="py-1 text-grid-dim">{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!scratchReady && (
          <p className="mt-1.5 text-2xs text-warn">
            Scratch engine is not running: {scratchError ?? 'AudioWorklet unavailable'}
          </p>
        )}
        <p className="mt-1.5 text-2xs text-grid-dim">
          Audio output: {output.currentId ? output.devices.find((d) => d.deviceId === output.currentId)?.label ?? output.currentId : 'system default'}
          {' · '}
          {output.multichannel ? '4-channel, cue on its own pair' : 'stereo, cue folded in'}
        </p>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">Keyboard</div>
        <table className="w-full text-2xs">
          <tbody>
            {[
              ['Q / P', 'Play or pause deck A / B'],
              ['A / ;', 'Cue deck A / B'],
              ['S / D', 'Bend deck A down / up (hold)'],
              ['K / L', 'Bend deck B down / up (hold)'],
              ['↑ / ↓', 'Move through the track list'],
              ['[ / ]', 'Load the selected track to deck A / B'],
            ].map(([keys, what]) => (
              <tr key={keys} className="border-b border-hairline last:border-0">
                <td className="tnum py-1 pr-3 font-semibold text-grid-text">{keys}</td>
                <td className="py-1 text-grid-dim">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-2xs text-grid-dim">
          There is deliberately no scratch key: a scratch is a gesture with a speed, and a key
          has none.
        </p>
      </div>

      {/* Stated, not omitted. Two of the things a DJ tool is most often asked
          about are things DeckMix does not do, and a settings screen that
          simply lacked the toggles would leave the user guessing. Points at
          the full Privacy & Terms tab (v0.8.7) rather than repeating the
          claim here — one place to keep accurate instead of two that can
          drift apart. */}
      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">What DeckMix does not do</div>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-2xs text-grid-dim">
          <li>
            <b className="text-grid-muted">Never writes to your music files.</b> Tags are read in
            byte ranges; nothing is written back, so there is no “protect library” switch to get
            wrong.
          </li>
          <li>
            <b className="text-grid-muted">No usage data, ever.</b> There is no server and no
            telemetry, so there is nothing to opt out of.
          </li>
          <li>
            <b className="text-grid-muted">No streaming services.</b> DeckMix plays the files on
            this computer.
          </li>
        </ul>
        <p className="mt-1.5 text-2xs text-grid-dim">
          Full detail, including licensing and third-party credits, in the{' '}
          <b className="text-grid-muted">Privacy &amp; Terms</b> tab above.
        </p>
      </div>
    </div>
  )
}

/**
 * Privacy & Terms tab (v0.8.7). Five named sections — privacy, terms,
 * trademark, copyright, open-source credits — the same card style as
 * `FieldRow`/`SystemPanel` rather than a pasted document, so it reads like
 * the rest of this screen instead of like a lawyer walked in.
 */
function LegalPanel() {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">Privacy</div>
        <p className="mb-1.5 text-2xs font-semibold text-grid-muted">
          {PRIVACY_NEVER[0]} {PRIVACY_NEVER[1]}
        </p>
        <div className="mb-1.5 text-2xs text-grid-dim">Kept on this computer only, and why:</div>
        <ul className="mb-2 flex list-disc flex-col gap-1 pl-4 text-2xs text-grid-dim">
          {PRIVACY_KEPT_LOCALLY.map((row) => (
            <li key={row.what}>
              <b className="text-grid-muted">{row.what}.</b> {row.why}
            </li>
          ))}
        </ul>
        <div className="mb-1.5 text-2xs text-grid-dim">
          Named here because these are the questions most apps get asked — none of them apply to
          DeckMix:
        </div>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-2xs text-grid-dim">
          {PRIVACY_NOT_APPLICABLE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">Terms of use</div>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-2xs text-grid-dim">
          {TERMS_TEXT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">Trademarks</div>
        <p className="text-2xs text-grid-dim">{TRADEMARK_NOTICE}</p>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">Copyright</div>
        <p className="text-2xs text-grid-dim">{COPYRIGHT_NOTICE}</p>
      </div>

      <div className="rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-3 py-2.5">
        <div className="mb-1.5 text-xs font-semibold text-grid-text">License</div>
        <p className="text-2xs text-grid-dim">
          DeckMix&apos;s own code is © 2026 ARTPEACE all rights reserved — see the{' '}
          <code>LICENSE</code> file. It is built with open-source libraries, each under its own license.
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer text-2xs text-grid-muted hover:text-grid-text">
            {ossNoticeCount} open-source packages
          </summary>
          <ul className="mt-1.5 max-h-48 overflow-y-auto text-2xs text-grid-dim">
            {ossNotices.map((n) => (
              <li key={n.name} className="flex justify-between gap-2 border-b border-hairline/50 py-0.5">
                <span className="truncate">{n.name}</span>
                <span className="tnum shrink-0 text-grid-dim">
                  {n.version} · {n.license}
                </span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  )
}
