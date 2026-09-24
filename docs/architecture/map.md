# מפת עץ המקור

איפה יושב כל דבר. **הנתיבים כאן תואמים את המבנה שנכנס ב‑v0.1.6** — הגרסה הקודמת של
המפה הזאת עוד הצביעה על `src/audio/`, `src/library/`, `src/midi/`, שלוש תיקיות שלא <!-- dead-path -->
קיימות מאז. העקרונות מאחורי החלוקה: [`directions.md`](directions.md).

```
src/
  main.tsx              נקודת הכניסה
  controls.ts           ★ שכבת הפעולות המשותפת ל‑UI ול‑MIDI. כל פעולת משתמש עוברת פה.
                        יושב מחוץ לשלוש השכבות בכוונה.

  core/                 TS טהור. בלי React, בלי DOM, בלי AudioContext, בלי Web MIDI.
    types.ts            טיפוסים משותפים (DeckState, MixerState, Track, ...)
    constants.ts        TEMPO_RANGE, EQ, צבעי hot cue
    recommend.ts        mixRecommendations() — טראקים תואמי BPM/סולם לדק המנגן
    mapping/mapping.ts  ControlAction + parseMessage + relativeDelta
    hash.ts              bytesToHex — הפורמט הטהור של content‑hash (v0.4.0)
    hotcues.ts            moveHotCue — רדוקטור relocate/swap טהור (v0.4.0)
    analysis-cache.ts    resolveCacheEntry — מדיניות freshness טהורה (v0.4.0)
    grid-corrections.ts  resolveGridCorrection — מתי תיקון גריד שמור עדיין תקף (v0.8.23)
    ports/              ה‑interfaces: audio, source, transport, analyzer, clock,
                        persistence, capabilities, ai

  platform/             המימושים שמאחורי ה‑ports — כאן יושבת התלות בדפדפן.
    audio-webaudio/
      engine.ts         AudioEngine singleton — ניתוב 4ch/סטריאו, crossfader, setSinkId, decode
      deck.ts           Deck — גרף Web Audio לדק בודד, loops, tempo, vinyl braking
      players.ts        SourcePlayer: BufferSourcePlayer (ישן) + WorkletPlayer (scratch)
      scratch-processor.ts  ★ ה‑AudioWorklet עצמו. אסור שייבא כלום — אין לו DOM.
    source-fsaccess/
      library.ts        File System Access — pick/scan/restore, idb-keyval לתיקייה,
                        readLibraryTags (פאס תגיות שני, batched), queueLibraryAnalysis
                        (פאס שלישי, רקע, v0.4.0)
      tags.ts           ★ readTags — ID3v2/MP4/Vorbis/RIFF/AIFF, parseKey → Camelot.
                        byte-range reads בלבד, אף פעם לא decode ולא כתיבה לקבצים
      hash.ts           hashFile/hashBytes — SHA‑256 על בייטים (v0.4.0)
    transport-webmidi/
      manager.ts        ★ MidiManager singleton — Web MIDI, dispatch לפי mapping, Learn
      mappings/flx4.ts  פריסט DDJ-FLX4 (note/CC — best-effort, לתקן דרך Learn)
    analyzer-js/analyze.ts   analyzeWaveform, detectBeatGrid (math in core/beatgrid.ts, v0.3.0)
    analyzer-worker/    Analyzer מעל Web Worker (v0.4.0) — decode נשאר ב‑thread הראשי
    analyze-cache-idb/  AnalysisCache לפי content‑hash, ב‑IndexedDB (v0.4.0)
    cues-idb/           בנק Hot Cues + נקודת CUE, לפי content‑hash (v0.4.0)
    grid-corrections-idb/ תיקוני גריד ידניים, לפי content‑hash — לא בתוך מטמון הניתוח (v0.8.23)
    genre-overrides-idb/ override ז'אנר ידני — חנות ישנה (נתיב) + חנות חדשה (hash) +
                        migrate.ts (מיגרציה חד‑פעמית, v0.4.0)
    clock-audio.ts      Clock יחיד מעל audioContext.currentTime
    capabilities.ts     מה נתמך בסביבה הזו — ה‑UI מתדרדר בחן לפיו

  app/                  React בלבד.
    App.tsx             פריסה + קיצורי מקלדת גלובליים
    state/store.ts      zustand — כל ה‑UI state. patchDeck/patchChannel/patchMixer/set*
    hooks/useRenderLoop.ts   נרשם ל‑Clock ומושך position מהמנוע ל‑store
    components/         TopBar, Deck, Mixer, Library, Waveform, Platter, PadGrid,
                        controls.tsx (Button/Knob/Fader), KeysScreen (v0.8.24 — מהטבלה ב-core/hints.ts)
```

הגבולות נאכפים ע"י `dependency-cruiser` (`.dependency-cruiser.cjs`), לא ע"י מוסכמה —
`npm run check` נכשל על הפרה. imports חוצי‑קבצים דרך alias `@/*`, אף פעם לא `../`.

**הפרה אחת מוכרת שהושארה גלויה בכוונה:** `transport-webmidi/manager.ts` כותב ל‑store
וקורא ל‑`controls.ts` ישירות במקום לפלוט `ControlAction` דרך ה‑port. היא ב‑severity
`warn` כדי שתישאר נראית — לא להעתיק את הדפוס, ולא להשתיק את הכלל.
