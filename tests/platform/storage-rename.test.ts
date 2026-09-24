import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renamedKey, storageMoveNotice } from '@/core/storage-rename'

// idb-keyval over a plain Map: the move logic is what is under test, not IndexedDB.
const idb = new Map<string, unknown>()
let failUpdate = false
let failDel = false
let failKeys = false
vi.mock('idb-keyval', () => ({
  keys: async () => {
    if (failKeys) throw new Error('blocked')
    return [...idb.keys()]
  },
  getMany: async (ks: string[]) => ks.map((k) => idb.get(k)),
  update: async (k: string, fn: (old: unknown) => unknown) => {
    if (failUpdate) throw new Error('quota')
    idb.set(k, fn(idb.get(k)))
  },
  del: async (k: string) => {
    if (failDel) throw new Error('blocked')
    idb.delete(k)
  },
}))

const ls = new Map<string, string>()
vi.stubGlobal('localStorage', {
  get length() {
    return ls.size
  },
  key: (i: number) => [...ls.keys()][i] ?? null,
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, v),
  removeItem: (k: string) => void ls.delete(k),
})

const { migrateLegacyStorage } = await import('@/platform/storage-rename/migrate')

beforeEach(() => {
  idb.clear()
  ls.clear()
  failUpdate = false
  failDel = false
  failKeys = false
})

describe('renamedKey', () => {
  it('maps soundgrid: keys to deckmix: and leaves everything else alone', () => {
    expect(renamedKey('soundgrid:cues:abc')).toBe('deckmix:cues:abc')
    expect(renamedKey('soundgrid:settings')).toBe('deckmix:settings')
    expect(renamedKey('deckmix:settings')).toBeNull()
    expect(renamedKey('other-app:thing')).toBeNull()
    expect(renamedKey(42)).toBeNull()
  })
})

describe('migrateLegacyStorage', () => {
  it('moves every old entry, in IndexedDB and localStorage, and removes the old keys', async () => {
    const handle = { kind: 'directory', name: 'Tracks' }
    idb.set('soundgrid:libraryDir', handle)
    idb.set('soundgrid:cues:h1', [1, 2])
    idb.set('soundgrid:sampler:recording:r1', new Uint8Array([9, 9]))
    idb.set('unrelated', 'keep')
    ls.set('soundgrid:bootLatency', 'balanced')

    const r = await migrateLegacyStorage()

    expect(r).toEqual({ moved: 4, alreadyThere: 0, failed: 0, uncheckable: false })
    expect(idb.get('deckmix:libraryDir')).toBe(handle)
    expect(idb.get('deckmix:cues:h1')).toEqual([1, 2])
    expect(idb.get('deckmix:sampler:recording:r1')).toEqual(new Uint8Array([9, 9]))
    expect(idb.get('unrelated')).toBe('keep')
    expect([...idb.keys()].some((k) => k.startsWith('soundgrid:'))).toBe(false)
    expect(ls.get('deckmix:bootLatency')).toBe('balanced')
    expect(ls.has('soundgrid:bootLatency')).toBe(false)
  })

  it('moves more entries than one batch holds', async () => {
    for (let i = 0; i < 60; i++) idb.set(`soundgrid:embeddingCache:${i}`, i)
    const r = await migrateLegacyStorage()
    expect(r.moved).toBe(60)
    expect(idb.get('deckmix:embeddingCache:59')).toBe(59)
  })

  it('never overwrites a new key that already holds data, and keeps the old one rather than delete it', async () => {
    // e.g. a tab from before the rename kept writing the old key after the move
    idb.set('soundgrid:settings', { old: true })
    idb.set('deckmix:settings', { new: true })
    ls.set('soundgrid:keyMode', 'camelot')
    ls.set('deckmix:keyMode', 'musical')
    const r = await migrateLegacyStorage()
    expect(r).toMatchObject({ moved: 0, alreadyThere: 2, failed: 0 })
    expect(idb.get('deckmix:settings')).toEqual({ new: true })
    expect(idb.get('soundgrid:settings')).toEqual({ old: true })
    expect(ls.get('soundgrid:keyMode')).toBe('camelot')
    expect(storageMoveNotice(r)).toBeNull()
  })

  it('a failed delete after a good copy counts as moved, not as failed', async () => {
    idb.set('soundgrid:tempo2:h', 1.02)
    failDel = true
    const r = await migrateLegacyStorage()
    expect(r).toMatchObject({ moved: 1, failed: 0 })
    expect(idb.get('deckmix:tempo2:h')).toBe(1.02)
    expect(storageMoveNotice(r)?.tone).toBe('info')
  })

  it('a second run finds nothing to move and says nothing', async () => {
    idb.set('soundgrid:crates', [])
    await migrateLegacyStorage()
    const again = await migrateLegacyStorage()
    expect(again).toEqual({ moved: 0, alreadyThere: 0, failed: 0, uncheckable: false })
    expect(storageMoveNotice(again)).toBeNull()
  })

  it('a failed write keeps the old data where it was, and says so', async () => {
    idb.set('soundgrid:mixratings:a', 5)
    failUpdate = true
    const r = await migrateLegacyStorage()
    expect(r.failed).toBe(1)
    expect(idb.get('soundgrid:mixratings:a')).toBe(5)
    expect(storageMoveNotice(r)?.tone).toBe('warn')
  })

  it('storage that cannot even be listed is reported, not assumed empty', async () => {
    failKeys = true
    const r = await migrateLegacyStorage()
    expect(r.uncheckable).toBe(true)
    expect(storageMoveNotice(r)?.text).toMatch(/Could not check/)
  })
})

describe('storageMoveNotice', () => {
  it('tells the owner how much moved', () => {
    expect(storageMoveNotice({ moved: 12, alreadyThere: 0, failed: 0, uncheckable: false })).toEqual({
      tone: 'info',
      text: 'Moved 12 saved items (settings, cues, ratings, crates, recordings) to DeckMix. Nothing was lost.',
    })
  })
})
