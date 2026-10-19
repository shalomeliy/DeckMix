import * as ctl from '@/controls'
import { useStore } from '@/app/state/store'
import type { DeckId } from '@/core/types'

/**
 * v0.9.71: the "check the 1" bar, under the waveform of the deck the queue loaded the song onto. One row, so a deck that already fills the
 * screen does not grow by more than that while the queue runs. The yellow lines above are the computer's guess; the buttons are the answer.
 */
export function BarOneQueue({ deckId }: { deckId: DeckId }) {
  const q = useStore((s) => s.barOneQueue)
  if (!q || q.deckId !== deckId) return null
  const ready = q.phase === 'ready'
  const btn = 'rounded-[var(--radius-sm)] px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-2 py-1" data-testid="bar-one-queue">
      <span className="min-w-0 flex-1 truncate text-2xs text-grid-muted" title={q.name}>
        {ready ? (
          <>
            Is the yellow line on the <b className="text-grid-text">1</b>? <span className="text-grid-dim">{q.name}</span>
          </>
        ) : (
          'Loading the next song…'
        )}
      </span>
      <span className="tnum text-2xs text-grid-dim" title="Songs left in this run, checked and skipped so far">
        {q.remaining} left · {q.checked} checked · {q.skipped} skipped
      </span>
      <button type="button" disabled={!ready} onClick={() => void ctl.answerBarOne('yes')} className={`${btn} bg-accent text-grid-bg`} title='The yellow line is on the strong first beat of the bar. Saves it for this song and loads the next.'>
        This is the 1
      </button>
      <button type="button" disabled={!ready} onClick={() => void ctl.answerBarOne('here')} className={`${btn} bg-surface-3 text-grid-text`} title='Press when you hear the 1, while it plays. It does not have to be exact: the bar line moves to the nearest beat, so a press a little late still lands on the right one. Saves it and loads the next.'>
        The 1 is here
      </button>
      <button type="button" disabled={!ready} onClick={() => void ctl.answerBarOne('skip')} className={`${btn} bg-surface-2 text-grid-muted`} title="Leave this song unchecked. It comes back in the next run.">
        Skip
      </button>
      <button type="button" onClick={() => ctl.stopBarOneQueue()} className={`${btn} text-grid-dim hover:text-grid-text`} title="End this run. What you answered stays saved.">
        Stop
      </button>
    </div>
  )
}
