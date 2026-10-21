/**
 * The mix log on disk (v0.13.0). A session is written in chunks (`deckmix:mixlog:<id>:<n>`) so a crash or a closed tab loses at most
 * the last 30 seconds, and nothing rewrites the whole hour each time. `deckmix:mixlog-index` lists the sessions.
 */
import { del, get, set } from 'idb-keyval'
import type { LogEvent } from '@/core/mix-log'

const INDEX = 'deckmix:mixlog-index'
const chunkKey = (id: string, n: number) => `deckmix:mixlog:${id}:${n}`

export interface MixLogSession {
  id: string
  startedAt: number
  chunks: number
}

export async function listMixLogSessions(): Promise<MixLogSession[]> {
  const v = await get<MixLogSession[]>(INDEX)
  return Array.isArray(v) ? v : []
}

/** Throws on failure: the caller says the log is not being saved instead of recording into the void. */
export async function appendMixLogChunk(session: { id: string; startedAt: number }, n: number, events: LogEvent[]): Promise<void> {
  await set(chunkKey(session.id, n), events)
  const all = await listMixLogSessions()
  const rest = all.filter((s) => s.id !== session.id)
  await set(INDEX, [...rest, { id: session.id, startedAt: session.startedAt, chunks: n + 1 }])
}

export async function readMixLogSession(s: MixLogSession): Promise<LogEvent[]> {
  const out: LogEvent[] = []
  for (let n = 0; n < s.chunks; n++) {
    const c = await get<LogEvent[]>(chunkKey(s.id, n))
    if (Array.isArray(c)) out.push(...c)
  }
  return out
}

export async function clearMixLog(): Promise<void> {
  for (const s of await listMixLogSessions()) for (let n = 0; n < s.chunks; n++) await del(chunkKey(s.id, n))
  await del(INDEX)
}
