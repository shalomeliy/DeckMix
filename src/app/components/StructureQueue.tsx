import * as ctl from '@/controls'
import { useStore } from '@/app/state/store'
import { STRUCTURE_TARGET } from '@/core/song-structure'
import type { DeckId } from '@/core/types'

/**
 * v0.9.40: the "mark intro/outro" bar, under the waveform of the deck the queue loaded the song onto. One row, like the "1" check. It
 * asks one question at a time, intro first, then outro; the computer's guess is never on it (see `core/song-structure.ts`).
 */
export function StructureQueue({ deckId }: { deckId: DeckId }) {
  const q = useStore((s) => s.structureQueue)
  if (!q || q.deckId !== deckId) return null
  const ready = q.phase !== 'loading'
  const intro = q.phase === 'intro'
  const btn = 'rounded-[var(--radius-sm)] px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border border-hairline bg-surface-1 px-2 py-1" data-testid="structure-queue">
      <span className="min-w-0 flex-1 truncate text-2xs text-grid-muted" title={q.name}>
        {!ready ? (
          'Loading the next song…'
        ) : intro ? (
          <>
            1/2: where does the <b className="text-grid-text">full beat</b> come in? <span className="text-grid-dim">{q.name}</span>
          </>
        ) : (
          <>
            2/2: where does the <b className="text-grid-text">full beat</b> end? <span className="text-grid-dim">{q.name}</span>
          </>
        )}
      </span>
      <span className="tnum text-2xs text-grid-dim" title={`${q.marked} songs marked in all (${STRUCTURE_TARGET} are needed for the check), ${q.skipped} skipped this run, ${q.remaining} left in this run`}>
        {q.marked}/{STRUCTURE_TARGET} · {q.remaining} left
      </span>
      <button type="button" disabled={!ready} onClick={() => ctl.jumpStructureBars(-8)} className={`${btn} bg-surface-2 text-grid-muted`} title="Back 8 bars, to hear the change again.">
        −8
      </button>
      <button type="button" disabled={!ready} onClick={() => ctl.jumpStructureBars(8)} className={`${btn} bg-surface-2 text-grid-muted`} title="Forward 8 bars, to get through a long stretch faster.">
        +8
      </button>
      <button type="button" disabled={!ready} onClick={() => void ctl.answerStructure('here')} className={`${btn} bg-accent text-grid-bg`} title={intro ? 'Press at the moment the full beat with the bass comes in. It moves to the nearest bar line, so a press a little late is fine.' : 'Press at the moment the full beat ends and the song thins out for the end. It moves to the nearest bar line. Saves the song and loads the next.'}>
        {intro ? 'Intro ends here' : 'Outro starts here'}
      </button>
      <button type="button" disabled={!ready} onClick={() => void ctl.answerStructure('none')} className={`${btn} bg-surface-3 text-grid-text`} title={intro ? 'The full beat is there from the first bar.' : 'The full beat runs to the very end. Saves the song and loads the next.'}>
        {intro ? 'No intro' : 'No outro'}
      </button>
      <button type="button" disabled={!ready} onClick={() => void ctl.answerStructure('skip')} className={`${btn} bg-surface-2 text-grid-muted`} title="Leave this song unmarked. It comes back in the next run.">
        Skip
      </button>
      <button type="button" onClick={() => void ctl.exportStructureMarks()} className={`${btn} text-grid-dim hover:text-grid-text`} title="Save all your intro/outro marks as a file (deckmix-structure-marks-DATE.json) to send.">
        Export
      </button>
      <button type="button" onClick={() => ctl.stopStructureQueue()} className={`${btn} text-grid-dim hover:text-grid-text`} title="End this run. Songs already marked stay saved.">
        Stop
      </button>
    </div>
  )
}
