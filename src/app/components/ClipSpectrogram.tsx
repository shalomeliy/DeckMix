import { useEffect, useRef } from 'react'
import { SPEC_MAX_HZ, SPEC_MIN_HZ, type Spectrogram } from '@/core/sound/spectrogram'

/**
 * Brightness → colour: one hue, dark blue to pale yellow. The information is in the LIGHTNESS, so it reads the same with any
 * colour vision, and it deliberately avoids the deck waveform's red/green/blue code — green there means "mid frequencies",
 * and a second screen that coloured something green would teach the wrong thing about what a voice looks like.
 */
const RAMP = [
  [8, 10, 28],
  [28, 40, 120],
  [40, 110, 170],
  [90, 180, 160],
  [220, 230, 130],
  [255, 252, 220],
] as const
function ramp(v: number): [number, number, number] {
  const t = (v / 255) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(t))
  const f = t - i
  return [0, 1, 2].map((k) => Math.round(RAMP[i][k] * (1 - f) + RAMP[i + 1][k] * f)) as [number, number, number]
}

const TICKS_HZ = [200, 1000, 4000]
const H = 150

/** `spec === null` is "no picture could be made" (named above it by the caller's notice); the clip itself still plays and can be answered. */
export function ClipSpectrogram({ spec }: { spec: Spectrogram | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv || !spec || spec.state !== 'ok') return
    cv.width = spec.cols
    cv.height = spec.rows
    const g = cv.getContext('2d')
    if (!g) return
    const img = g.createImageData(spec.cols, spec.rows)
    for (let c = 0; c < spec.cols; c++) {
      for (let r = 0; r < spec.rows; r++) {
        const [R, G, B] = ramp(spec.data[c * spec.rows + r])
        // Lowest pitch at the bottom: a canvas row 0 is the top.
        const o = ((spec.rows - 1 - r) * spec.cols + c) * 4
        img.data[o] = R
        img.data[o + 1] = G
        img.data[o + 2] = B
        img.data[o + 3] = 255
      }
    }
    g.putImageData(img, 0, 0)
  }, [spec])

  const note =
    spec == null
      ? 'התמונה לא נטענה — אפשר להחליט לפי השמיעה.'
      : spec.state === 'silent'
        ? 'הקטע שקט.'
        : spec.state === 'too-short'
          ? 'הקטע קצר מדי לתמונה.'
          : null
  const rowTop = (hz: number) => {
    // Same log mapping as the rows, so a tick sits where its pitch is drawn.
    const t = Math.log(hz / SPEC_MIN_HZ) / Math.log(SPEC_MAX_HZ / SPEC_MIN_HZ)
    return (1 - t) * 100
  }

  return (
    <div dir="ltr" className="space-y-1">
      <div className="relative w-full overflow-hidden rounded border border-hairline bg-surface-1" style={{ height: H }}>
        {note == null ? (
          <>
            <canvas
              ref={ref}
              role="img"
              aria-label="תמונת תדרים של 5 השניות: זמן לרוחב, גובה הצליל לגובה"
              className="absolute inset-0 h-full w-full"
              style={{ imageRendering: 'auto' }}
            />
            {TICKS_HZ.map((hz) => (
              <div key={hz} className="pointer-events-none absolute left-0 right-0 border-t border-white/15" style={{ top: `${rowTop(hz)}%` }}>
                <span className="absolute left-1 -translate-y-full text-2xs text-white/70">{hz >= 1000 ? `${hz / 1000}k` : hz} Hz</span>
              </div>
            ))}
          </>
        ) : (
          <div dir="rtl" className="flex h-full items-center justify-center px-2 text-center text-xs text-warn">{note}</div>
        )}
      </div>
      <div className="flex justify-between text-2xs text-grid-muted">
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <span key={s}>{s}s</span>
        ))}
      </div>
    </div>
  )
}
