import { useEffect, useRef, useState } from 'react'
import { useSettings } from '@/app/hooks/useSettings'
import { HintIcon } from '@/app/components/controls'
import type { DeckId, HotCue } from '@/core/types'

interface Props {
  deckId: DeckId
  peaks: Float32Array | null
  bands: Float32Array | null
  positionSec: number
  durationSec: number
  bpm: number | null
  /** beat grid phase (v0.3.0) — seconds from track start to beat 0. 0 draws the grid from track start, same as before the grid existed. */
  offsetSec?: number
  hotCues: HotCue[]
  color: string
  loading?: boolean
  onSeek: (sec: number) => void
}


/*
 * Spectrum colours. The band mix at each column picks a colour, so the shape
 * tells you *what* is playing and not just how loud: bass hits read warm, a
 * vocal or synth lead reads green, hats and air read blue. It is how you spot
 * the breakdown, the drop and the intro without listening through the track.
 *
 * Red/green/blue for low/mid/high is Serato's convention and DJs read it
 * fluently, so this keeps it — and keeps it saturated. An earlier pass muted
 * these off the primaries to avoid glare and the whole waveform went to mush:
 * against a near-black panel there is no glare to avoid, only contrast to win.
 */
const BAND_COLORS = [
  [255, 64, 52], // low
  [58, 226, 124], // mid
  [82, 152, 255], // high
] as const

/** Silence has no meaningful band ratio — colouring it would be noise. */
const QUIET = 0.0015

/**
 * Scrolling waveform: playhead stays centred, audio moves under it.
 * Mirrored body coloured by frequency content, beat grid, cue flags, glow playhead.
 */
