/**
 * Which licenses may feed a model that ships in a product that is sold (research §8.1–8.2, risk 5:
 * "one tainted source contaminates shipped weights"). Allow-list, not block-list: a license this
 * file does not recognise is refused, and the caller must say so on screen/in the log — an
 * unrecognised license is never read as "probably fine".
 */
const ALLOWED = new Set(['cc0-1.0', 'cc-by-4.0', 'cc-by-3.0', 'cc-by-2.0'])

export const normalizeLicense = (s: string): string => s.trim().toLowerCase().replace(/[\s_]+/g, '-')

export function isTrainingLicense(license: string): boolean {
  return ALLOWED.has(normalizeLicense(license))
}

export interface SourceRecord {
  /** File name or dataset id the sound came from. */
  id: string
  license: string
  /** Where it was fetched (URL or dataset record), kept for the credit file CC BY requires. */
  origin: string
}

/** Splits a source list into usable and refused, with the reason — the refused list is shown, never dropped. */
export function vetSources<T extends SourceRecord>(sources: readonly T[]): { ok: T[]; refused: { source: T; reason: string }[] } {
  const ok: T[] = []
  const refused: { source: T; reason: string }[] = []
  for (const s of sources) {
    if (!s.license.trim()) refused.push({ source: s, reason: 'no license recorded' })
    else if (!isTrainingLicense(s.license)) refused.push({ source: s, reason: `license "${s.license}" is not on the allow-list (CC0 / CC BY only)` })
    else ok.push(s)
  }
  return { ok, refused }
}
