import { estimateBeatGrid, type BeatGridEstimate } from '@/core/beatgrid'
import type { PcmData, TrackAnalysis } from '@/core/ports/analyzer'

/** Rare path: files with more than two channels. */
function mixAt(chans: Float32Array[], i: number, invCh: number): number {
  let v = 0
  for (let c = 0; c < chans.length; c++) v += chans[c][i]
  return v * invCh
}

export interface WaveformAnalysis {
  /** interleaved [min, max] per bucket — the envelope */
  peaks: Float32Array
  /** low/mid/high RMS per bucket — the colour */
  bands: Float32Array
}

/**
 * The one place `AudioBuffer` meets this module (v0.4.0). `analyzeWaveform`/
 * `detectBeatGrid` below take plain `PcmData` instead — a dedicated Worker has
 * neither `AudioBuffer` nor `OfflineAudioContext` in this app's target
 * Chromium (verified, not assumed — see `workshop-output/PLAN.md`), so the
 * numeric work had to stop depending on a live Web Audio object to run there
 * at all. This conversion stays main-thread, right after `engine.decode`.
 */
export function pcmFromAudioBuffer(buffer: AudioBuffer): PcmData {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  return { channels, sampleRate: buffer.sampleRate }
}

/**
 * Like `pcmFromAudioBuffer`, but copies each channel explicitly via
 * `copyFromChannel` instead of `getChannelData`. Needed wherever the same
 * decoded `AudioBuffer` feeds two separate Worker calls that each transfer
 * their `PcmData`'s buffers away (v0.8.5 — `queueLibraryAnalysis` calling
 * both `analyzerWorker.analyze` and `classicalEmbedder.embed`, see
 * `workshop-output/PLAN.md` §3): repeated `getChannelData()` calls are not
 * guaranteed by spec to return independent arrays (MDN: whether the same
 * object comes back is implementation-defined), so relying on it for a
 * *second*, separately-transferred read risks handing a worker an already
 * -detached, zero-length array instead of real audio. `copyFromChannel` is
 * the spec-sanctioned way to get an explicit, owned copy.
 */
export function pcmCopyFromAudioBuffer(buffer: AudioBuffer): PcmData {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = new Float32Array(buffer.length)
    buffer.copyFromChannel(data, c)
    channels.push(data)
  }
  return { channels, sampleRate: buffer.sampleRate }
}

/**
 * Everything the waveform needs, in a single pass over the samples.
 *
 * Peaks and bands used to be two functions, each starting by flattening the
 * track to mono into its own full-length Float32Array. On a 6-minute stereo
 * track that is a 63MB allocation apiece, and with detectBpm doing the same it
 * put ~190MB on the heap to draw one waveform. Here the channels are averaged
 * inline, so nothing track-sized is allocated at all and the samples are walked
 * once instead of twice.
 *
 * The envelope is normalised to the track's own loudest point so the display
 * fills the panel whatever the file was mastered at — a quiet rip shouldn't
 * draw a thin line. Display gain only; the audio path never sees it.
 *
 * Bands come from two one-pole low-passes splitting at ~200Hz and ~4kHz. Cheap
 * filters are right here: this drives a colour, not a crossover.
 */
export function analyzeWaveform(pcm: PcmData, buckets = 2000): WaveformAnalysis {
  const chans = pcm.channels
  const nch = chans.length
  const len = chans[0].length
  const invCh = 1 / nch
  const ch0 = chans[0]
  const ch1 = nch > 1 ? chans[1] : ch0
  const stereo = nch === 2
  const multi = nch > 2

  const peaks = new Float32Array(buckets * 2)
  const bands = new Float32Array(buckets * 3)
  const step = len / buckets

  const coeff = (hz: number) => {
    const rc = 1 / (2 * Math.PI * hz)
    const dt = 1 / pcm.sampleRate
    return dt / (rc + dt)
  }
  const aLow = coeff(200)
  const aHigh = coeff(4000)

  let lpLow = 0
  let lpHigh = 0
  let bucket = 0
  let min = 0
  let max = 0
  let sumLow = 0
  let sumMid = 0
  let sumHigh = 0
  let n = 0
  let loudest = 0
  let end = Math.max(1, Math.min(len, Math.floor(step)))

  for (let i = 0; i < len; i++) {
    // mono and stereo are hoisted out of the indirection: reading chans[c][i]
    // through the array-of-arrays inside the loop is ~40% slower than holding
    // the channel refs directly, and no real file has more than two channels
    const v = multi ? mixAt(chans, i, invCh) : stereo ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]

    if (v < min) min = v
    if (v > max) max = v

    lpLow += aLow * (v - lpLow)
    lpHigh += aHigh * (v - lpHigh)
    const mid = lpHigh - lpLow
    const high = v - lpHigh
    sumLow += lpLow * lpLow
    sumMid += mid * mid
    sumHigh += high * high
    n++

    if (i + 1 >= end && bucket < buckets) {
      peaks[bucket * 2] = min
      peaks[bucket * 2 + 1] = max
      if (-min > loudest) loudest = -min
      if (max > loudest) loudest = max

      const inv = 1 / n
      bands[bucket * 3] = Math.sqrt(sumLow * inv)
      bands[bucket * 3 + 1] = Math.sqrt(sumMid * inv)
      bands[bucket * 3 + 2] = Math.sqrt(sumHigh * inv)

      bucket++
      min = 0
      max = 0
      sumLow = sumMid = sumHigh = 0
      n = 0
      end =
        bucket < buckets ? Math.max(i + 2, Math.min(len, Math.floor((bucket + 1) * step))) : len
    }
  }

  if (loudest > 0.001 && loudest < 0.999) {
    const gain = 1 / loudest
    for (let i = 0; i < peaks.length; i++) peaks[i] *= gain
  }
  return { peaks, bands }
}



