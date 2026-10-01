import { useEffect, useRef, useState } from 'react'
import { useSettings } from '@/app/hooks/useSettings'
import { HintIcon } from '@/app/components/controls'
import * as ctl from '@/controls'
import { waveformDragRate, wheelSteps } from '@/core/scratch'
import { BEATS_PER_BAR } from '@/core/beatgrid'
import { BAND_COLORS, QUIET } from '@/app/components/waveform-colors'
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
  /** v0.9.5: the bar line's "1" is the detector's unsure guess — bar lines are drawn dashed. */
  barUnsure?: boolean
  hotCues: HotCue[]
  color: string
  loading?: boolean
  onSeek: (sec: number) => void
}



/**
 * Travel before a press on the waveform becomes a drag (v0.8.28). Below it the
 * press is still the click-to-jump it always was; a hand is never perfectly
 * still, and without this every click would start a tiny scratch instead.
 */
const DRAG_THRESHOLD_PX = 4

/** Same as the platter's: a hand that stops moving holds the record still. */
const HOLD_TIMEOUT_MS = 60

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
  barUnsure = false,
  hotCues,
  color,
  loading = false,
  onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState(0)
  // Zoom, pixel density and band colouring are the user's from v0.2.5. The
  // default is WAVEFORM_PX_PER_SEC in core/constants.ts.
  const { waveformPxPerSec: PX_PER_SEC, hiResCanvas, waveformColorByEq, jogSmoothing } = useSettings()

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
        if (b % BEATS_PER_BAR === 0) {
          ctx.fillStyle = 'rgba(255,196,46,0.95)'
          if (barUnsure) for (let y = 10; y < h - 10; y += 10) ctx.fillRect(x - 1, y, 3, 5)
          else ctx.fillRect(x - 1, 0, 3, h)
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
  }, [peaks, bands, positionSec, durationSec, bpm, offsetSec, barUnsure, hotCues, color, loading, size, PX_PER_SEC, hiResCanvas, waveformColorByEq])

  const seekToPointer = (clientX: number) => {
    const canvas = canvasRef.current
    if (!canvas || durationSec === 0) return
    const rect = canvas.getBoundingClientRect()
    const dx = clientX - rect.left - rect.width / 2
    onSeek(Math.max(0, Math.min(durationSec, positionSec + dx / PX_PER_SEC)))
  }

  // Drag = a hand on the record (v0.8.28, the owner's choice): it goes through
  // the same beginScratch/scratchRate/endScratch as the platter and the FLX4
  // jog, so the three can never drift apart. `refused` remembers a drag the
  // SYNC setting blocked, so its release does not turn into a click-jump.
  const drag = useRef<{
    pointerId: number
    startX: number
    x: number
    time: number
    rate: number
    scratching: boolean
    refused: boolean
  } | null>(null)
  const holdTimer = useRef(0)
  const stopHoldTimer = () => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = 0
    }
  }
  useEffect(() => stopHoldTimer, [])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // One hand at a time: a second finger on a touchscreen used to replace the
    // drag in progress, so the first finger's release found nothing and the
    // deck was left scratching with no hand on it.
    if (durationSec === 0 || e.button !== 0 || drag.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { pointerId: e.pointerId, startX: e.clientX, x: e.clientX, time: performance.now(), rate: 0, scratching: false, refused: false }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || d.refused || e.pointerId !== d.pointerId) return
    if (!d.scratching) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return
      if (!ctl.waveformMouseAllowed(deckId)) {
        d.refused = true
        return
      }
      ctl.beginScratch(deckId)
      d.scratching = true
      // No return, and the anchor stays at the press: the travel that crossed
      // the threshold is part of the drag, and dropping it would leave the
      // audio lagging the hand by DRAG_THRESHOLD_PX for the whole gesture.
    }
    const now = performance.now()
    const dt = (now - d.time) / 1000
    if (dt <= 0) return
    d.rate = waveformDragRate(e.clientX - d.x, dt, PX_PER_SEC, d.rate, jogSmoothing)
    d.x = e.clientX
    d.time = now
    ctl.scratchRate(deckId, d.rate)
    stopHoldTimer()
    holdTimer.current = window.setTimeout(() => {
      if (!drag.current?.scratching) return
      drag.current.rate = 0
      ctl.scratchRate(deckId, 0)
    }, HOLD_TIMEOUT_MS)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    stopHoldTimer()
    if (d.scratching) ctl.endScratch(deckId)
    else if (!d.refused && e.type === 'pointerup') seekToPointer(e.clientX)
  }

  // Wheel: a quarter beat per notch, a whole beat with Shift. Attached by hand
  // because React registers wheel listeners as passive, and a passive listener
  // cannot preventDefault — the page would scroll under the waveform while the
  // track moved, which is the exact thing the owner asked to avoid.
  const wheelCarry = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      // An empty deck lets the page scroll as usual — swallowing the wheel there
      // would do nothing and say nothing.
      if (!ctl.deckHasTrack(deckId)) return
      e.preventDefault()
      // Chromium on Windows turns Shift+wheel into a horizontal scroll: deltaY
      // arrives as 0 and the notch is in deltaX. Reading only deltaY made the
      // Shift (whole-beat) step silently do nothing. Only with Shift, though: a
      // plain sideways touchpad swipe is not a gesture anything names.
      const delta = e.shiftKey && e.deltaY === 0 ? e.deltaX : e.deltaY
      const r = wheelSteps(wheelCarry.current, delta, e.deltaMode)
      wheelCarry.current = r.carryPx
      if (r.steps !== 0) ctl.nudgeDeckByBeats(deckId, r.steps * (e.shiftKey ? 1 : 0.25))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [deckId])

  return (
    <div className="relative h-full min-h-[96px] flex-1 overflow-hidden rounded-[var(--radius-md)] shadow-[inset_0_0_0_1px_var(--color-hairline)]">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
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
