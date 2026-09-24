/**
 * `SettingsStore` on `idb-keyval`, with the pre-schema keys migrated in.
 *
 * The module holds one instance. Settings are per-machine, there is exactly one
 * window, and the alternative — passing a store through every call site — would
 * put a parameter on `controls.ts` functions that MIDI calls hundreds of times
 * a second, for a value that never differs.
 */
import { get, set } from 'idb-keyval'
import { writeBootLatency } from '@/platform/settings-idb/boot-latency'
import type { SettingsStore } from '@/core/ports'
import {
  DEFAULTS,
  SCHEMA_VERSION,
  type Settings,
  type SettingsIssue,
  migrate,
} from '@/core/settings'

const KEY = 'deckmix:settings'
const LEGACY_KEY_MODE = 'deckmix:keyMode'

function readLegacyKeyMode(): string | null {
  // Private-mode and blocked-storage browsers throw on access rather than
  // returning null, and a settings screen that cannot open is worse than one
  // that opens without an old preference carried over.
  try {
    return localStorage.getItem(LEGACY_KEY_MODE)
  } catch {
    return null
  }
}

class IdbSettingsStore implements SettingsStore {
  private _values: Settings = { ...DEFAULTS }
  private _issues: SettingsIssue[] = []
  private _migrated: string[] = []
  private listeners = new Set<(v: Settings) => void>()
  private started = false
  /**
   * Keys the user changed before the stored values finished loading.
   *
   * The Settings button is live from the first paint, and `init()` used to
   * assign `this._values` wholesale when IndexedDB answered — so a setting
   * changed inside that window was overwritten by the older stored value, and
   * the change looked like it had not saved. The user's newer intent wins.
   */
  private dirty = new Set<keyof Settings>()

  get values(): Settings {
    return this._values
  }
  get issues(): SettingsIssue[] {
    return this._issues
  }
  get migrated(): string[] {
    return this._migrated
  }

  async init(): Promise<void> {
    if (this.started) return
    this.started = true
    let stored: unknown
    try {
      stored = await get(KEY)
    } catch (err) {
      // IndexedDB can be unavailable outright. Defaults still work, but the
      // user must be told their changes will not survive a reload rather than
      // discovering it by losing them.
      this._issues = [
        {
          key: '(storage)',
          got: err instanceof Error ? err.message : String(err),
          used: 'built-in defaults, not saved',
          reason: 'wrong-type',
        },
      ]
      this.emit()
      return
    }
    const result = migrate(stored, { keyMode: readLegacyKeyMode() })
    for (const key of this.dirty) (result.values[key] as unknown) = this._values[key]
    this._values = result.values
    this._issues = result.issues
    this._migrated = result.migrated
    // A migration that is not written back runs again on every boot, and the
    // legacy value would keep winning over a change made here.
    if (result.migrated.length > 0) await this.persist()
    // Keeps the synchronous mirror honest even when the value came from
    // storage rather than from a change made in this session.
    writeBootLatency(this._values.latency)
    this.emit()
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    if (!this.started) this.dirty.add(key)
    this._values = { ...this._values, [key]: value }
    if (key === 'latency') writeBootLatency(this._values.latency)
    this.emit()
    await this.persist()
  }

  async reset<K extends keyof Settings>(key: K): Promise<void> {
    await this.set(key, DEFAULTS[key])
  }

  subscribe(fn: (values: Settings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this._values)
  }

  private async persist(): Promise<void> {
    try {
      await set(KEY, { version: SCHEMA_VERSION, ...this._values })
      // Clearing it matters as much as raising it. The issue used to be
      // append-only, so one failed write left "change applied but NOT saved" on
      // screen for the rest of the session — and a banner that reports a
      // failure which has stopped happening teaches the user to stop believing
      // the banner that exists to be believed.
      if (this._issues.some((i) => i.key === '(storage)')) {
        this._issues = this._issues.filter((i) => i.key !== '(storage)')
        this.emit()
      }
    } catch (err) {
      // The value is already live in memory and on screen. What the user must
      // not believe is that it was saved.
      this._issues = [
        ...this._issues.filter((i) => i.key !== '(storage)'),
        {
          key: '(storage)',
          got: err instanceof Error ? err.message : String(err),
          used: 'change applied but NOT saved',
          reason: 'wrong-type',
        },
      ]
      this.emit()
    }
  }
}

export const settings: SettingsStore = new IdbSettingsStore()
