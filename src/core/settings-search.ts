import { FIELDS, type FieldGroup, type Settings } from '@/core/settings'

/**
 * The Settings screen's free-text search (v0.9.55, the owner's request 07/10).
 *
 * Pure: it knows the schema and four named blocks, never the DOM. The screen
 * passes a query in and renders what comes back.
 */

export type SettingsSection = FieldGroup | 'system' | 'legal'

/** The tabs, in screen order. Lives here so the search can match a tab's name. */
export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; blurb: string; keywords: readonly string[] }[] = [
  { id: 'hardware', label: 'Controller', blurb: 'Your FLX4, and how hard it pushes.', keywords: ['flx4', 'midi', 'hardware', 'בקר', 'קונטרולר', 'חומרה'] },
  { id: 'feel', label: 'Feel', blurb: 'How the decks respond to a hand.', keywords: ['feel', 'response', 'תחושה', 'תגובה'] },
  { id: 'display', label: 'Display', blurb: 'What is drawn, and how often.', keywords: ['screen', 'graphics', 'תצוגה', 'מסך', 'גרפיקה'] },
  { id: 'library', label: 'Library', blurb: 'The track list and how keys are named.', keywords: ['tracks', 'songs', 'ספרייה', 'שירים', 'רשימה'] },
  { id: 'help', label: 'Help', blurb: 'Explain every control before you touch it.', keywords: ['help', 'עזרה'] },
  { id: 'system', label: 'System', blurb: 'What this machine supports, and what DeckMix does with it.', keywords: ['system', 'browser', 'מערכת', 'דפדפן', 'מחשב'] },
  { id: 'legal', label: 'Privacy & Terms', blurb: 'What leaves this computer (nothing), and what you agree to by using this.', keywords: ['privacy', 'legal', 'terms', 'פרטיות', 'תנאים', 'משפטי', 'זכויות'] },
]

/**
 * The parts of the screen that are not in `FIELDS` — hand-written blocks with
 * their own UI. Without a named entry each, a search for "privacy" or
 * "export samples" would come back empty and the owner could not tell why.
 * A named set, not an omission: the same rule as `COMPANION_EXT`.
 */
export const PANEL_ENTRIES: {
  id: 'jogMeasure' | 'samplerBank' | 'system' | 'legal'
  section: SettingsSection
  label: string
  help: string
  keywords: readonly string[]
}[] = [
  {
    id: 'jogMeasure',
    section: 'hardware',
    label: 'Measure the jog wheel',
    help: 'Spin the FLX4 jog once to find its ticks per revolution.',
    keywords: ['jog', 'calibrate', 'measure', 'wheel', "ג'וג", 'גלגל', 'כיול', 'מדידה'],
  },
  {
    id: 'samplerBank',
    section: 'library',
    label: 'Sampler bank export and import',
    help: 'Save the sampler pads to a file or folder, or load them back.',
    keywords: ['sampler', 'pads', 'samples', 'backup', 'export', 'import', 'סאמפלר', 'סמפלר', 'פדים', 'גיבוי', 'ייצוא', 'ייבוא', 'סאמפלים'],
  },
  {
    id: 'system',
    section: 'system',
    label: 'What this machine supports',
    help: 'MIDI, file access, audio output device, and storage.',
    keywords: ['midi', 'audio output', 'speakers', 'headphones', 'storage', 'browser', 'מערכת', 'רמקולים', 'אוזניות', 'יציאת שמע', 'אחסון', 'דפדפן'],
  },
  {
    id: 'legal',
    section: 'legal',
    label: 'Privacy & Terms',
    help: 'What leaves this computer (nothing), terms, and open-source notices.',
    keywords: ['privacy', 'terms', 'license', 'copyright', 'open source', 'פרטיות', 'תנאים', 'רישיון', 'זכויות יוצרים'],
  },
]

export type Range = [start: number, end: number]

export interface SettingsHit {
  /** A field key, or a panel id. */
  id: keyof Settings | (typeof PANEL_ENTRIES)[number]['id']
  kind: 'field' | 'panel'
  section: SettingsSection
  /** Character ranges in the shown label / help to mark. */
  label: Range[]
  help: Range[]
  /**
   * What matched that is not highlighted — a hidden keyword, an option's
   * name, the tab's name. Shown as "matched: …", because a result with
   * nothing marked on it reads as a bug.
   */
  reasons: string[]
}

export interface SettingsSearchResult {
  hits: SettingsHit[]
  /** Hits grouped by tab, tabs in screen order, empty tabs left out. */
  groups: { section: SettingsSection; hits: SettingsHit[] }[]
}

