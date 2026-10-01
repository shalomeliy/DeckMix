import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings } from '@/app/hooks/useSettings'
import { HintIcon } from '@/app/components/controls'
import * as ctl from '@/controls'
import { OVERVIEW_STRIDE, overviewColumns, overviewLoopBox, overviewSecAt } from '@/core/waveform-overview'
import { bandRgb } from '@/app/components/waveform-colors'
import type { DeckId, HotCue } from '@/core/types'

interface Props {
  deckId: DeckId
  peaks: Float32Array | null
  bands: Float32Array | null
  positionSec: number
  durationSec: number
  hotCues: HotCue[]
  /** the engine's loop, Loop Roll included (v0.12.10) — same source the scrolling waveform draws. */
  loopRange?: { startSec: number; endSec: number } | null
  color: string
}

/**
 * The whole track at a glance (v0.12.0), above the scrolling waveform — the
 * owner's choice of place. Click jumps, drag travels through the track.
 *
 * The canvas holds only what changes per track (the body and the cue flags),
 * so it is not redrawn while the deck plays; the played shade and the
 * playhead are plain elements over it. The scrolling waveform already redraws
 * every frame, and a second full redraw per deck is exactly the cost the
 * "two waveforms + overview at 60fps" bar in ROADMAP.md rules out.
 */
export function WaveformOverview({ deckId, peaks, bands, positionSec, durationSec, hotCues, loopRange = null, color }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const { hiResCanvas, waveformColorByEq } = useSettings()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => setWidth(canvas.clientWidth))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  const columns = useMemo(
    () => (peaks && width > 0 ? overviewColumns(peaks, bands, Math.round(width)) : null),
    [peaks, bands, width],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = hiResCanvas ? window.devicePixelRatio || 1 : 1
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
    if (!columns || durationSec === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.fillRect(0, mid - 0.5, w, 1)
      return
    }
    const deckColor = color.startsWith('var(')
      ? getComputedStyle(canvas).getPropertyValue(color.slice(4, -1)).trim() || '#29c5ff'
      : color
    const cols = columns.length / OVERVIEW_STRIDE
    let cur = ''
    for (let x = 0; x < cols; x++) {
      const o = x * OVERVIEW_STRIDE
      let style = deckColor
      if (bands && waveformColorByEq) {
        const rgb = bandRgb(columns[o + 2], columns[o + 3], columns[o + 4])
        style = rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : 'rgba(150,160,180,0.3)'
      }
      if (style !== cur) {
        ctx.fillStyle = style
        cur = style
      }
      const top = mid + columns[o] * mid * 0.95
      const bot = mid + columns[o + 1] * mid * 0.95
      ctx.fillRect(x, top, 1, Math.max(1, bot - top))
    }
    for (const cue of hotCues) {
      const x = Math.round((cue.positionSec / durationSec) * w)
      ctx.fillStyle = cue.color
      ctx.fillRect(x - 1, 0, 2, h)
      ctx.fillRect(x - 1, 0, 5, 4)
    }
  }, [columns, bands, durationSec, hotCues, color, width, hiResCanvas, waveformColorByEq])

  // `refused`: the SYNC lock said no at the press, and has already said why —
  // the rest of the gesture must not repeat the notice on every move.
  const drag = useRef<{ pointerId: number; refused: boolean } | null>(null)
  const seekTo = (clientX: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    ctl.seekDeckByHand(deckId, overviewSecAt(clientX - rect.left, rect.width, durationSec))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (durationSec === 0 || e.button !== 0 || drag.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const refused = !ctl.waveformMouseAllowed(deckId)
    drag.current = { pointerId: e.pointerId, refused }
    if (!refused) seekTo(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d || d.refused || e.pointerId !== d.pointerId) return
    // Asked again on every move, not only at the press: SYNC or an automatic
    // mix can start mid-drag (FLX4 button, a transition), and without this
    // `seekDeckByHand` would refuse — and repeat its notice — on every move.
    if (!ctl.waveformMouseAllowed(deckId)) {
      d.refused = true
      return
    }
    seekTo(e.clientX)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null
  }

  // An element over the canvas, like the played shade: a loop change must not redraw the body.
  const loopBox = overviewLoopBox(loopRange, durationSec)
  const pct = durationSec > 0 ? Math.max(0, Math.min(100, (positionSec / durationSec) * 100)) : 0

  // The hint sits beside the strip, not on it: on it, it covered the last
  // seconds of the track — the end could not be clicked and a cue there was hidden.
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="relative h-5 flex-1 rounded-[var(--radius-sm)] shadow-[inset_0_0_0_1px_var(--color-hairline)]">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
          aria-label={`Deck ${deckId} whole-track overview — click to jump`}
          className="absolute inset-0 h-full w-full cursor-pointer touch-none rounded-[var(--radius-sm)]"
          data-overview={deckId}
        />
        {durationSec > 0 && peaks && (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 bg-black/50" style={{ width: `${pct}%` }} />
            {loopBox && (
              <div
                data-overview-loop={deckId}
                className="pointer-events-none absolute inset-y-0 bg-[rgba(80,255,150,0.3)] shadow-[inset_0_0_0_1px_rgba(80,255,150,0.95)]"
                style={{ left: `${loopBox.leftPct}%`, width: `${loopBox.widthPct}%` }}
              />
            )}
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_4px_#fff]"
              style={{ left: `${pct}%` }}
            />
          </>
        )}
      </div>
      <HintIcon id="deck.overview" />
    </div>
  )
}
