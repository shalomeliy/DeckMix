# DeckMix

*(Called SoundGrid until v0.8.19.)*

A browser-based DJ system — two-deck mixing that plays the music
already on your computer and is driven by a hardware controller such as the
**Pioneer DDJ-FLX4**.

Built from scratch on the open web platform (Web Audio, Web MIDI, File System
Access). It does **not** contain or copy any code, assets, or data from any
commercial DJ software or other commercial product.

## Features

- **Two decks** with independent transport, tempo fader (±8%), and scrolling
  waveform with beat grid
- **3-band EQ + filter/FX knob** per channel, equal-power crossfader, master and
  headphone-cue level
- **Performance pad grid** (8 hot cues per deck), auto beat-loop with halve/double
- **Local music library** — pick a folder once and browse/search everything in it;
  the folder handle is remembered between sessions
- **BPM detection** and a simple BPM `SYNC`
- **Hardware controller support via Web MIDI** — ships with a best-effort
  DDJ-FLX4 map plus a MIDI monitor and per-control Learn
- **4-channel audio routing** — when the output device exposes ≥4 channels
  (a controller's built-in interface in DJ mode), master goes to outputs 1/2 and
  headphone cue to 3/4; on a stereo device the cue is folded into the master

## Requirements

- **Chrome or Edge on desktop** — Web MIDI, File System Access, and per-device
  audio output (`setSinkId`) are Chromium-only today
- For the FLX4: install Pioneer's driver so Windows exposes its multi-channel
  USB audio device, then select it as the DeckMix output

## Develop

```bash
npm install
npm run dev
```

`npm run build` type-checks and produces a static bundle in `dist/`.
`npm run check` is the gate before a commit: `tsc -b` + `oxlint` +
`dependency-cruiser` (the layer rules) + `vitest run` (the repo invariants in
`tests/repo/`).

## Controller mapping

The FLX4 map lives in
[`src/platform/transport-webmidi/mappings/flx4.ts`](src/platform/transport-webmidi/mappings/flx4.ts).
Note/CC numbers follow Pioneer's published FLX4 layout but vary by firmware — use
the MIDI monitor in the top bar and the Learn action to correct any control.

## Keyboard (no controller)

| Key | Action |
| --- | --- |
| `Q` / `P` | play-pause deck A / B |
| `A` / `;` | cue deck A / B |
| `↑` / `↓` | move library selection |
| `[` / `]` | load selected track to deck A / B |
| `S` / `D` | pitch-bend deck A back / forward while held |
| `K` / `L` | pitch-bend deck B back / forward while held |

## Status

Early MVP. Working: decks, mixer, waveform, library, hot cues, loops, MIDI
mapping layer, output routing. Not yet: jog-wheel scratching, phase-accurate
sync, key detection, recording, saved cue points per track.
