import { useEffect, useRef, useState } from 'react'
import { BEATS_PER_BAR } from '@/core/beatgrid'
import { BAND_COLORS, QUIET } from '@/app/components/waveform-colors'

interface Props {
  peaks: Float32Array
  bands: Float32Array | null
  durationSec: number
  bpm: number
  /** Where the "1" is marked. Every beat line is counted from it, so moving it moves the whole grid — as the saved correction will. */
  markSec: number | null
  /**
   * Where the beat lines fall while nothing is marked — the blind tie-break
   * (v0.12.8) shows every beat alike, with no yellow bar line: a yellow line
   * every fourth beat would be a guess at the "1" in all but name.
   */
  beatPhaseSec: number
  viewStartSec: number
  viewLenSec: number
  playheadSec: number | null
  /** A press or drag on the waveform, in track seconds — the screen snaps it to a beat. */
  onPick: (sec: number) => void
}

/**
 * The tagging screen's waveform (v0.9.1): a fixed window of the track, not
 * the deck's scrolling one. The deck's `Waveform` is wired to a deck —
 * dragging it scratches that deck — and nothing on a deck may move while
 * Shalom tags. Same colours and the same yellow bar line as the deck, so the
 * picture reads the way he already knows.
 */
export function TagWaveform({ peaks, bands, durationSec, bpm, markSec, beatPhaseSec, viewStartSec, viewLenSec, playheadSec, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState(0)
  const dragging = useRef(false)

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
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx || w === 0) return
    ctx.scale(dpr, dpr)
    ctx.fillStyle = '#090a0e'
    ctx.fillRect(0, 0, w, h)
    const mid = h / 2
    const pxPerSec = w / viewLenSec
    const xOf = (sec: number) => (sec - viewStartSec) * pxPerSec

    const buckets = peaks.length / 2
    const perSec = buckets / durationSec
    for (let x = 0; x < w; x++) {
      const from = Math.max(0, Math.floor((viewStartSec + x / pxPerSec) * perSec))
      const to = Math.min(buckets, Math.max(from + 1, Math.floor((viewStartSec + (x + 1) / pxPerSec) * perSec)))
      if (to <= from) continue
      let mn = 0
      let mx = 0
      let lo = 0
      let md = 0
      let hi = 0
      for (let b = from; b < to; b++) {
        if (peaks[b * 2] < mn) mn = peaks[b * 2]
        if (peaks[b * 2 + 1] > mx) mx = peaks[b * 2 + 1]
        if (bands) {
          lo += bands[b * 3]
          md += bands[b * 3 + 1]
          hi += bands[b * 3 + 2]
        }
      }
      // The deck's colour rule (Waveform.tsx), weights squared so the dominant band reads as its own colour.
      const total = lo + md + hi
      if (!bands) ctx.fillStyle = '#29c5ff'
      else if (total < QUIET) ctx.fillStyle = 'rgba(150,160,180,0.3)'
      else {
        const q = 1 / (lo * lo + md * md + hi * hi)
        const wl = lo * lo * q
        const wm = md * md * q
        const wh = hi * hi * q
        const r = BAND_COLORS[0][0] * wl + BAND_COLORS[1][0] * wm + BAND_COLORS[2][0] * wh
        const g = BAND_COLORS[0][1] * wl + BAND_COLORS[1][1] * wm + BAND_COLORS[2][1] * wh
        const b = BAND_COLORS[0][2] * wl + BAND_COLORS[1][2] * wm + BAND_COLORS[2][2] * wh
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`
      }
      const top = mid + mn * mid * 0.94
      const bot = mid + mx * mid * 0.94
      ctx.fillRect(x, top, 1, Math.max(1, bot - top))
    }

    // Beat lines after the body, which paints opaque columns (the 20/09 lesson in Waveform.tsx).
    const beatSec = 60 / bpm
    const anchor = markSec ?? beatPhaseSec
    const first = Math.ceil((viewStartSec - anchor) / beatSec)
    const last = Math.floor((viewStartSec + viewLenSec - anchor) / beatSec)
    for (let k = first; k <= last; k++) {
      const t = anchor + k * beatSec
      if (t < 0 || t > durationSec) continue
      const x = Math.round(xOf(t))
      if (markSec != null && k === 0) continue // the marker itself, drawn last and on top
      if (markSec != null && k % BEATS_PER_BAR === 0) {
        ctx.fillStyle = 'rgba(255,196,46,0.55)'
        ctx.fillRect(x - 1, 0, 2, h)
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillRect(x, 0, 1, h)
      }
    }

    const mx = markSec == null ? null : Math.round(xOf(markSec))
    if (mx != null) {
      ctx.fillStyle = 'rgb(255,196,46)'
      ctx.fillRect(mx - 1.5, 0, 3, h)
      ctx.beginPath()
      ctx.moveTo(mx - 8, 0)
      ctx.lineTo(mx + 8, 0)
      ctx.lineTo(mx, 10)
      ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(mx - 8, h)
      ctx.lineTo(mx + 8, h)
      ctx.lineTo(mx, h - 10)
      ctx.closePath()
      ctx.fill()
      ctx.font = 'bold 13px system-ui, sans-serif'
      ctx.fillText('1', mx + 6, 24)
    }

    if (playheadSec != null && playheadSec >= viewStartSec && playheadSec <= viewStartSec + viewLenSec) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.fillRect(Math.round(xOf(playheadSec)), 0, 2, h)
    }
  }, [peaks, bands, durationSec, bpm, markSec, beatPhaseSec, viewStartSec, viewLenSec, playheadSec, size])

  const secAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return viewStartSec + ((e.clientX - r.left) / r.width) * viewLenSec
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="tag-waveform"
      role="img"
      aria-label={
        markSec == null
          ? `Waveform, ${bpm.toFixed(1)} BPM, nothing marked yet. Click where the "1" is, or press an arrow key to place it; Space plays.`
          : `Waveform, the "1" marked at ${markSec.toFixed(2)} s, ${bpm.toFixed(1)} BPM. Arrow keys move it.`
      }
      className="block h-44 w-full cursor-pointer touch-none rounded-[var(--radius-md)] border border-hairline"
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        onPick(secAt(e))
      }}
      onPointerMove={(e) => {
        if (dragging.current) onPick(secAt(e))
      }}
      onPointerUp={() => {
        dragging.current = false
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    />
  )
}