export function Waveform({
  deckId,
  peaks,
  bands,
  positionSec,
  durationSec,
  bpm,
  offsetSec = 0,
  hotCues,
  color,
  loading = false,
  onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState(0)
  // Zoom, pixel density and band colouring are the user's from v0.2.5. The
  // default is WAVEFORM_PX_PER_SEC in core/constants.ts.
  const { waveformPxPerSec: PX_PER_SEC, hiResCanvas, waveformColorByEq } = useSettings()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => setSize((n) => n + 1))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Off, the canvas is one device pixel per CSS pixel: blurrier on a
    // high-density screen and roughly a quarter of the pixels to fill.
    const dpr = hiResCanvas ? window.devicePixelRatio || 1 : 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const mid = h / 2

    // background — faint vertical depth
    const bg = ctx.createLinearGradient(0, 0, 0, h)
    bg.addColorStop(0, '#0d0f15')
    bg.addColorStop(0.5, '#090a0e')
    bg.addColorStop(1, '#0d0f15')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    const resolve = (hex: string) =>
      hex.startsWith('var(')
        ? getComputedStyle(canvas).getPropertyValue(hex.slice(4, -1)).trim() || '#29c5ff'
        : hex
    const c = resolve(color)

    if (!peaks || durationSec === 0) {
      // idle rail
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(w, mid)
      ctx.stroke()
      if (loading) {
        const t = (Date.now() % 1200) / 1200
        const gx = t * w
        const g = ctx.createLinearGradient(gx - 80, 0, gx + 80, 0)
        g.addColorStop(0, 'transparent')
        g.addColorStop(0.5, c + '55')
        g.addColorStop(1, 'transparent')
        ctx.fillStyle = g
        ctx.fillRect(0, mid - 1, w, 2)
      }
      return
    }

    const buckets = peaks.length / 2
    const bucketsPerSec = buckets / durationSec
    const centerBucket = positionSec * bucketsPerSec
    const bucketsPerPx = bucketsPerSec / PX_PER_SEC

    // Waveform body: one column per pixel so each carries its own colour.
    // Colours are quantised to 5% band steps, which is invisible to the eye but
    // lets neighbouring columns share a style — assigning fillStyle is the
    // expensive part of this loop, and it now happens a handful of times per
    // frame instead of once per pixel. Heights stay per-column so the envelope
    // keeps its shape.
    let curStyle = ''
    for (let x = 0; x < w; x++) {
      // Aggregate every bucket that falls under this pixel rather than sampling
      // one of them: at >1 bucket per pixel, plain sampling drops transients and
      // the envelope visibly shimmers as the waveform scrolls.
      const bStart = Math.floor(centerBucket + (x - w / 2) * bucketsPerPx)
      const bEnd = Math.max(bStart + 1, Math.floor(centerBucket + (x + 1 - w / 2) * bucketsPerPx))
      const from = Math.max(0, bStart)
      const to = Math.min(buckets, bEnd)
      if (to <= from) continue

      let mn = 0
      let mx = 0
      let lo = 0
      let md = 0
      let hi = 0
      for (let b = from; b < to; b++) {
        const p0 = peaks[b * 2]
        const p1 = peaks[b * 2 + 1]
        if (p0 < mn) mn = p0
        if (p1 > mx) mx = p1
        if (bands && waveformColorByEq) {
          lo += bands[b * 3]
          md += bands[b * 3 + 1]
          hi += bands[b * 3 + 2]
        }
      }

      let style: string
      if (bands && waveformColorByEq) {
        const total = lo + md + hi
        if (total < QUIET) {
          style = 'rgba(150,160,180,0.3)'
        } else {
          // Square the weights before mixing. One-pole filters leak across the
          // splits, so raw ratios never reach a band's own colour — pure 60Hz
          // came out orange, not red. Squaring pulls the dominant band forward
          // and gives genuinely saturated colour while real mixtures still blend.
          const q = 20 / (lo * lo + md * md + hi * hi)
          const wl = Math.round(lo * lo * q)
          const wm = Math.round(md * md * q)
          const wh = Math.round(hi * hi * q)
          const r = (BAND_COLORS[0][0] * wl + BAND_COLORS[1][0] * wm + BAND_COLORS[2][0] * wh) / 20
          const g = (BAND_COLORS[0][1] * wl + BAND_COLORS[1][1] * wm + BAND_COLORS[2][1] * wh) / 20
          const b = (BAND_COLORS[0][2] * wl + BAND_COLORS[1][2] * wm + BAND_COLORS[2][2] * wh) / 20
          // What's still ahead is only slightly held back. At 0.5 the whole
          // right half read as dead space; the playhead already says where you
          // are, the colour doesn't have to shout it.
          style = `rgba(${r | 0},${g | 0},${b | 0},${x < w / 2 ? 1 : 0.82})`
        }
      } else {
        style = x < w / 2 ? c : c + 'd0'
      }

      if (style !== curStyle) {
        ctx.fillStyle = style
        curStyle = style
      }
      const top = mid + mn * mid * 0.96
      const bot = mid + mx * mid * 0.96
      ctx.fillRect(x, top, 1, Math.max(1, bot - top))
    }

    // centre spine
    ctx.fillStyle = 'rgba(255,255,255,0.14)'
    ctx.fillRect(0, mid - 0.5, w, 1)

    // beat grid — beat 0 sits at offsetSec, the detected/edited grid's own
    // phase, not necessarily track start (v0.3.0). Drawn AFTER the body: the
    // body paints an opaque column per pixel, so a grid drawn first (as it was
    // until 20/09, at 5%/16% alpha) was buried under it and effectively
    // invisible. Every 4th beat is the bar line Mix Assist must land on.
    if (bpm && bpm > 0) {
      const beatSec = 60 / bpm
      const halfSpanSec = w / 2 / PX_PER_SEC
      const firstBeat = Math.floor((positionSec - offsetSec - halfSpanSec) / beatSec)
      const lastBeat = Math.ceil((positionSec - offsetSec + halfSpanSec) / beatSec)
      for (let b = firstBeat; b <= lastBeat; b++) {
        const beatTimeSec = b * beatSec + offsetSec
        if (beatTimeSec < 0) continue
        const x = Math.round(w / 2 + (beatTimeSec - positionSec) * PX_PER_SEC)
        if (b % 4 === 0) {
          ctx.fillStyle = 'rgba(255,196,46,0.95)'
          ctx.fillRect(x - 1, 0, 3, h)
          ctx.beginPath()
          ctx.moveTo(x - 6, 0)
          ctx.lineTo(x + 6, 0)
          ctx.lineTo(x, 8)
          ctx.closePath()
          ctx.fill()
          ctx.beginPath()
          ctx.moveTo(x - 6, h)
          ctx.lineTo(x + 6, h)
          ctx.lineTo(x, h - 8)
          ctx.closePath()
          ctx.fill()
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.4)'
          ctx.fillRect(x, 0, 1, h)
        }
      }
    }

    // hot cue flags
    for (const cue of hotCues) {
      const x = w / 2 + (cue.positionSec - positionSec) * PX_PER_SEC
      if (x < -8 || x > w + 8) continue
      ctx.fillStyle = cue.color
      ctx.fillRect(x - 0.5, 0, 1.5, h)
      ctx.beginPath()
      ctx.roundRect(x - 0.5, 0, 14, 12, [0, 3, 3, 0])
      ctx.fill()
      ctx.fillStyle = '#000'
      ctx.font = '700 9px Inter Variable, sans-serif'
      ctx.fillText(cue.label.slice(0, 2), x + 2, 9)
    }

    // playhead + glow
    ctx.save()
    ctx.shadowColor = '#fff'
    ctx.shadowBlur = 8
    ctx.fillStyle = '#fff'
    ctx.fillRect(w / 2 - 1, 0, 2, h)
    ctx.restore()
    ctx.beginPath()
    ctx.moveTo(w / 2 - 4, 0)
    ctx.lineTo(w / 2 + 4, 0)
    ctx.lineTo(w / 2, 5)
    ctx.closePath()
    ctx.fillStyle = '#fff'
    ctx.fill()
  }, [peaks, bands, positionSec, durationSec, bpm, offsetSec, hotCues, color, loading, size, PX_PER_SEC, hiResCanvas, waveformColorByEq])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || durationSec === 0) return
    const rect = canvas.getBoundingClientRect()
    const dx = e.clientX - rect.left - rect.width / 2
    onSeek(Math.max(0, Math.min(durationSec, positionSec + dx / PX_PER_SEC)))
  }

  return (
    <div className="relative h-full min-h-[96px] flex-1 overflow-hidden rounded-[var(--radius-md)] shadow-[inset_0_0_0_1px_var(--color-hairline)]">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        className="absolute inset-0 h-full w-full cursor-crosshair"
        data-deck={deckId}
      />
      {!peaks && durationSec === 0 && !loading && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-grid-dim">
          Load a track to see its waveform
        </span>
      )}
      <HintIcon id="deck.waveform" className="absolute right-1 top-1" />
    </div>
  )
}
