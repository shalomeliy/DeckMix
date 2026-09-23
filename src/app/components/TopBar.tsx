import { useEffect, useState } from 'react'
import { engine } from '@/platform/audio-webaudio/engine'
import * as ctl from '@/controls'
import { initAudio, toggleAiControl, toggleQuantize } from '@/controls'
import { midi } from '@/platform/transport-webmidi/manager'
import { settings } from '@/platform/settings-idb/store'
import { useStore } from '@/app/state/store'
import { Button, HintIcon, Pill, type PillTone } from '@/app/components/controls'

export function TopBar({
  onOpenSettings,
  onOpenLegal,
  onOpenHistory,
}: {
  onOpenSettings: () => void
  onOpenLegal: () => void
  onOpenHistory: () => void
}) {
  const audioReady = useStore((s) => s.audioReady)
  const historyCount = useStore((s) => s.history.length)
  const quantize = useStore((s) => s.quantize)
  const output = useStore((s) => s.output)
  const midiState = useStore((s) => s.midi)
  const scratchReady = useStore((s) => s.scratchReady)
  const scratchError = useStore((s) => s.scratchError)
  const aiEnabled = useStore((s) => s.ai.enabled)
  const setOutput = useStore((s) => s.setOutput)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setOutput({ sinkSupported: typeof engine.ctx.setSinkId === 'function' })
  }, [setOutput])

  async function start() {
    setBusy(true)
    await initAudio()
    const outs = await engine.listOutputs()
    setOutput({
      devices: outs.map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Output ${d.deviceId.slice(0, 6)}`,
      })),
      multichannel: engine.isMultichannel,
    })
    await midi.init()

    // A remembered device that is never re-applied is a setting that pretends
    // to work. Applied when the card is still here; named when it is not,
    // because "the mix is coming out of the laptop speakers" is exactly the
    // kind of silent fallback this project treats as a bug.
    const wanted = settings.values.outputDeviceId
    if (wanted) {
      if (outs.some((d) => d.deviceId === wanted)) {
        const res = await engine.setOutputDevice(wanted)
        if (res === 'ok') setOutput({ currentId: wanted, multichannel: engine.isMultichannel })
      } else {
        useStore.getState().setNotice({
          text: 'The audio device you last used is not connected — using the system default.',
          tone: 'warn',
          source: 'output',
        })
      }
    }
    setBusy(false)
  }

  async function pickOutput(deviceId: string) {
    setBusy(true)
    const res = await engine.setOutputDevice(deviceId)
    if (res === 'ok') {
      setOutput({ currentId: deviceId, multichannel: engine.isMultichannel })
      // Remembered from v0.2.5 on. Device ids are stable per browser profile,
      // so this survives a reload; a card that is gone next time simply is not
      // in the list, and the app stays on the system default.
      void settings.set('outputDeviceId', deviceId || null)
    } else if (res === 'unsupported') {
      alert(
        'This browser cannot route audio to a specific device (setSinkId). ' +
          'Set the DDJ-FLX4 as your system default output instead.',
      )
    }
    setBusy(false)
  }

  return (
    <header className="flex items-center gap-4 border-b border-hairline bg-surface-1 px-4 py-2.5">
      <h1 className="text-sm font-bold tracking-tight">
        Deck<span className="text-accent">Mix</span>
      </h1>

      {!audioReady ? (
        <span className="relative inline-flex">
          <Button variant="toggle" active tone="var(--color-accent)" onClick={start} disabled={busy}>
            {busy ? 'Starting…' : 'Start audio engine'}
          </Button>
          <HintIcon id="topbar.startEngine" className="absolute -right-1.5 -top-1.5" />
        </span>
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs text-grid-muted">
            <span className="label">Out</span>
            <select
              value={output.currentId ?? ''}
              onChange={(e) => pickOutput(e.target.value)}
              disabled={!output.sinkSupported || busy}
              className="rounded-[var(--radius-sm)] border border-hairline bg-surface-2 px-2 py-1 text-xs text-grid-text outline-none transition-colors hover:bg-surface-3 focus-visible:[--tw-outline-style:solid] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50"
            >
              <option value="">System default</option>
              {output.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            <span className="relative h-0 w-0">
              <HintIcon id="topbar.output" className="absolute left-1 top-1/2 -translate-y-1/2" />
            </span>
          </label>
          <Pill
            tone={output.multichannel ? 'live' : 'warn'}
            label={output.multichannel ? '4-ch · master + cue split' : 'stereo · cue folded in'}
          />
          {/* Silence here would be the bug. Without the worklet the decks still
              play, but the read pointer cannot reverse or hold, so scratching
              is gone — and a jog that quietly turns into a seek looks like a
              working feature that just feels wrong. Name it, and say why. */}
          {!scratchReady && (
            <Pill tone="warn" label={`no scratch · ${scratchError ?? 'AudioWorklet unavailable'}`} />
          )}
          {/* Off by default (v0.3.0 decision) — CUE/hot cues/loops stay exactly
              as precise as before until the user opts in. */}
          <span className="relative inline-flex">
            <Button variant="toggle" active={quantize} tone="var(--color-accent)" onClick={toggleQuantize}>
              Quantize
            </Button>
            <HintIcon id="topbar.quantize" className="absolute -right-1.5 -top-1.5" />
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-3">
        {audioReady && <RecordingBadge />}
        <MidiBadge />
        {midiState.lastMessage && (
          <span className="tnum hidden max-w-[14rem] truncate text-2xs text-grid-dim sm:inline">
            {midiState.lastMessage}
          </span>
        )}
        {/* Deliberately next to the raw MIDI line: together they answer "did it
            arrive" and "what did it do", which is the pair you need when a
            control appears dead. */}
        {midiState.lastJog && (
          <span
            className={`tnum hidden max-w-[16rem] truncate text-2xs sm:inline ${
              midiState.lastJog.includes('ignored') ? 'text-warn' : 'text-live'
            }`}
          >
            {midiState.lastJog}
          </span>
        )}
        {midiState.status === 'idle' && audioReady && (
          <span className="relative inline-flex">
            <Button variant="ghost" size="sm" onClick={() => midi.init()}>
              Connect MIDI
            </Button>
            <HintIcon id="topbar.connectMidi" className="absolute -right-1.5 -top-1.5" />
          </span>
        )}
        <span className="relative inline-flex">
          <Button variant="toggle" size="sm" active={aiEnabled} onClick={() => toggleAiControl(!aiEnabled)}>
            AI
          </Button>
          <HintIcon id="topbar.ai" className="absolute -right-1.5 -top-1.5" />
        </span>
        {/* v0.8.3: only shown once there's something to show — same principle
            as `anyPlaying && ...` in Library.tsx, no permanently-dead button
            before the first track loads this session. */}
        {historyCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onOpenHistory}>
            History ({historyCount})
          </Button>
        )}
        <span className="relative inline-flex">
          <Button variant="ghost" size="sm" onClick={onOpenSettings}>
            Settings
          </Button>
          <HintIcon id="topbar.settings" className="absolute -right-1.5 -top-1.5" />
        </span>
        {/* v0.8.7: shown on every screen, not buried in a tab nobody opens
            until something goes wrong (product-expert) — a `button`, not a
            link, since it opens the tab in-app rather than navigating. */}
        <button
          onClick={onOpenLegal}
          className="whitespace-nowrap text-2xs text-grid-dim underline decoration-dotted underline-offset-2 transition-colors hover:text-grid-muted"
        >
          Not affiliated with Pioneer DJ/Serato · Privacy
        </button>
      </div>
    </header>
  )
}

/**
 * Master recording status + controls (v0.7.5). Three states, mutually
 * exclusive: idle (just a "Record" button), actively recording (a live
 * time/size Pill + a track-boundary marker + Stop), or unsaved (a `warn`
 * Pill with NO timeout — the spec's explicit "canceling the save dialog
 * must never silently discard a recording" — plus Save/Discard). Mouse
 * only for this version, same as the sampler's own recording (v0.7.5) and
 * the FX controls (v0.7.0) before any FLX4 binding existed for them.
 */
function RecordingBadge() {
  const recording = useStore((s) => s.recording)
  const [elapsedSec, setElapsedSec] = useState(0)
  // Guards against Save and Discard firing in the same window — Discard
  // clears the in-memory buffer synchronously, but Save has already
  // snapshotted it before its own `await`, so an in-flight Save can still
  // land and report "saved" right after the user clicked Discard. Found in
  // change-review, not from a live report.
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // This effect's whole job is synchronizing with an external clock —
    // oxlint's set-state-in-effect warning is the generic "derive it during
    // render instead" advice, but the earlier version that did exactly that
    // (read Date.now() during render) is the impure-render pattern this
    // replaced; there is no render-time value to derive this from instead.
    if (recording.active !== 'master' || recording.startedAt == null) {
      setElapsedSec(0)
      return
    }
    // `Date.now()` is read here, inside the effect (synchronizing with the
    // external wall clock — exactly what an effect is for), never during
    // render. An earlier version called it at render time instead, which
    // oxlint correctly flags as an impure render; this version also fixes
    // the actual bug that version had — a `now` captured once at mount and
    // never resynced, which read as *before* `startedAt` on the very first
    // render ("-1:-1" instead of "0:00", found in the browser-verification
    // script). Setting it immediately here, not just on the first interval
    // tick 500ms later, is what closes that gap.
    const startedAt = recording.startedAt
    const update = () => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    update()
    const id = window.setInterval(update, 500)
    return () => window.clearInterval(id)
  }, [recording.active, recording.startedAt])
  const mm = Math.floor(elapsedSec / 60)
  const ss = (elapsedSec % 60).toString().padStart(2, '0')
  const mb = (recording.bytesRecorded / (1024 * 1024)).toFixed(1)

  if (recording.active === 'master') {
    return (
      <>
        <Pill tone="live" label={`Rec master · ${mm}:${ss} · ${mb}MB`} />
        <span className="relative inline-flex">
          <Button variant="ghost" size="sm" onClick={() => ctl.markRecordingTrackBoundary()}>
            Mark track
          </Button>
          <HintIcon id="topbar.recordMasterMark" className="absolute -right-1.5 -top-1.5" />
        </span>
        <Button variant="toggle" size="sm" active tone="var(--color-danger)" onClick={() => void ctl.stopRecordMaster()}>
          Stop
        </Button>
      </>
    )
  }

  if (recording.savedState === 'unsaved') {
    return (
      <>
        <Pill tone="warn" label={`Not saved — save or discard · ${mm}:${ss}`} />
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            try {
              await ctl.saveRecordedMaster()
            } finally {
              setSaving(false)
            }
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => ctl.discardRecordedMaster()}>
          Discard
        </Button>
      </>
    )
  }

  return (
    <span className="relative inline-flex">
      <Button variant="ghost" size="sm" onClick={() => void ctl.startRecordMaster()}>
        Record master
      </Button>
      <HintIcon id="topbar.recordMaster" className="absolute -right-1.5 -top-1.5" />
    </span>
  )
}

function MidiBadge() {
  const { status, devices } = useStore((s) => s.midi)
  const map: Record<string, [PillTone, string]> = {
    unsupported: ['danger', 'MIDI unsupported'],
    idle: ['idle', 'MIDI idle'],
    requesting: ['warn', 'MIDI connecting…'],
    denied: ['danger', 'MIDI denied'],
    ready: ['live', devices.length ? devices[0].name : 'MIDI ready · no device'],
  }
  const [tone, label] = map[status] ?? map.idle
  return <Pill tone={tone} label={label} />
}