/** Envelope frames per second — 5ms frames, same rate `core/beatgrid.ts`'s math assumes. */
const FRAMES_PER_SEC = 200

/**
 * Onset envelope for beat detection: low-pass to isolate kick energy, then the
 * frame-to-frame rise (a plain low-pass alone flags every strong *sound*, not
 * just its *attack*). This is the only part of beat detection that has to
 * touch decoded samples, so it stays here; everything from here on — scoring
 * candidate tempos, finding phase, quantizing to the result — is pure and
 * lives in `core/beatgrid.ts` so it can be unit tested without any.
 */
export function buildOnsetEnvelope(pcm: PcmData): { onsets: Float32Array; framesPerSec: number } {
  const sr = pcm.sampleRate
  // channels averaged inline: flattening to a full-length mono copy first cost
  // 63MB on a 6-minute stereo track, for an envelope we throw away immediately
  const chans = pcm.channels
  const nch = chans.length
  const invCh = 1 / nch
  const len = chans[0].length
  const ch0 = chans[0]
  const ch1 = nch > 1 ? chans[1] : ch0
  const stereo = nch === 2
  const multi = nch > 2

  // one-pole low-pass ~200Hz to isolate kick energy
  const dt = 1 / sr
  const rc = 1 / (2 * Math.PI * 200)
  const alpha = dt / (rc + dt)
  let lp = 0
  const env: number[] = []
  const frame = Math.floor(sr / FRAMES_PER_SEC)
  let acc = 0
  let n = 0
  for (let i = 0; i < len; i++) {
    const v = multi ? mixAt(chans, i, invCh) : stereo ? (ch0[i] + ch1[i]) * 0.5 : ch0[i]
    lp += alpha * (v - lp)
    acc += lp * lp
    if (++n === frame) {
      env.push(Math.sqrt(acc / frame))
      acc = 0
      n = 0
    }
  }

  // difference envelope (onsets only)
  const onsets = new Float32Array(env.length)
  for (let i = 1; i < env.length; i++) {
    const d = env[i] - env[i - 1]
    onsets[i] = d > 0 ? d : 0
  }
  return { onsets, framesPerSec: FRAMES_PER_SEC }
}

/**
 * Beat grid estimate: bpm, phase, and whether either looks like a real
 * periodicity rather than a guess (see `core/beatgrid.ts`'s `CONFIDENCE_RATIO`
 * doc comment). `null` only when the track is too short to say anything at
 * all — a low-confidence result still comes back with a grid, so the caller
 * has something to show and quantize against while marking it unconfirmed.
 */
export function detectBeatGrid(
  pcm: PcmData,
  opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null },
): BeatGridEstimate | null {
  const { onsets, framesPerSec } = buildOnsetEnvelope(pcm)
  return estimateBeatGrid(onsets, framesPerSec, opts)
}

/**
 * `analyzeWaveform` + `detectBeatGrid`, packaged into one `TrackAnalysis`
 * (v0.4.0's `Analyzer` port shape). The one place both are called together,
 * so `platform/analyzer-worker/worker.ts` (inside the Worker) and its
 * main-thread fallback (`platform/analyzer-worker/index.ts`, used when
 * `capabilities.webWorker` is false) build the exact same result the exact
 * same way — never two implementations of "what analysis means" to drift
 * apart. Bucket count is derived here from duration (moved from
 * `controls.ts`'s old inline formula, unchanged: ~1 bucket per 1.3 rendered
 * pixels at 150px/sec) rather than passed in, so every caller gets the same
 * waveform resolution without recomputing it themselves.
 */
export function analyzeTrack(
  pcm: PcmData,
  opts?: { minBpm?: number; maxBpm?: number; hintBpm?: number | null },
): TrackAnalysis {
  const durationSec = pcm.channels[0].length / pcm.sampleRate
  const buckets = Math.min(120_000, Math.max(2_000, Math.ceil(durationSec * 200)))
  const { peaks, bands } = analyzeWaveform(pcm, buckets)
  const detected = detectBeatGrid(pcm, opts)
  return {
    peaks,
    bands,
    bpm: detected?.grid.bpm ?? null,
    durationSec,
    beatGrid: detected?.grid ?? null,
    beatGridConfirmed: detected?.confident ?? false,
  }
}
