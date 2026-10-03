/**
 * The owner's vocal marks as a file (v0.9.10b): a backup he can keep outside the browser, and the input a later training script reads.
 * Plain JSON. Reading is strict, in the project's "never skip silently" way: a file of the wrong kind or schema is refused whole, with the reason;
 * a single bad mark is refused BY NAME and counted, and the good ones still load — never a partial import that says nothing.
 */
import type { VocalManualTag } from '@/core/sound/vocal-manual'

export const VOCAL_MARKS_KIND = 'vocal-marks'
export const VOCAL_MARKS_SCHEMA = 1

export function vocalMarksExportText(tags: readonly VocalManualTag[], exportedAt: number): string {
  return JSON.stringify({ app: 'DeckMix', kind: VOCAL_MARKS_KIND, schema: VOCAL_MARKS_SCHEMA, exportedAt, marks: tags }, null, 2)
}

export interface ParsedVocalMarks {
  tags: VocalManualTag[]
  rejected: { name: string; reason: string }[]
}

const HASH = /^[0-9a-f]{64}$/

function oneMark(x: unknown): { tag: VocalManualTag } | { name: string; reason: string } {
  const m = x as Partial<VocalManualTag> | null
  const name = typeof m?.name === 'string' ? m.name : '(no name)'
  if (!m || typeof m !== 'object') return { name, reason: 'not an object' }
  if (m.schema !== 1) return { name, reason: `schema ${String(m.schema)} is not 1` }
  if (typeof m.contentHash !== 'string' || !HASH.test(m.contentHash)) return { name, reason: 'content hash is not a SHA-256' }
  if (typeof m.finished !== 'boolean') return { name, reason: 'finished is not true/false' }
  if (!Array.isArray(m.regions)) return { name, reason: 'regions is not a list' }
  for (const r of m.regions) {
    const ok = r && typeof r.fromSec === 'number' && typeof r.toSec === 'number' && Number.isFinite(r.fromSec) && Number.isFinite(r.toSec) && r.fromSec >= 0 && r.toSec > r.fromSec
    if (!ok) return { name, reason: 'a region has bad times' }
  }
  return {
    tag: {
      schema: 1,
      contentHash: m.contentHash,
      trackId: typeof m.trackId === 'string' ? m.trackId : '',
      name,
      genre: typeof m.genre === 'string' ? m.genre : undefined,
      regions: m.regions.map((r) => ({ fromSec: r.fromSec, toSec: r.toSec })),
      finished: m.finished,
      updatedAt: typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt) ? m.updatedAt : 0,
    },
  }
}

/** Throws (with the reason) when the file is not a vocal-marks file at all; otherwise separates the good marks from the named bad ones. */
export function parseVocalMarksFile(text: string): ParsedVocalMarks {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('the file is not JSON')
  }
  const f = j as { app?: unknown; kind?: unknown; schema?: unknown; marks?: unknown } | null
  if (!f || f.app !== 'DeckMix' || f.kind !== VOCAL_MARKS_KIND) throw new Error('this is not a DeckMix vocal-marks file')
  if (f.schema !== VOCAL_MARKS_SCHEMA) throw new Error(`vocal-marks file schema ${String(f.schema)} is not ${VOCAL_MARKS_SCHEMA}`)
  if (!Array.isArray(f.marks)) throw new Error('the file has no list of marks')
  const tags: VocalManualTag[] = []
  const rejected: ParsedVocalMarks['rejected'] = []
  for (const x of f.marks) {
    const r = oneMark(x)
    if ('tag' in r) tags.push(r.tag)
    else rejected.push(r)
  }
  return { tags, rejected }
}
