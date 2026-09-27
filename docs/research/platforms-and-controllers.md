# Platforms and controllers — research for "every browser, every OS, every controller"

Date: 2026-09-24. Scope: research only — no code, no ROADMAP change. Written against
DeckMix `v0.8.21` (`main` @ `92b28e6`).

Conventions in this file:

- Every claim about a browser, framework, license or device carries a source URL.
- **UNVERIFIED** marks anything I could not confirm from a primary source in this
  session (often: sourced from memory, a retailer, or a third-party summary). Treat
  it as a lead, not a fact.
- "Chromium" below means desktop Chrome, Edge, Opera, Brave, Arc and Comet unless a
  row says otherwise. Comet and Arc are Chromium-based
  ([Perplexity help](https://www.perplexity.ai/help-center/comet/en/articles/11583798-what-is-comet-s-browser-engine),
  [Arc on Wikipedia](https://en.wikipedia.org/wiki/Arc_(web_browser)) — Arc is in
  maintenance-only mode since 2025).
- Nothing here is legal advice. Section E lists questions for a lawyer, not answers.

---

## TL;DR

1. **"Works in every browser" can honestly mean: it plays, mixes and scratches with
   mouse/keyboard/touch everywhere; controllers, folder memory and headphone cue work
   only where the platform allows.** Safari (macOS, iPadOS, and every iOS browser) has
   no Web MIDI, no WebHID, no File System Access and no `AudioContext.setSinkId` —
   and WebKit has publicly declined most of these. Firefox has Web MIDI (behind a
   one-time "site permission add-on" install), no File System Access, no
   `AudioContext.setSinkId`, no WebHID. Only Chromium desktop gives the full product.
2. **Desktop: ship v1.0 on Electron, not Tauri — or on Tauri only once its CEF
   (Chromium) runtime is official.** The deciding fact: Tauri uses the OS webview, and
   on macOS (WKWebView) and Linux (WebKitGTK) that webview has no Web MIDI, no
   output-device selection and (Linux) depends on host GStreamer plugins even to
   decode MP3/AAC. So Tauri on 2 of 3 OSes means rewriting the audio engine in Rust
   (cpal) before the first release. Electron bundles the same Chromium the web tier
   already targets, so **one codebase gives three full desktop products** with near-zero
   new platform code. A native Rust/C++ audio path (ASIO, lower latency) stays a
   post-1.0 swap behind the existing `AudioBackend` port.
3. **Controllers: the market is ~80% class-compliant USB-MIDI** (AlphaTheta/Pioneer
   DDJ, Hercules, Numark, Reloop, Roland, Rane, Denon MC). The **Kontrol line is HID** (plus a MIDI mode on some newer units). Standalone units
   (Denon SC Live / Prime, Rane Performer) expose a "computer mode" whose openness is
   UNVERIFIED. The way to "support everything" is not hand-code per model: it is a
   **declarative controller profile in `core/`** (inputs incl. 14-bit and relative
   encoders, LED outputs, init/keep-alive messages, audio channel map), a smarter
   **Learn wizard** to author them, and **recorded traces** to test them without the
   hardware.
4. **Two license tripwires found in the current plan:** `ROADMAP.md` (post-1.0) plans
   vendoring **Ableton Link, which is GPLv2+ or a separate proprietary license from
   Ableton** — a sold proprietary DeckMix needs the proprietary one. And **ASIO** (via
   cpal's `asio` feature) is GPLv3 *or* Steinberg's proprietary agreement — again only
   the latter fits. Neither blocks v1.0 if v1.0 is Electron without ASIO.

### Proposed phased plan

Version numbers are suggestions only; the owner decides order in `ROADMAP.md`.

| Phase | What | Why this order |
| --- | --- | --- |
| **W1 — honest web tier** (next few sub-versions) | A visible "what works in this browser" panel driven by the existing `detectCapabilities()`; a library fallback (`<input webkitdirectory>` + drag-and-drop folder) for Firefox/Safari/Android; Firefox Web MIDI add-on flow explained on screen; cue folds to stereo with a named notice where no `setSinkId`/4-ch. | Cheap, uses ports that already exist, and is the "never skip silently" rule applied to browsers. |
| **W2 — tablets** | iPad (Safari) and Android Chrome layout pass: touch decks, no controller on iPad, USB-MIDI controller on Android Chrome. | Different screen and input model; do after W1 so the capability plumbing exists. |
| **C1 — profile format + Learn wizard + trace tests** (fits the planned `v0.11.0` "mapping editor + LED feedback") | Replace the hard-coded FLX4 map with the declarative profile; add 14-bit, SysEx (opt-in), LED output, init/keep-alive; Learn wizard auto-detects control type; vitest replays recorded traces. | Every later controller is data, not code, only after this. |
| **C2 — AlphaTheta + Hercules wave** | FLX2, FLX6, FLX10, REV1, REV5, REV7, GRV6, DDJ-400, SB3, DDJ-200; Hercules Inpulse 200/300/500/T7, Starlight, DJControl Mix. | Both vendors **publish official MIDI message lists** — lowest risk, largest share. |
| **C3 — inMusic/Reloop/Roland wave** | Numark Mixtrack Platinum FX / Pro FX, Party Mix MKII/III, NS4FX, Mixstream (computer mode); Reloop Mixon/Mixtour/Buddy/Ready; Roland DJ-202/505/707M; Denon MC7000. | MIDI, but mostly **no official message list** → needs community traces. |
| **D1 — desktop v1.0 (Electron)** | Windows, macOS, Linux from one repo. Native folder access and MIDI/HID through the same ports; signed + notarized installers; auto-update. | Everything the web tier has, plus no browser prompts, plus Safari users get a real app. |
| **C4 — HID wave** | Kontrol S2/S3/S4 MK3, Z1, X1, MX2 via WebHID (Chromium) and node-hid/hidapi (desktop). | Needs the profile format's HID field decoder; highest per-model effort. |
| **C5 — standalone + motorized** | Rane One/Four/Performer, Denon SC Live 2/4, Prime GO+/Prime 4 computer mode. | Protocol openness UNVERIFIED; motorized platters need a feedback loop. Research first. |
| **D2 — native audio (post-1.0, optional)** | Rust (cpal) or C++ audio engine behind `AudioBackend`, ASIO on Windows (proprietary Steinberg license), JACK/PipeWire on Linux; then optionally move the shell to Tauri+CEF. | Only if measured latency on WASAPI/CoreAudio via Chromium is not good enough. |

---

## What the code has today (read, not assumed)

- `src/platform/capabilities.ts` — one boot-time feature probe: `audioWorklet`,
  `webgpu`, `webmidi`, `webhid`, `fsAccess`, `setSinkId`, `sharedArrayBuffer`,
  `offscreenCanvas`, `webWorker`. Feature tests, no UA sniffing — the right basis for
  every fallback below.
- `src/platform/transport-webmidi/manager.ts` — `requestMIDIAccess({ sysex: false })`
  (line 63). **Input only; no MIDI output (no LEDs) yet** (planned `v0.11.0`). **Learn
  already exists** (`learn(action)` / `cancelLearn()`, line 266+), writing a custom
  mapping that preserves `relativeEncoding`.
- `src/core/mapping/mapping.ts` — `Binding.mode` is `button | absolute | relative`;
  `RelativeEncoding` is `twos-complement | offset-64` (the FLX4 measurement). Mapping
  key is `type:channel:data1`. **No 14-bit pairs, no SysEx, no pitch-bend, no HID.**
  The FLX4 tempo fader uses the MSB only (`flx4.ts` comment: "14-bit MSB only used
  here").
- `src/platform/audio-webaudio/engine.ts` — `wireOutput()` uses
  `destination.maxChannelCount >= 4` to route master to 1–2 and cue to 3–4 via a
  `ChannelMerger`, else folds cue into the stereo mix. Device choice is
  `AudioContext.setSinkId` (returns `'unsupported'` when missing). This is exactly the
  behaviour that each browser/webview row below either keeps or breaks.
- `src/core/ports/transport.ts` — `ControlTransport` is input-only, already shaped
  for WebHID/BLE-MIDI/Serial transports.

---

## A. Browser matrix

### A.1 Support matrix (desktop, stable channels, September 2026)

"Chromium" = Chrome/Edge/Opera/Arc/Comet; Brave differs where noted.

| API DeckMix uses | Chromium desktop | Brave | Firefox desktop | Safari macOS | iPadOS/iOS (all browsers are WebKit) | Chrome Android |
| --- | --- | --- | --- | --- | --- | --- |
| Web MIDI (in) | ✅ since 43; permission prompt for **all** MIDI since Chrome 124–125 [1] | ✅ (Chromium) — UNVERIFIED whether Brave adds its own gate | ✅ since 108, **gated by a generated "site permission add-on"** the user must install, then reload [2][3] | ❌ never (WebKit bug 107250) [4] | ❌ | ✅ [4] |
| Web MIDI SysEx | ✅ separate permission [5] | as Chromium | ✅ via the same add-on flow (UNVERIFIED detail) | ❌ | ❌ | ✅ |
| Web MIDI `statechange` (hot-plug) | ✅ | ✅ | ⚠️ handler exists but "the event never fires" (bug 1802149) [4] | ❌ | ❌ | ✅ |
| File System Access: `showDirectoryPicker` | ✅ since 86/105 [6] | ❌ **disabled by default**, opt-in flag `brave://flags/#file-system-access-api` [7][8] | ❌ Mozilla position "harmful" [6] | ❌ | ❌ | ❌ [6] |
| Persistent directory handle in IndexedDB + `queryPermission/requestPermission` | ✅; "Allow on every visit" since Chrome 122 [9] | only if flag on | ❌ (methods Chrome-only) [10] | ❌ | ❌ | ❌ |
| OPFS `navigator.storage.getDirectory()` | ✅ 86 | ✅ | ✅ 111 | ✅ 15.2 | ✅ 15.2 | ✅ 109 [11] |
| `<input webkitdirectory>` (folder upload) | ✅ | ✅ | ✅ 50 | ✅ 11.1 | ✅ iOS 18.4+ | ✅ [12] |
| `AudioContext.setSinkId` / `sinkId` | ✅ 110 [13] | ✅ (UNVERIFIED if Brave fingerprinting shields restrict device labels) | ❌ [13] | ❌ | ❌ | ❌ |
| `HTMLMediaElement.setSinkId` | ✅ 49 | ✅ | ✅ 116 | ✅ 18.4 | mirrors Safari (UNVERIFIED usefulness on iOS) | ❌ "limitation in Android" [14] |
| `MediaDevices.selectAudioOutput()` | ❌ | ❌ | ✅ 116 (Firefox only) [15] | ❌ | ❌ | ❌ |
| Multichannel destination (`maxChannelCount` ≥ 4 on a 4-out controller card) | ✅ (what DeckMix relies on today) | ✅ | UNVERIFIED — open macOS channel-selection bug 1474175 [16] | ⚠️ `maxChannelCount` returned 0 until a WebKit fix (bug 216127) [17]; real 4-ch behaviour UNVERIFIED | UNVERIFIED | UNVERIFIED |
| AudioWorklet | ✅ 66 | ✅ | ✅ 76 | ✅ 14.1 | ✅ 14.5 | ✅ [18] |
| WebHID | ✅ 89 [19] | UNVERIFIED | ❌ | ❌ (WebKit: fingerprinting concerns) [20] | ❌ | ❌ (workers only, partial) [19] |
| WebUSB | ✅ | UNVERIFIED | ❌ | ❌ opposed [21] | ❌ | ✅ |
| Web Serial | ✅ | UNVERIFIED | ❌ stable; add-on-gated in Nightly 151 (Apr 2026) [22] | ❌ opposed [23] | ❌ | UNVERIFIED |
| WebGPU | ✅ 113 | ✅ | ✅ Windows since 141; macOS (Tahoe, ARM) since 145; Linux "2026" [24] | ⚠️ partial, 26.0+ [25] | ✅ 26.0+ [25] | ✅ |
| SharedArrayBuffer (needs COOP+COEP headers) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ — but see A.3 on static hosting |
| Media Session | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (widely supported; not re-fetched — UNVERIFIED versions) |
| Screen Wake Lock | ✅ 84 | ✅ | ✅ 126 | ✅ 16.4 | ✅ 18.4 (partial before) | ✅ [26] |

Sources:
[1] https://developer.chrome.com/blog/web-midi-permission-prompt ·
[2] https://groups.google.com/a/mozilla.org/g/dev-platform/c/15O04X2jE28/m/deXYDi85CQAJ (Mozilla "Intent to ship: Add-On-Gated WebMIDI") ·
[3] https://blog.karimratib.me/2022/04/23/firefox-webmidi.html (third-party walkthrough of the flow) ·
[4] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MIDIAccess.json and https://caniuse.com/midi ·
[5] https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMIDIAccess ·
[6] https://caniuse.com/native-filesystem-api ·
[7] https://github.com/brave/brave-core/pull/10785 ·
[8] https://github.com/brave/brave-browser/issues/18979 ·
[9] https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api ·
[10] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemHandle.json ·
[11] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/StorageManager.json ·
[12] https://caniuse.com/input-file-directory ·
[13] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/AudioContext.json ·
[14] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/HTMLMediaElement.json ·
[15] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaDevices.json ·
[16] https://bugzilla.mozilla.org/show_bug.cgi?id=1474175 ·
[17] https://trac.webkit.org/changeset/266559/webkit ·
[18] https://caniuse.com/mdn-api_audioworklet ·
[19] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/HID.json ·
[20] https://webkit.org/standards-positions/ ·
[21] https://github.com/WebKit/standards-positions/issues/68 ·
[22] https://www.theregister.com/software/2026/04/14/firefox-nightly-adds-web-serial-after-years-of-saying-no/5225521 ·
[23] https://github.com/WebKit/standards-positions/issues/199 ·
[24] https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/ and https://linuxiac.com/webgpu-lands-in-firefox-141-on-windows-eyes-linux-and-macos-next/ ·
[25] https://caniuse.com/webgpu ·
[26] https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WakeLock.json

Note on a data conflict: MDN's Web MIDI article and Mozilla's announcement say Firefox
108 shipped Web MIDI on Android too; the BCD file above marks Firefox Android as not
supported. Treat Firefox Android Web MIDI as UNVERIFIED.

### A.2 The real fallback for each gap

| Gap | Fallback | What the user must see (the project's "never skip silently" rule) |
| --- | --- | --- |
| **No Web MIDI** (Safari, iPad, all iOS browsers) | None in-browser. The `WebMIDIAPIShim` polyfill needs a native plugin/bridge, so it is not a real answer. Keyboard, mouse and touch keep working. Real fallback = the desktop app. | "Controllers need Chrome, Edge, Firefox, or the DeckMix desktop app. This browser (Safari) cannot talk to USB controllers." |
| **Firefox Web MIDI add-on gate** | Nothing to build: calling `requestMIDIAccess()` with a device connected makes Firefox offer the generated add-on [2]. The UI must explain the 3 steps (install add-on → allow → reload). Also: no hot-plug events (bug 1802149) → poll `inputs` on an interval or offer a "rescan" button. | A one-time guide panel; a "rescan controllers" button in Firefox. |
| **No File System Access** (Firefox, Safari, Brave default, Android) | `<input type="file" webkitdirectory>` and drag-and-drop of a folder (`DataTransferItem.webkitGetAsEntry()`) give `File` objects for **this session only** — no handle to store, so the user re-picks the folder each session. Optional: copy analysed metadata (not audio) to IndexedDB keyed by path+size+mtime so re-picking is instant. Copying the audio into OPFS would give persistence, but duplicates the library (GBs) and needs a quota prompt — only as an explicit "keep a copy offline" option. | Header: "This browser forgets the folder when you close it — pick it again next time." The existing "N skipped · formats" badge must still count everything `webkitdirectory` returned. |
| **Brave FSA off** | Detect `!('showDirectoryPicker' in window)` (already done) → same fallback as Firefox, plus a note that `brave://flags/#file-system-access-api` exists. | Named: "Brave turns this off by default." |
| **No `AudioContext.setSinkId`** (Firefox, Safari, Android) | (a) Play through the OS default device; tell the user to set the controller as the default output. (b) Experimental: route the Web Audio graph into a `MediaStreamAudioDestinationNode`, play it on an `<audio>` element and call `HTMLMediaElement.setSinkId` (Firefox 116+, Safari 18.4+). **Adds latency and probably drops to stereo** — UNVERIFIED, needs measurement before shipping. | "Output device can't be chosen in this browser — using system default." |
| **No 4-channel output** (cue on 3–4) | Already implemented: cue folds into master. A split-cue alternative ("mono split": master in left ear, cue in right) is a common DJ-software trick — idea only. | Already surfaced? — worth confirming the notice exists in every browser. |
| **No WebHID** (Firefox, Safari) | None in-browser; the Kontrol maker controllers need Chromium or desktop. MX2 has a MIDI mode (see C) so it partly escapes this. | Per-controller: "Kontrol S4 MK3 needs Chrome/Edge or the desktop app." |
| **No WebGPU** | Already specified in `directions.md` §3: stems offline + cache. | Existing rule. |
| **SharedArrayBuffer headers** | See A.3. | — |

### A.3 Static hosting and cross-origin isolation

`SharedArrayBuffer` requires the page to be served with `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
A pure static host that cannot set headers (e.g. GitHub Pages) cannot provide them;
the usual workaround is a service worker that re-serves responses with the headers
(`coi-serviceworker` pattern — idea only, check its license before use). Hosts like
Cloudflare Pages / Netlify allow a `_headers` file. UNVERIFIED which host DeckMix will
use — an open question below. The capability probe already reports
`sharedArrayBuffer`, so the UI can say so.

### A.4 What a "works everywhere" web tier can honestly promise

| Tier | Browsers | Promise |
| --- | --- | --- |
| **Full** | Chrome, Edge, Opera, Arc, Comet on Windows/macOS/Linux/ChromeOS | Everything: controllers (MIDI, HID), remembered library folder, output device choice, 4-ch headphone cue, recording to a file the user picks. |
| **Full minus two** | Brave (default settings) | As Full, but the library folder is re-picked each session unless the user enables the flag. |
| **Mixing + MIDI controllers** | Firefox (Win/macOS/Linux) | Mixing, FX, analysis; MIDI controllers after the add-on step; **no** remembered folder, **no** output device choice (system default), **no** HID controllers; 4-ch cue UNVERIFIED. |
| **Mixing only** | Safari macOS | Mouse/keyboard mixing, session-only library, system-default output, cue folded into master. **No controllers.** |
| **Touch mixing** | iPad (any browser) | As Safari macOS, touch UI; folder pick needs iPadOS 18.4+. **No controllers.** |
| **Touch + MIDI** | Android tablets (Chrome) | Web MIDI over USB-OTG works; no folder memory, no output choice, no 4-ch cue (UNVERIFIED — Android usually exposes USB audio as stereo). |

Recording (v0.7.5) writes via a save dialog — `showSaveFilePicker` is FSA, so on
Firefox/Safari recording must fall back to an in-memory `Blob` + download link. That
means long recordings are RAM-bound; a visible limit is needed. (UNVERIFIED how
`recorder-fsaccess` currently behaves when FSA is absent — check before W1.)

---

## B. Desktop wrapper

### B.1 Candidates

| | Engine per OS | Web MIDI / FSA / setSinkId / 4-ch / WebHID inside | Native fill-ins | License (verified) | App size |
| --- | --- | --- | --- | --- | --- |
| **Electron** | Bundled Chromium on all three | Same as Chrome. MIDI via `setPermissionRequestHandler` (`midi`, `midiSysex`), HID via `select-hid-device` + `setDevicePermissionHandler`, FSA via `fileSystem` permission [B1] | Node `fs` for library (no browser permission dance), N-API addons for anything else | MIT [B2] | Large: Chromium per app — typically ~80–150 MB installed (UNVERIFIED, measure) |
| **Tauri 2** | Windows: WebView2 (Chromium, evergreen); macOS: WKWebView (updates only with the OS); Linux: WebKitGTK (distro-dependent) [B3] | Windows ≈ Chrome (WebHID in WebView2 UNVERIFIED). **macOS & Linux: no Web MIDI, no FSA, no `AudioContext.setSinkId`, no WebHID.** Linux WebKitGTK runs Web Audio *and* `decodeAudioData` through host GStreamer plugins — AppImages have shipped with no MP3/AAC decoder [B4] | Rust: `midir` (MIT) for MIDI, `cpal` (Apache-2.0) for audio incl. ASIO/CoreAudio/ALSA/JACK/PipeWire/PulseAudio, `hidapi` (MIT) for HID, `rfd` (MIT) for dialogs, `std::fs` for files. A ready `tauri-plugin-midi` emulates Web MIDI in WKWebView [B5] | Apache-2.0 / MIT dual [B6] | Small: few MB (uses the OS webview) |
| **Tauri + CEF runtime** | Bundled Chromium on all three | Same as Chrome | As Tauri | Apache-2.0/MIT + CEF (BSD) | Electron-sized |
| | **Status: not officially released.** Upstream work is in a `feat/cef` branch; a community extraction exists [B7][B8]. Watch item, not a v1.0 foundation. | | | | |
| **Neutralino** | OS webview (same gaps as Tauri) | As Tauri, without Tauri's plugin ecosystem | Small native API (fs, os); no MIDI/audio | MIT [B9] | Tiny |
| **Wails** (Go) | OS webview (same gaps as Tauri) | As Tauri | Go libs (e.g. `gomidi` — license UNVERIFIED) | MIT [B10] | Small |
| **Native** (JUCE/Qt/Swift+C#…) | none | n/a — rewrite UI | everything | JUCE and Qt have commercial/GPL splits (UNVERIFIED current terms) | Small |

Sources: [B1] https://www.electronjs.org/docs/latest/api/session ·
[B2] https://github.com/electron/electron/blob/main/LICENSE ·
[B3] https://v2.tauri.app/reference/webview-versions/ ·
[B4] https://github.com/phase-rs/phase/issues/8615 and https://github.com/mcinnisdev/chopdeck/pull/2 ·
[B5] https://github.com/specta-rs/tauri-plugin-midi ·
[B6] https://github.com/tauri-apps/tauri (LICENSE-APACHE-2.0 / LICENSE_MIT) ·
[B7] https://github.com/tauri-apps/tauri/pull/15984 ·
[B8] https://github.com/SableClient/tauri-runtime-cef ·
[B9] https://github.com/neutralinojs/neutralinojs/blob/main/LICENSE ·
[B10] https://github.com/wailsapp/wails/blob/master/LICENSE

Licenses verified via the GitHub license API and the files themselves this session:
Electron MIT; Tauri Apache-2.0 + MIT; cpal `license = "Apache-2.0"`; midir
`license = "MIT"`; hidapi-rs `license = "MIT"`; rfd MIT; Wails MIT; rust-jack MIT.
Neutralino LICENSE: "Neutralinojs core is licensed for use as follows: MIT License".
The C `hidapi` library (under hidapi-rs) says: "HIDAPI can be used under one of three
licenses" — GPLv3, BSD-style, or the original HIDAPI license, "at the discretion of
the user" — so a proprietary app picks BSD or original.

### B.2 Why the webview choice decides everything

The whole app is Web Audio + Web MIDI + FSA + `setSinkId`. On Tauri:

- **Windows** — fine; WebView2 is Chromium.
- **macOS** — MIDI can be bridged (`tauri-plugin-midi`/`midir`) and the library can be
  read natively. **Output device selection and the 4-channel cue cannot** be bridged
  while audio is produced by WKWebView's Web Audio: there is no `setSinkId`, and the
  OS default device is all you get. To choose the controller's sound card, the audio
  must be rendered natively (cpal) — i.e. port `audio-webaudio/` (deck, FX, sampler,
  recorder tap, key-lock plans) to Rust, or stream PCM from JS to Rust over IPC
  (latency and jitter risk; UNVERIFIED feasibility for DJ use).
- **Linux** — same as macOS, plus codec decoding depends on host GStreamer plugins
  [B4]; decode could move to Rust (`symphonia`, MPL-2.0 — UNVERIFIED license, check).

So "Tauri for 1.0" really means "write a native audio engine for 1.0". Electron means
"ship the engine that already works". That is the recommendation, with the size cost
stated plainly.

**What Electron does not solve:** ASIO on Windows (Chromium uses WASAPI shared mode;
real latency UNVERIFIED — measure on Shalom's machine with the FLX4), JACK on Linux,
and Ableton Link (needs UDP — possible from Electron's Node side, but see the license
issue). All three can come later as native addons behind existing ports.

### B.3 One codebase or three "full versions"?

**One codebase.** With Electron (or later Tauri+CEF) the renderer is identical on all
three OSes; the per-OS differences are packaging, signing, and small native modules.
The existing layering already puts the seams in the right place:
`platform/source-fsaccess` → add `platform/source-node-fs`;
`platform/transport-webmidi` → still works inside Electron (Chromium), with a
`transport-hid` later; `platform/audio-webaudio` unchanged. Each OS still gets a
**complete product** — the owner's "full version per OS" goal is about the user's
experience, not about separate code.

Per-OS work that is real:

| OS | Packaging | Signing | Notes |
| --- | --- | --- | --- |
| Windows | NSIS/MSI (electron-builder) or MSIX (Store) | Azure Artifact Signing (ex-Trusted Signing): US$9.99/month; **individuals only in US/Canada; organizations in Israel are eligible** [B11][B12]. Otherwise an OV/EV certificate from a CA (price UNVERIFIED, typically hundreds of USD/yr). Unsigned → SmartScreen warnings. | Windows MIDI Services (multi-client MIDI, loopback ports) is rolling out on Windows 11 24H2+ [B13] — removes the old "only one app can open the controller" limit. |
| macOS | `.app` in `.dmg`; universal (arm64+x64) build | Apple Developer Program **99 USD/year** [B14]; Developer ID signing + notarization included [B15]; hardened runtime | Microphone/audio entitlements for input (UNVERIFIED which ones Electron needs for output-only). |
| Linux | AppImage, `.deb`, `.rpm`, Flatpak (Flathub), Snap | Optional GPG; Flatpak/Snap signed by store | Flatpak sandbox needs `--device=all` (USB MIDI/HID) and filesystem permission for `~/Music` — UNVERIFIED exact Flatpak permissions; udev rule for HID access to the Kontrol maker devices. |

Auto-update: `electron-updater` (with electron-builder) or Squirrel; Tauri has an
updater plugin. Both need signed artifacts and a static file host — consistent with
"no server" (a static bucket is not an app server, but it is a new piece of
infrastructure; see open questions).

[B11] https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ ·
[B12] https://learn.microsoft.com/en-us/azure/artifact-signing/faq and https://learn.microsoft.com/en-us/answers/questions/5890809/inquiry-regarding-azure-trusted-signing-geographic ·
[B13] https://devblogs.microsoft.com/windows-music-dev/windows-midi-services-rollout-known-issues-and-workarounds/ ·
[B14] https://developer.apple.com/programs/enroll/ — "99 USD per membership year" ·
[B15] https://developer.apple.com/support/compare-memberships/

### B.4 Codecs (a licensing footnote that matters for a sold product)

Electron builds Chromium with proprietary codecs (AAC, H.264) enabled; whether that
creates a patent-licensing obligation for the app vendor is disputed and outside what
Electron assesses [B16]. MP3 patents have expired (UNVERIFIED for every jurisdiction).
Tauri on Win/macOS uses OS decoders (the OS vendor holds the licenses). **Ask a lawyer
before selling** — see E.

[B16] https://github.com/electron/electron/issues/48097 and https://github.com/electron/libchromiumcontent/issues/174

### B.5 Recommendation

1. **v1.0 desktop = Electron**, one repo, three signed products. Minimal new code:
   a Node-fs `TrackSource`, permission handlers, updater.
2. Keep every platform call behind the ports so a **native audio engine** can replace
   `audio-webaudio` later without touching `core/` or `app/`.
3. **Re-evaluate Tauri when its CEF runtime ships officially** — then the renderer is
   still Chromium, and the Rust side (midir/cpal/hidapi) is a clean home for the
   native engine. Until then, Tauri forces the engine rewrite up front on macOS/Linux.
4. Update `ROADMAP.md`/`directions.md` wording "Tauri around v1.0" only after the owner
   decides (open question 1).

---

## C. Controllers

### C.1 Popularity evidence (weak — read the caveats)

No manufacturer publishes unit sales. The only first-hand ranking fetched this session:

**Thomann bestseller list, DJ controllers (fetched 2026-09-24,
https://www.thomann.de/de/topseller_GF_dj_controller.html):** 1 Hercules DJControl
Inpulse 500 · 2 Denon DJ Prime 4 G2 · 3 Rane Performer · 4 Kontrol MX2 · 5 Numark
Party Mix MKIII · 6 Denon DJ SC Live 4 · 7 Numark Mixtrack Go · 8 Rane One MKII · 9
Kontrol Z1 MK2 · 10 Reloop Mixtour Pro · 11 Roland DJ-202 · 12 Hercules Inpulse T7
Premium · 13 Reloop Mixon 8 Pro · 14 Numark Mixstream Pro+ · 15 Denon Prime GO+ · 16
Hercules DJControl Mix Ultra · 17 Roland DJ-707M · 18 Rane Twelve MKII · 19 Numark
Mixstream Pro GO · 20 Kontrol X1 MK3.

**Caveat: no AlphaTheta/Pioneer product appears at all**, which almost certainly
reflects distribution (UNVERIFIED — Pioneer may not be sold through Thomann), not
demand. Editorial buying guides consistently name the DDJ-FLX4 as the default beginner
controller (https://dj.studio/blog/dj-controllers,
https://www.musicradar.com/news/best-beginner-dj-controllers) — editorial opinion, not
sales data. Sweetwater and Amazon bestseller pages refused automated access.

**Estimated ~10–12 models that cover most active users — UNVERIFIED (judgement from the
above, not sales data):** DDJ-FLX4, DDJ-400 (large installed base), DDJ-FLX6, DDJ-FLX10,
DDJ-REV1; Hercules Inpulse 200/300/500; Numark Mixtrack Platinum FX / Pro FX and Party
Mix; Kontrol S2 MK3 / Z1 / MX2; Rane One; Denon SC Live 4 / Prime GO+.

### C.2 Per-controller table

Legend — Protocol: **MIDI-CC** = USB class-compliant MIDI; **HID** = USB HID reports;
**Audio**: "4-out" = master on 1–2 + headphones on 3–4 (what `wireOutput()` needs).
"Doc" = official manufacturer MIDI list found. Facts attributed to an open-source DJ program's manual are
factual hardware descriptions only (protocol, channel layout); no mapping content was
read or copied.

| Model | Protocol | Audio | Jog / notable I/O | Official MIDI doc | Software bundling / lock-in |
| --- | --- | --- | --- | --- | --- |
| **AlphaTheta DDJ-FLX4** (supported) | MIDI class-compliant [M1] | 4-out (in use today) | Jog: relative CC, offset-64, separate top/rim CCs + touch note (measured in repo); tempo 14-bit (MSB used) | ✅ `ddj-flx4_midi_message_list_e1.pdf` [P1] | commercial software unlock; works with "MIDI-compatible software" per AlphaTheta [P2] |
| DDJ-FLX2 | MIDI (UNVERIFIED) | UNVERIFIED | small jogs | UNVERIFIED | commercial software (source removed v0.12.3, UNVERIFIED) |
| DDJ-FLX6(-GT) | MIDI (UNVERIFIED) | 4-out (UNVERIFIED) | 4-deck, Merge FX | likely (AlphaTheta pattern) — UNVERIFIED | commercial software |
| DDJ-FLX10 | MIDI | 4-out+ (UNVERIFIED) | jog displays, 4-deck, stems buttons | ✅ "MIDI-compatible software" page with message list [P4] | commercial software |
| DDJ-REV1 | MIDI | 4-out (UNVERIFIED) | battle layout | UNVERIFIED | commercial software |
| DDJ-REV5 | MIDI (UNVERIFIED) | UNVERIFIED | commercial software stems | UNVERIFIED | commercial software |
| DDJ-REV7 | MIDI | 4-out+ | **motorized platters + on-jog displays** (UNVERIFIED how displays are fed) | ✅ [P5] | commercial software |
| DDJ-GRV6 | MIDI | UNVERIFIED | Groove Circuit | ✅ [P6] | commercial software |
| DDJ-400 | MIDI | 4-out | firmware bug note in open-source DJ program's manual [M2] | UNVERIFIED | commercial software |
| DDJ-SB3 | MIDI | 4-out; **decks 3–4 only when its sound card is used (firmware limit)** [M3] | | UNVERIFIED | commercial software |
| DDJ-200 | MIDI | **no audio interface** (UNVERIFIED) | smartphone-oriented | ✅ `DDJ-200_MIDI_Message_List_E2.pdf` [P7] | commercial software |
| DDJ-1000 | MIDI | 4-out+ | jog displays fed by commercial software (mechanism UNVERIFIED) | UNVERIFIED | commercial software |
| **Hercules DJControl Inpulse 500** | MIDI class-compliant | **4-out** [M4] | | ✅ "MIDI Commands" + "MIDI manual" PDFs on Hercules support [H1] | commercial software |
| Inpulse 200/300, T7 | MIDI (class-compliant per an open-source DJ program's pages for 200/300) | 200: UNVERIFIED; T7: motorized (UNVERIFIED) | | Hercules publishes per-model MIDI docs (pattern; UNVERIFIED per model) | commercial software |
| Hercules DJControl Starlight | MIDI class-compliant | **4-out** (3.5 mm) [M5] | | UNVERIFIED | commercial software |
| Hercules DJControl Mix / Mix Ultra | USB-MIDI; also Bluetooth (BLE-MIDI, UNVERIFIED) | **no audio interface** [M6] | | UNVERIFIED | commercial software |
| **Numark Mixtrack Platinum FX** | MIDI + audio class-compliant [M7] | 4-out [M7] | jog LCD displays; firmware 1.10 needed for full features in an open-source DJ program [M7] | none official found — UNVERIFIED | commercial software |
| Numark Mixtrack Pro FX, Mixtrack Go | MIDI (UNVERIFIED) | UNVERIFIED | | UNVERIFIED | commercial software |
| Numark Party Mix MKII/MKIII | MIDI | UNVERIFIED (has headphone out) | light show | UNVERIFIED | commercial software |
| Numark NS4FX | MIDI (UNVERIFIED) | 4-out (UNVERIFIED) | 4-deck, 14-bit pitch (UNVERIFIED) | UNVERIFIED | commercial software |
| Numark Mixstream Pro/Pro+/Pro GO | standalone (its standalone OS); computer mode MIDI? UNVERIFIED | | | UNVERIFIED | commercial software in computer mode (UNVERIFIED) |
| **Kontrol S2 MK3** | **HID** | 4-out (ch 1–2 main, 3–4 phones) [M8] | discontinued (source removed v0.12.3, UNVERIFIED) | the Kontrol maker publishes commercial software mapping docs, not HID specs (UNVERIFIED) | commercial software |
| Kontrol S3 | HID + audio class-compliant, 4-ch [M9] | 4-out | | — | commercial software |
| Kontrol S4 MK3 | HID; **jog extends HID for motorized/haptic wheels**; screens not via HID [M10] | 4-out; **mixer knobs physically linked to its embedded mixer** [M10] | | — | commercial software |
| Kontrol Z1 (MK2) | HID + audio class-compliant, 4-ch [M11] | 4-out | Main/Cue vol are hardware | — | commercial software |
| Kontrol MX2 (2025) | **HID, plus a MIDI mode (both SHIFT buttons)** [M12] | 4-out [M12] | | — | commercial software |
| Kontrol X1 MK3 | UNVERIFIED (HID; MIDI mode UNVERIFIED) | none | add-on controller | — | commercial software |
| **Rane One MKII** | UNVERIFIED (believed MIDI) | UNVERIFIED | **motorized 7" platter** | none found | **commercial software unlock**; documentation is commercial software-only [R1] (source removed v0.12.3, UNVERIFIED) |
| Rane Four / Performer / Twelve MKII | UNVERIFIED | UNVERIFIED | Performer motorized | none found | commercial software |
| **Denon DJ SC Live 4 / SC Live 2** | standalone; "Computer Mode" for commercial software, described as **HID mode** [D1] (source removed v0.12.3, UNVERIFIED) | UNVERIFIED | | none found | its standalone OS; commercial software unlocked |
| Denon DJ Prime GO+ / Prime 4 (G2) | standalone; computer mode (protocol UNVERIFIED) | UNVERIFIED | | none found | its standalone OS; commercial software |
| Denon MC7000 | MIDI | **dual USB audio interfaces**; 4-deck [M13] | "Line/Phono" switch silences the deck's MIDI [M13] | UNVERIFIED | commercial software |
| Reloop Beatmix 4 MK2 | MIDI + audio class-compliant [M14] | yes | | UNVERIFIED | commercial software |
| Reloop Mixon 8 Pro, Mixtour Pro, Buddy, Ready | MIDI (UNVERIFIED) | UNVERIFIED | | Reloop often ships MIDI docs — UNVERIFIED | commercial software (UNVERIFIED) |
| Roland DJ-505 | MIDI + audio class-compliant [M15] | multi-ch | TR-S drum machine | Roland typically publishes MIDI implementation — UNVERIFIED | commercial software |
| Roland DJ-202, DJ-707M | MIDI (UNVERIFIED) | UNVERIFIED | | UNVERIFIED | commercial software |

Sources:
[P1] https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_midi_message_list_e1.pdf ·
[P2] https://support.alphatheta.com/en-US/articles/12294087060377 ·
[P4] https://support.alphatheta.com/en-US/articles/16716711647129 ·
[P5] https://support.alphatheta.com/en-US/articles/4414574284697 ·
[P6] https://support.alphatheta.com/en-US/articles/37284057102489 ·
[P7] https://downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-200/DDJ-200_MIDI_Message_List_E2.pdf ·
[H1] https://support.hercules.com/en/product/djcontrolinpulse500-en/ ·
[R1] https://support.rane.com/en/support/solutions/articles/69000867558-rane-one-mkii-frequently-asked-questions ·
[D1] https://www.denondj.com/sclive4 ·
[M1]–[M15] an open-source DJ program's public controller manual (links removed in v0.12.3).

AlphaTheta's help-center pages returned HTTP 403 to automated fetches; their existence
and the "refer to the list of MIDI messages" wording came through search snippets.
Whether each page links a downloadable PDF is UNVERIFIED for FLX10/REV7/GRV6.

### C.3 Cross-cutting observations

- **"Works only with the bundled software" is a licensing bundle, not a protocol lock** for the
  MIDI units: the controller unlocks the vendor's software, but it still speaks
  class-compliant MIDI to anyone. AlphaTheta states its controllers work with other
  MIDI-compatible software [P2][P4][P5][P6]. The Rane/Denon standalone and motorized
  units are the ones where openness is genuinely unknown (UNVERIFIED).
- **Jog formats differ per vendor**, which the repo already learned the hard way
  (offset-64 on FLX4 vs the two's-complement default). Expect also: 14-bit absolute
  position (MSB+LSB CC pairs), pitch-bend messages, and on HID devices multi-byte
  counters with timestamps (S4 MK3). Per-vendor specifics: UNVERIFIED until each
  document/trace is read.
- **Init / keep-alive messages**: some controllers need a message from the host to
  leave a demo/idle light mode, to report current knob positions, or to enable a
  mode. Which models: UNVERIFIED — the profile format must allow it anyway.
- **Hardware-linked knobs**: on several 4-out controllers the Master and Headphone
  knobs act on the built-in sound card directly (S4 MK3, Z1, Starlight [M5][M10][M11]).
  The profile must mark these "hardware — do not double-apply", or DeckMix will apply
  the gain twice.
- **Displays**: jog/screen displays (FLX10, REV7, DDJ-1000, S4 MK3 screens,
  Mixtrack Platinum FX jog LCDs) are driven by SysEx or vendor bulk transfers; out of
  scope until a vendor document or a clean trace exists.
- **Windows drivers**: class-compliant devices work without vendor drivers, but some
  vendors' 4-channel output on Windows may need their ASIO/WDM driver to expose 4
  channels to WASAPI (UNVERIFIED per model — test on FLX4 already passes in Chrome).

---

## D. Architecture for many controllers

### D.1 How others structure it (ideas only)

*(Removed in v0.12.3 at the owner's request: no names of, links to, or comparisons with other DJ software.)*

- **An open-source program** uses a per-controller declarative table (MIDI → control bindings, LED
  outputs) plus a small script for stateful parts (jogs, shift layers, pad modes, HID parsing). It is
  **GPL — do not copy its mappings, scripts, or numbers.** The architecture idea (declarative table +
  small-code escape hatch) is not copyrightable and is what everyone converges on.
- **Closed programs** ship first-party "plug-and-play" profiles per vendor partnership plus a user
  MIDI-learn editor. The lesson: ship first-party profiles for the popular list, and a learn tool for
  the long tail.

### D.2 Proposed DeckMix controller profile (pure `core/`)

A `ControllerProfile` is plain data (JSON-serialisable, versioned, schema-validated),
living in `core/` so it is testable and runs identically in browser and desktop:

```ts
// sketch — names are illustrative
interface ControllerProfile {
  schema: 1
  id: string                         // 'alphatheta-ddj-flx4'
  match: { midiPortName?: RegExp-string[]; usb?: { vendorId: number; productId: number }[] }
  transport: 'midi' | 'hid'
  source: 'vendor-doc' | 'trace' | 'learn'   // provenance, for the licence audit
  relativeEncoding?: RelativeEncoding        // default for relative controls
  inputs: InputSpec[]                        // what the device sends
  outputs?: OutputSpec[]                     // LEDs, rings, VU
  init?: RawMessage[]; keepAlive?: { everyMs: number; msg: RawMessage }
  needsSysex?: boolean                       // triggers the separate permission
  audio?: { master: [number, number]; cue: [number, number]; hardwareKnobs?: ControlAction[] }
  jog?: { ticksPerRevolution: number }       // scratch maths belongs to core/scratch.ts
}
type InputSpec =
  | { kind: 'midi7';  msg: 'note'|'cc'|'pb'; ch: number; data1: number; bind: Binding }
  | { kind: 'midi14'; ch: number; msb: number; lsb: number; bind: Binding } // 14-bit pair
  | { kind: 'hid'; reportId: number; byte: number; bit?: number; width: 1|8|16|32;
      signed?: boolean; littleEndian?: boolean; delta?: boolean; bind: Binding }
type OutputSpec =
  | { kind: 'midi'; msg: 'note'|'cc'; ch: number; data1: number; on: number; off: number; state: StateRef }
  | { kind: 'hid'; reportId: number; byte: number; state: StateRef }
```

Rules that keep this safe and small:

1. **Shift layers and pad modes are data** (`layer: 'shift'`, `padMode: 'hotcue'`), not
   code. Most "why an open-source DJ program needs JS" cases are these.
2. **The escape hatch is a named, reviewed TS function in `core/`**, referenced by id
   (e.g. `decode: 'ni-s4mk3-jog'`) — never arbitrary JS inside a profile file. User or
   community profiles therefore cannot execute code (matters once profiles are shared).
3. **14-bit**: pair MSB+LSB per `(ch, msb, lsb)`, apply on LSB arrival, tolerate
   MSB-only senders (FLX4 tempo today) — the mismatch must be visible in the MIDI
   monitor, not silent.
4. **Outputs are state subscriptions**: the store already holds deck state; an
   `OutputDriver` diffs it and sends only changes (rate-limited — MIDI DIN/USB can be
   flooded).
5. **Audio routing is part of the profile**: which channels are master/cue, and which
   knobs are hardware-only. `wireOutput()` then stops assuming "4 channels = 1–2/3–4".
6. **Transport split**: `transport-webmidi` (exists), `transport-webhid` (Chromium),
   and on desktop `transport-node-midi`/`transport-node-hid` or the same Web APIs
   inside Electron. All emit the same `ControlAction` stream into `controls.ts` —
   this also retires the `manager.ts` → store direct-write warning noted in
   `CLAUDE.md`.

### D.3 Learn wizard (Learn exists — extend it)

Today: `learn(action)` waits for one message and binds it. Proposed guided flow:

1. "Move the left jog wheel slowly clockwise" → collect 1–2 s of messages → classify:
   values clustered at 1/127 → two's-complement; at 63/65 → offset-64; monotonic
   0..127 wrap → absolute; paired CCs (n and n+32) → 14-bit. This is the FLX4 lesson
   turned into code.
2. "Touch the top of the jog" → the touch note.
3. "Press PLAY" → button; note-on/off vs toggle detection.
4. Unknown device → the wizard walks a checklist of `ControlAction`s and saves a
   `source: 'learn'` profile the user can export as a file.
5. Every unrecognised message stays visible in the monitor ("12 messages from this
   device are not mapped") — the never-skip-silently rule for controllers.

### D.4 Testing without owning the devices

- **Recorded traces** as fixtures: `{ t: ms, bytes: number[] }[]` (MIDI) or HID report
  hex dumps, captured with a small in-app "record a trace" tool. Vitest replays them
  through `parseMessage`/profile decoder and asserts the resulting `ControlAction`s.
  Pure `core/` → fits `tests/core/`.
- **Profile lint test** (`tests/repo/`): every profile validates against the schema,
  has a `source`, no duplicate bindings, no binding to an unknown action.
- **Virtual MIDI ports** to drive the running app end-to-end: Windows — Windows MIDI
  Services loopback endpoints (Windows 11 24H2+ rollout [B13]) or loopMIDI (freeware,
  license UNVERIFIED); macOS — the built-in IAC Driver (Audio MIDI Setup); Linux —
  `snd-virmidi` kernel module or ALSA `aconnect`. A Node script (`midir`-like or the
  `midi` npm package — license UNVERIFIED) replays a trace into the port.
- **Community capture**: owners of other controllers record a 60-second guided trace
  and send the file. Privacy: traces contain only control messages, but the consent
  text must say so. No backend needed (they email/attach the file).
- **Hardware you do own** (FLX4) stays the reference for jog feel and latency — the
  scratch maths already has unit tests.

---

## E. Legal (brief — questions for a lawyer, not answers)

1. **Naming controller brands in the UI.** Showing "Pioneer DJ DDJ-FLX4" to identify
   what a profile is for is the classic *referential/nominative* use. US: nominative
   fair use doctrine (case law, e.g. *New Kids on the Block v. News America*, 9th Cir.
   1992 — UNVERIFIED citation detail). EU: Directive (EU) 2015/2436, Art. 14(1)(c)
   allows use of a mark "to identify or refer to goods… as those of the proprietor",
   especially to indicate intended purpose (e.g. accessories/spare parts) — text not
   fetched this session (EUR-Lex returned empty), wording UNVERIFIED
   (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32015L2436). Practical
   rules: plain text names only, **no logos or product photos**, "works with" not
   "certified/official", a disclaimer that marks belong to their owners. Note the
   project already renamed itself away from a Waves trademark — the same care applies.
2. **Reverse-engineering HID/MIDI protocols.** US 17 U.S.C. §1201(f)(1) permits
   circumventing access controls on a lawfully obtained program "for the sole purpose
   of identifying and analyzing those elements of the program that are necessary to
   achieve interoperability of an independently created computer program with other
   programs" (https://www.law.cornell.edu/uscode/text/17/1201). EU Software Directive
   2009/24/EC Art. 5(3) (observe/study/test) and Art. 6 (decompilation for
   interoperability), with Art. 8 making contrary contract terms void — wording
   UNVERIFIED this session (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009L0024).
   Israel: Copyright Act 2007 has a software interoperability exception — UNVERIFIED
   section and scope. **Lowest-risk method:** observe the traffic of a device you own
   (USB capture of what the controller sends when you move it) and read vendor-published
   MIDI lists; **avoid decompiling vendor software** and check each vendor EULA/firmware
   licence for anti-reverse-engineering terms.
3. **Copyright in mappings.** A vendor MIDI list is a factual table; using the facts is
   normally fine, copying the PDF is not needed. **Third-party mappings (an open-source DJ program: GPL;
   commercial software community mappings: licences vary) must not be copied** —
   `source: 'vendor-doc' | 'trace' | 'learn'` in every profile is the audit trail.
4. **Licences inside a sold product.** Permissive (MIT/Apache/BSD) only; keep NOTICE
   files. Specific flags from this research:
   - **Ableton Link**: "dual licensed under GPLv2+ and a proprietary license", contact
     link-devs@ableton.com (https://github.com/Ableton/link). The `ROADMAP.md` post-1.0
     plan to vendor it into a proprietary DeckMix requires the proprietary licence.
   - **ASIO SDK**: since Oct 2025 GPLv3 *or* Steinberg's proprietary agreement, which is
     free but must be signed (https://www.kvraudio.com/news/steinberg-moves-vst-3-sdk-to-mit-open-source-license-asio-now-gplv3-65179).
     cpal's `asio` feature links it — proprietary agreement required.
   - **hidapi**: pick the BSD or original licence, not GPLv3.
   - **Codecs**: AAC decoding in bundled Chromium (Electron) — patent question for a
     lawyer [B16].
5. **Patents.** No freedom-to-operate search was done. DJ features such as beat sync,
   stems separation and motorized-platter control are areas where vendors hold
   patents (UNVERIFIED — no specific patent identified). Recommend a professional FTO
   search before commercial launch.

---

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Promising "all browsers" and delivering half the product on Safari | Trust | Publish the A.4 tier table in the app itself. |
| Electron size / RAM criticism | Low for a DJ app on a laptop | Measure; revisit Tauri+CEF later. |
| WASAPI/CoreAudio latency through Chromium too high for scratching | Core feel | Measure on FLX4 before D1; native engine is D2. |
| Controllers without published docs mapped from guesses | Silent misfires | `source` field; "unverified profile" badge; Learn to fix; traces as tests. |
| A single-person team owning one controller | Coverage | Community traces + virtual-port replay. |
| Licence contamination (an open-source DJ program, Link, ASIO) | Blocks sale | Profile provenance field; dependency licence check in `npm run check` (idea). |
| Windows signing unavailable to an individual in Israel via Azure | Unsigned installer warnings | Register a business entity or buy an OV/EV certificate. |

## Open questions for the owner

1. **Desktop engine:** Electron now (bigger download, fastest to three full products) or
   Tauri (small, but needs a new audio engine first on Mac/Linux)? This changes the
   "Tauri around v1.0" line in `directions.md`.
2. **Which browsers must be "full"?** Is it acceptable that Safari/iPad users get
   mixing without controllers, with a pointer to the desktop app?
3. **Which ~10 controllers first?** Proposal: AlphaTheta + Hercules (published MIDI
   docs), then Numark. Do you (or friends) own any besides the FLX4?
4. **Business entity:** will DeckMix be sold by a company? It decides Windows signing
   (Azure individual accounts exclude Israel) and who signs the Ableton/Steinberg
   agreements.
5. **Hosting and updates:** where is the web tier hosted (headers for
   SharedArrayBuffer), and where do desktop update files live?
6. **Community profiles:** should users be able to share controller profiles (a
   future "mapping marketplace" is already in the post-1.0 ideas)? If yes, profiles
   must stay data-only (D.2 rule 2).
7. **Ableton Link:** ask Ableton for the proprietary licence now, or drop Link from the
   plan?
