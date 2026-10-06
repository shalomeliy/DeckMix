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
    key-parse.ts         parseKey/parseBpm — סולם ו-BPM כפי שתגית או אדם כותבים (עבר מ-tags.ts ב-v0.8.38)
    tag-merge.ts         מי מנצח: תגית / זיהוי / ערך שהבעלים הקליד (applyOwnerMeta, v0.8.38)
    tagging.ts           pickBarSample/pickVocalSample/dropSpots — מסך התיוג: אילו שירים, איפה לנגן, מה נשמר (v0.9.0)
    downbeat.ts          detectBarOne — איזו פעימה היא ה-1: הקיק חוזר אחרי הפסקה, "בטוח" רק מעל 0.4 (v0.9.5)
    vocal-handoff.ts     planHandoff — Mix Assist לפי צליל: איפה B נכנס בלי שירה כך שישיר בדיוק כש-A שותק, ומתי A יורד (v0.9.15)
    eq-mix.ts            eqMixFrame — המעבר עם ה-EQ כמו DJ: B בלי בס, החלפת בס, אחר כך MID ו-HIGH של A, ובסוף הקרוספיידר (v0.9.18)
    key-lock.ts          keyLockSemitones — בכמה חצאי טון להחזיר את הגובה כשהטמפו זז (v0.9.20)
    key-sync.ts          planKeySync — בכמה חצאי טון להזיז דק לסולם הקרוב שמתאים לדק השני (v0.9.21)
    library-filter.ts    matchesColumnFilters — ה-▾ בכל עמודה ברשימה: טקסט, סימון ערכים, טווח, תקופה (v0.9.36)
    tempo-glide.ts       masterHasGone/glideTempoAt — מתי השיר הישן "נגמר" ואיך חוזרים לאט ל-BPM המקורי (v0.8.39)
    source-lookup.ts     beatportSearch — קישור חיפוש בלבד; האפליקציה אף פעם לא קוראת את Beatport (v0.8.38)
    ports/              ה‑interfaces: audio, source, transport, analyzer, clock,
                        persistence, capabilities, ai

  platform/             המימושים שמאחורי ה‑ports — כאן יושבת התלות בדפדפן.
    audio-webaudio/
      engine.ts         AudioEngine singleton — ניתוב 4ch/סטריאו, crossfader, setSinkId, decode
      deck.ts           Deck — גרף Web Audio לדק בודד, loops, tempo, vinyl braking
      players.ts        SourcePlayer: BufferSourcePlayer (ישן) + WorkletPlayer (scratch)
      keylock.ts        createKeyLockNode — Signalsmith Stretch (MIT) ל-key-lock, נטען רק בלחיצה הראשונה (v0.9.20)
      scratch-processor.ts  ★ ה‑AudioWorklet עצמו. אסור שייבא כלום — אין לו DOM.
    source-fsaccess/
      library.ts        File System Access — pick/scan/restore, idb-keyval לתיקייה,
                        readLibraryTags (פאס תגיות שני, batched), queueLibraryAnalysis
                        (פאס שלישי, רקע, v0.4.0)
      tags.ts           ★ readTags — ID3v2/MP4/Vorbis/RIFF/AIFF, parseKey (מ-core/key-parse) → Camelot.
                        byte-range reads בלבד, אף פעם לא decode ולא כתיבה לקבצים
      hash.ts           hashFile/hashBytes — SHA‑256 על בייטים (v0.4.0)
    transport-webmidi/
      manager.ts        ★ MidiManager singleton — Web MIDI, dispatch לפי mapping, Learn
      mappings/flx4.ts  פריסט DDJ-FLX4 (note/CC — best-effort, לתקן דרך Learn)
    analyzer-js/analyze.ts   analyzeWaveform, detectBeatGrid (math in core/beatgrid.ts, v0.3.0)
    analyzer-worker/    Analyzer מעל Web Worker (v0.4.0) — decode נשאר ב‑thread הראשי
    analyze-cache-idb/  AnalysisCache לפי content‑hash, ב‑IndexedDB (v0.4.0)
    cues-idb/           בנק Hot Cues + נקודת CUE, לפי content‑hash (v0.4.0)
    track-meta-idb/     הערה, מתי נוגן, ו-BPM/סולם שהבעלים הקליד (owner, v0.8.38) — לפי content‑hash
    tagging-idb/        התיוגים של הבעלים ("איפה ה-1", שירה) — אמת-המידה, לפי content‑hash (v0.9.0)
    grid-corrections-idb/ תיקוני גריד ידניים, לפי content‑hash — לא בתוך מטמון הניתוח (v0.8.23)
    genre-overrides-idb/ override ז'אנר ידני — חנות ישנה (נתיב) + חנות חדשה (hash) +
                        migrate.ts (מיגרציה חד‑פעמית, v0.4.0)
    layout-idb/         גודל רשימת השירים שהבעלים בחר (v0.9.34)
    clock-audio.ts      Clock יחיד מעל audioContext.currentTime
    capabilities.ts     מה נתמך בסביבה הזו — ה‑UI מתדרדר בחן לפיו

  app/                  React בלבד.
    App.tsx             פריסה + קיצורי מקלדת גלובליים
    state/store.ts      zustand — כל ה‑UI state. patchDeck/patchChannel/patchMixer/set*
    hooks/useRenderLoop.ts   נרשם ל‑Clock ומושך position מהמנוע ל‑store
    components/         TopBar, Deck, Mixer, Library, Waveform, Platter, PadGrid,
                        WaveformOverview (v0.12.0 — פס כל השיר, קיפול ב-core/waveform-overview.ts),
                        controls.tsx (Button/Knob/Fader), KeysScreen (v0.8.24 — מהטבלה ב-core/hints.ts),
                        TaggingScreen (v0.9.0 — מסך התיוג, audio-webaudio/tag-player.ts מנגן),
                        SourceCheckPanel (v0.8.38 — בדיקת BPM/סולם מול Beatport, מתחת לרשימה),
                        LibraryResizeHandle (v0.9.34 — ידית בראש הרשימה; גדולה = בלי פדים),
                        ColumnFilter (v0.9.36 — ה-▾ בכותרות והרשימה שנפתחת, משותף ל-Genre ולשאר)
```

הגבולות נאכפים ע"י `dependency-cruiser` (`.dependency-cruiser.cjs`), לא ע"י מוסכמה —
`npm run check` נכשל על הפרה. imports חוצי‑קבצים דרך alias `@/*`, אף פעם לא `../`.

**הפרה אחת מוכרת שהושארה גלויה בכוונה:** `transport-webmidi/manager.ts` כותב ל‑store
וקורא ל‑`controls.ts` ישירות במקום לפלוט `ControlAction` דרך ה‑port. היא ב‑severity
`warn` כדי שתישאר נראית — לא להעתיק את הדפוס, ולא להשתיק את הכלל.
