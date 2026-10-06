import type { DeckId } from '@/core/types'
import type { CrossfaderCurve } from '@/core/fx'

/**
 * Audio output, as the rest of the app is allowed to see it.
 *
 * Today the only implementation is Web Audio (`platform/audio-webaudio`). The
 * swaps this exists for: an AudioWorklet + WASM DSP path for key-lock and
 * heavier processing (v0.18), and a native ASIO/CoreAudio backend once the
 * desktop build lands. Nothing outside `platform/` may touch `AudioContext`.
 */
export interface DecodedAudio {
  /** opaque to callers — only the backend that produced it may unwrap it */
  readonly handle: unknown
  readonly durationSec: number
  readonly sampleRate: number
  readonly channels: number
}

export interface AudioOutput {
  id: string
  label: string
}

export type SetOutputResult = 'ok' | 'unsupported' | 'error'

export interface DeckBackend {
  load(audio: DecodedAudio): void
  play(): void
  pause(): void
  togglePlay(): void
  seek(sec: number): void
  setTempo(t: number): void
  setLoop(startSec: number, endSec: number): void
  clearLoop(): void
  setEq(band: 'low' | 'mid' | 'high', v: number): void
  setFilter(v: number): void
  setVolume(v: number): void
  setCueMonitor(on: boolean): void
  /** sample-accurate playhead, in seconds */
  readonly position: number
  readonly playing: boolean
  readonly hasTrack: boolean
  readonly cueMonitor: boolean
  readonly loopStart: number | null
}

export interface AudioBackend {
  resume(): Promise<void>
  decode(data: ArrayBuffer): Promise<DecodedAudio>
  deck(id: DeckId): DeckBackend
  listOutputs(): Promise<AudioOutput[]>
  setOutput(deviceId: string): Promise<SetOutputResult>
  setMasterVolume(v: number): void
  setCueVolume(v: number): void
  setCueMix(v: number): void
  /** `curve` is `power` everywhere but the vocal swap (`core/fx.ts`). */
  setCrossfader(x: number, curve?: CrossfaderCurve): void
  /** true when the device exposes 4+ channels, so cue rides its own pair */
  readonly isMultichannel: boolean
  /** seconds, monotonic — the authority the Clock is built on */
  readonly currentTime: number
}
