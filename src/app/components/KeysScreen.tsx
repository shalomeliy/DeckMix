import { useEffect } from 'react'
import { gestureTable, type GesturePlace } from '@/core/hints'
import { Button } from '@/app/components/controls'

/**
 * Every hidden gesture in the app on one screen (v0.8.24), by where it works,
 * with its mouse, keyboard and FLX4 way side by side. The rows come from
 * `core/hints.ts`'s single gesture table — the same one Hint mode prints — so
 * this screen can't list something the app no longer does. Opened from the
 * top bar's "Keys" button, not a "?" key: "?" needs Shift, which already
 * means something on the pads.
 */
export function KeysScreen({ onClose }: { onClose: () => void }) {
  const rows = gestureTable()
  const places = [...new Set(rows.map((r) => r.place))] as GesturePlace[]

  // Esc closes — same reasoning as SettingsScreen/SetHistoryScreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cell = (v: string | null) => (v ? v : <span className="text-grid-dim">—</span>)

  return (
    <div role="dialog" aria-modal="true" aria-label="Keys and gestures" className="absolute inset-0 z-40 flex flex-col bg-surface-0/97 backdrop-blur-sm">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2.5">
        <h2 className="text-sm font-bold tracking-tight">Keys and gestures</h2>
        <span className="text-2xs text-grid-dim">everything that works without a button of its own</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-2xs text-grid-dim">Esc to close</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {places.map((place) => (
          <section key={place} className="mb-3">
            <h3 className="label mb-1">{place}</h3>
            <table className="w-full table-fixed text-xs">
              <thead>
                <tr className="text-left text-2xs text-grid-muted">
                  <th className="w-[28%] py-1 pr-3 font-medium">What it does</th>
                  <th className="w-[26%] py-1 pr-3 font-medium">Mouse</th>
                  <th className="w-[22%] py-1 pr-3 font-medium">Keyboard</th>
                  <th className="w-[24%] py-1 font-medium">FLX4</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.place === place)
                  .map((r, i) => (
                    <tr key={i} className="border-t border-hairline/50 align-top">
                      <td className="py-1 pr-3">{r.does}</td>
                      <td className="py-1 pr-3 text-grid-muted">{cell(r.mouse)}</td>
                      <td className="py-1 pr-3 text-grid-muted">{cell(r.key)}</td>
                      <td className="py-1 text-grid-muted">{cell(r.flx4)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  )
}