// Niqqud and cantillation marks: "סֻלָּם" is still "סולם" to someone typing.
const NIQQUD = /[֑-ׇ]/
// Geresh, gershayim and the apostrophes a keyboard produces for them: "ג'וג",
// "ג׳וג" and "גוג" are one word to the owner.
const DROP = /['’׳״"`]/
const WORD = /[\p{L}\p{N}]/u
// Hebrew writes "the", "in", "to", "and", "that", "from", "as" onto the word:
// "הסולם" should find "סולם". Tried only when the whole token found nothing.
const HEBREW_PREFIX = /^[הבלושמכ]/

interface Norm {
  text: string
  /** map[i] = index in the original string of normalized char i. */
  map: number[]
}

export function normalize(raw: string): Norm {
  let text = ''
  const map: number[] = []
  // Lowercased one character at a time, so `map` stays in the original
  // string's indices: "İ".toLowerCase() is two characters, and lowercasing the
  // whole string first would shift every highlight after it.
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i].toLowerCase()
    if (NIQQUD.test(c) || DROP.test(c)) continue
    for (const ch of c) {
      text += ch
      map.push(i)
    }
  }
  return { text, map }
}

export function tokenize(query: string): string[] {
  return normalize(query)
    .text.split(/[^\p{L}\p{N}±%.#]+/u)
    .filter((t) => t.length > 0)
}

/** Every place `token` starts a word in `hay`, as ranges in the original text. */
function wordStarts(hay: string, token: string): Range[] {
  const n = normalize(hay)
  const out: Range[] = []
  let from = 0
  for (;;) {
    const i = n.text.indexOf(token, from)
    if (i < 0) break
    const before = i === 0 ? '' : n.text[i - 1]
    if (!before || !WORD.test(before)) {
      const start = n.map[i]
      const end = n.map[i + token.length - 1] + 1
      out.push([start, end])
    }
    from = i + 1
  }
  return out
}

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

interface Entry {
  id: SettingsHit['id']
  kind: SettingsHit['kind']
  section: SettingsSection
  label: string
  help: string
  options: readonly string[]
  keywords: readonly string[]
}

function entries(): Entry[] {
  const fromFields: Entry[] = FIELDS.map((f) => ({
    id: f.key,
    kind: 'field',
    section: f.group,
    label: f.label,
    help: f.help,
    options: f.kind === 'choice' ? f.options.map((o) => o.label) : [],
    keywords: f.keywords,
  }))
  const fromPanels: Entry[] = PANEL_ENTRIES.map((p) => ({
    id: p.id,
    kind: 'panel',
    section: p.section,
    label: p.label,
    help: p.help,
    options: [],
    keywords: p.keywords,
  }))
  // Panels sit first inside their tab, where the screen draws them.
  return SETTINGS_SECTIONS.flatMap((s) => [
    ...fromPanels.filter((e) => e.section === s.id),
    ...fromFields.filter((e) => e.section === s.id),
  ])
}

/** One token against one entry: highlights, or the hidden thing it matched, or nothing. */
function matchToken(e: Entry, token: string): { label: Range[]; help: Range[]; reason?: string } | null {
  const label = wordStarts(e.label, token)
  const help = wordStarts(e.help, token)
  if (label.length || help.length) return { label, help }
  const opt = e.options.find((o) => wordStarts(o, token).length)
  if (opt) return { label: [], help: [], reason: opt }
  const kw = e.keywords.find((k) => wordStarts(k, token).length)
  if (kw) return { label: [], help: [], reason: kw }
  const sec = SETTINGS_SECTIONS.find((s) => s.id === e.section)
  if (sec) {
    if (wordStarts(sec.label, token).length) return { label: [], help: [], reason: `in ${sec.label}` }
    const sk = sec.keywords.find((k) => wordStarts(k, token).length)
    if (sk) return { label: [], help: [], reason: `in ${sec.label}` }
  }
  return null
}

/**
 * Every word typed has to match somewhere in the entry — its name, its line
 * of help, an option, a hidden keyword or its tab — at the start of a word,
 * ignoring case, niqqud and geresh. An empty query matches nothing: the
 * screen shows its tabs then, not a list of everything.
 */
export function searchSettings(query: string): SettingsSearchResult {
  const tokens = tokenize(query)
  if (tokens.length === 0) return { hits: [], groups: [] }

  const hits: SettingsHit[] = []
  for (const e of entries()) {
    const label: Range[] = []
    const help: Range[] = []
    const reasons: string[] = []
    let all = true
    for (const t of tokens) {
      let m = matchToken(e, t)
      if (!m && /[א-ת]/.test(t) && HEBREW_PREFIX.test(t) && t.length > 2) m = matchToken(e, t.slice(1))
      if (!m) {
        all = false
        break
      }
      label.push(...m.label)
      help.push(...m.help)
      if (m.reason && !reasons.includes(m.reason)) reasons.push(m.reason)
    }
    if (!all) continue
    hits.push({ id: e.id, kind: e.kind, section: e.section, label: merge(label), help: merge(help), reasons })
  }

  const groups = SETTINGS_SECTIONS.map((s) => ({
    section: s.id,
    hits: hits.filter((h) => h.section === s.id),
  })).filter((g) => g.hits.length > 0)
  return { hits: groups.flatMap((g) => g.hits), groups }
}

/** Shown under "no results" — words that are known to find something. */
export const SEARCH_SUGGESTIONS = ['jog', 'key', 'waveform', 'סולם'] as const
