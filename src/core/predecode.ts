/**
 * Rules for decoding the next song ahead of time (v0.9.66; plan `docs/research/predecode-next-plan.md`). Pure: the buffer, the slot and
 * the Worker-free decode live in `platform/`. Everything here answers "should we, and is this still the same song".
 */

/** How long a row must stay selected before it is decoded: scrolling past rows must not start a decode per row. */
export const PREDECODE_DWELL_MS = 1500

/**
 * Above these a song is not decoded ahead. A decoded song is ~23 MB per minute (stereo float32 at 48 kHz): 12 minutes is ~275 MB.
 * The file-size cap covers rows whose duration is not known yet (a 60 MB file is ~25 min of MP3 or ~6 min of WAV).
 */
export const PREDECODE_MAX_SEC = 12 * 60
export const PREDECODE_MAX_BYTES = 60 * 1024 * 1024

/** Chromium reports the device's RAM rounded down to 0.25–8 GB; under this the 100+ MB slot is not worth the risk. */
export const PREDECODE_MIN_DEVICE_GB = 4

export interface PredecodeCandidate {
  sizeBytes: number
  durationSec?: number
  /** `navigator.deviceMemory`, undefined where the browser does not say */
  deviceMemoryGb?: number
}

/** A sentence for the screen, or `null` when the song may be decoded ahead. Never a silent skip: Settings prints it. */
export function predecodeSkipReason(c: PredecodeCandidate): string | null {
  if (c.deviceMemoryGb !== undefined && c.deviceMemoryGb < PREDECODE_MIN_DEVICE_GB) {
    return `this computer reports ${c.deviceMemoryGb} GB of memory`
  }
  if (c.durationSec !== undefined && c.durationSec > PREDECODE_MAX_SEC) {
    return `the song is ${Math.round(c.durationSec / 60)} minutes long (the limit is ${PREDECODE_MAX_SEC / 60})`
  }
  if (c.sizeBytes > PREDECODE_MAX_BYTES) {
    return `the file is ${Math.round(c.sizeBytes / 1048576)} MB (the limit is ${PREDECODE_MAX_BYTES / 1048576})`
  }
  return null
}

/**
 * What identifies a decode: the same file, unchanged on disk, at the same sample rate (the browser resamples to the context's rate, so a
 * buffer for another rate would sound and measure differently). Anything else is a miss and the load decodes normally.
 */
export function predecodeKey(trackId: string, sizeBytes: number, lastModified: number, sampleRate: number): string {
  return `${trackId}|${sizeBytes}|${lastModified}|${sampleRate}`
}

/** Decoded size in bytes of float32 samples, for the status line (computed, not measured). */
export function decodedBytes(lengthFrames: number, channels: number): number {
  return lengthFrames * channels * 4
}
