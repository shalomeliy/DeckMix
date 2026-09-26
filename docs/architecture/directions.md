# SoundGrid — כיווני ארכיטקטורה ועתיד

מסמך כיוון. **לא spec** — ה‑spec הוא `ROADMAP.md`. כאן יושבים העקרונות ארוכי‑הטווח
שמנחים כל גרסה: איך שומרים על התשתית קלה לשינוי (stack, חומרה, ענן), איך שכבת AI
נכנסת בלי ללכלך את הליבה, ומה הופך את SoundGrid לשונה מ‑Serato / rekordbox.

עודכן: 2026-08-28 (אחרי v0.1.5).

---

## 0. עיקרון‑על: הליבה לא מכירה את הסביבה

> `src/core/` — לוגיקת דקים, מיקסר, timeline, mapping, סנכרון — נכתבת ב‑TypeScript
> טהור. **אפס `import` של `react`, DOM, `AudioContext`, Web MIDI, File System Access.**
> כל דבר תלוי‑פלטפורמה יושב מאחורי interface שמוגדר ב‑`core/` וממומש ב‑`platform/`.

למה: אם הליבה נקייה, החלפת stack (React→משהו אחר), פלטפורמה (web→Tauri→controller
מובנה), או backend (Web Audio→native) הופכת מ"כתיבה מחדש" ל"כתיבת adapter".

היום `controls.ts` כבר עושה חצי מזה — choke point יחיד שכל פעולת משתמש עוברת בו,
משותף ל‑UI ול‑MIDI. המסמך הזה מרחיב את הדפוס לכל שאר התפרים.

### מבנה יעד (מתגבש בהדרגה, לא רפקטור גדול חד‑פעמי)

```
src/
  core/                  ← TS טהור, בדיק, בלי פלטפורמה
    deck/                מודל דק: מיקום, tempo, loops, cues (בלי אודיו ממשי)
    mixer/               crossfader, ערוצים, routing כמודל
    timeline/            beatgrid, phrases, quantize
    clock/               רשות זמן אחת (ראה §2)
    mapping/             ControlAction, parseMessage (כבר קיים ב‑midi/)
    ports/               ה‑interfaces: AudioBackend, TrackSource, Analyzer,
                         Persistence, ControlTransport, AIProvider, Clock
  platform/
    audio-webaudio/      מימוש AudioBackend מעל Web Audio  (engine.ts היום)
    audio-native/        (עתידי) מעל Tauri + ASIO/CoreAudio
    source-fsaccess/     מימוש TrackSource מעל File System Access (library.ts היום)
    transport-webmidi/   מימוש ControlTransport מעל Web MIDI (manager.ts היום)
    transport-webhid/    (עתידי)
    persist-idb/         מימוש Persistence מעל IndexedDB
    analyzer-js/         מימוש Analyzer ב‑JS  (analyze.ts היום)
    analyzer-wasm/       (עתידי)
  app/                   React, zustand store, hooks, components  ← מותר לו הכל
  controls.ts            נשאר ה‑choke point. מקבל core + platform, חושף פעולות
```

אכיפה: `dependency-cruiser` ב‑CI שנכשל אם `core/**` מייבא `react` / `react-dom` /
`*.tsx` / DOM globals.

---

## 1. התפרים (ports) — להגדיר עכשיו, לממש בהדרגה

| Port | היום | swaps עתידיים | סטטוס |
| --- | --- | --- | --- |
| **`AudioBackend`** | Web Audio קשיח ב‑`engine.ts`/`deck.ts`, tempo כ‑`playbackRate` גולמי (משנה pitch) | AudioWorklet + WASM DSP — מועמד קונקרטי ל‑key‑lock: [Rubber Band](https://github.com/breakfastquay/rubberband) WASM (v0.9, ראה `ROADMAP.md`) · native ASIO/CoreAudio ב‑Tauri · WebGPU mixing | ⬜ interface ב‑v0.1.6 |
| **`TrackSource`** | File System Access ב‑`library.ts` | URL · ספק ענן (OAuth) · locker אופליין (Cache API) · stems כמקור | ⬜ interface ב‑v0.1.6, מקורות נוספים v0.15 |
| **`ControlTransport`** | Web MIDI בלבד (`transport-webmidi/manager.ts`) | WebHID · Bluetooth MIDI · WebSerial · OSC · טלפון/רשת כשלט | ⬜ הפרדת צד‑קלט ב‑v0.1.6 |
| **`Analyzer` + `AnalysisCache`** | `detectBeatGrid` (`analyze.ts` + `core/beatgrid.ts`, v0.3.0) — bpm+phase, עדיין ניחוש מבוסס autocorrelation | WASM · WebGPU · שירות מרוחק · מודל ML למבנה/סולם | ⬜ interface v0.1.6, cache v0.4 |
| **`Clock`** | `audioContext.currentTime` פזור בקוד | Ableton Link · MIDI clock · שעון מערכת | ⬜ v0.1.6 (ראה §2) |
| **`Persistence`** | `idb-keyval` נקודתי | SQLite ב‑Tauri · sync ענן · ייצוא/ייבוא JSON נייד | ⬜ repository דק v0.1.6 |
| **`Capabilities`** | בדיקות ad‑hoc (`setSinkId`?) | — | ⬜ אובייקט אחד v0.1.6 |
| **`AIProvider`** | `core/ports/ai.ts`: `chat()`/tool-calling + `suggest()` — `platform/ai-mock/` (v0.5.5 שלב 1, מדומה, לבדיקות בלבד) · `platform/ai-local/` (שלב 2, `@huggingface/transformers`, `device:'auto'` — גרפי אם יש, מעבד אם אין) הוא `activeAiProvider` בפועל | מפתח API של המשתמש · self‑hosted | 🔶 שני המימושים קיימים; `ai-local` לא אומת מקצה־לקצה בסביבה הזו — הרשת שלה חסומה ל‑huggingface.co (ר' `HANDOFF.md`) |

### `AudioBackend` — סקיצת interface

```ts
interface AudioBackend {
  init(caps: Capabilities): Promise<void>
  decode(data: ArrayBuffer): Promise<DecodedAudio>        // buffer + sampleRate
  deck(id: DeckId): DeckBackend
  mixer: MixerBackend                                     // crossfader, master, cue
  listOutputs(): Promise<AudioOutput[]>
  setOutput(deviceId: string | null): Promise<'ok'|'unsupported'|'denied'>
  readonly capabilities: { multichannel: boolean; worklet: boolean }
}
interface DeckBackend {
  load(a: DecodedAudio): void
  play(): void; pause(): void; seek(sec: number): void
  setTempo(t: number): void; setKeyLock(on: boolean): void
  setLoop(start: number, end: number | null): void
  setEq(band: 'low'|'mid'|'high', v: number): void; setFilter(v: number): void
  setVolume(v: number): void; setCueMonitor(on: boolean): void
  readonly position: number                               // sample‑accurate
}
```

`engine.ts` ו‑`deck.ts` הנוכחיים הופכים ל‑`platform/audio-webaudio/` שמממש את זה.
שום קוד ב‑`core/` או `app/` לא נוגע ב‑`AudioContext` ישירות.

---

## 2. רשות זמן אחת (`Clock`)

בעיה נפוצה ב‑DJ software: כמה מקורות זמן שלא מסכימים (audio context, `performance.now`,
render loop, MIDI clock). כל סנכרון, quantize, beat‑jump, ו‑FX מתוזמן‑ביט חייבים
להיגזר ממקור **אחד**.

```ts
interface Clock {
  now(): number                          // שניות, מונוטוני
  readonly source: 'audio' | 'link' | 'midi' | 'system'
  schedule(atSec: number, fn: () => void): Cancel
  subscribe(onTick: (t: number) => void): Cancel   // מזין את useRenderLoop
}
```

היום: מימוש יחיד מעל `audioContext.currentTime`. עתיד: מימוש Ableton Link נכנס בלי
לגעת בשום צרכן — אבל **רק אחרי Tauri** (הוחלט 14/09, `ROADMAP.md` post‑1.0): Link
דורש UDP multicast שדפדפן לא יכול לפתוח, אז המימוש חייב קוד native. `useRenderLoop`
נרשם ל‑`clock.subscribe` במקום rAF ישיר.

---

## 3. Capabilities — התדרדרות בחן

```ts
interface Capabilities {
  audioWorklet: boolean          // AudioWorklet → DSP כבד, key‑lock
  webgpu: boolean                // stems בזמן אמת, waveform WebGL
  webmidi: boolean               // קונטרולרים
  webhid: boolean                // קונטרולרים שהם HID
  fsAccess: boolean              // ספרייה מקומית
  setSinkId: boolean             // ניתוב פלט לכרטיס ספציפי
  sharedArrayBuffer: boolean     // threads ל‑DSP/analysis
  offscreenCanvas: boolean       // רינדור waveform ב‑worker
}
```

מחושב פעם ב‑boot, נשמר ב‑store, ה‑UI קורא ממנו. חוק: **אף פיצ'ר לא קורס** אם
capability חסר — הוא מוסתר או עובד ב‑fallback (למשל: אין `setSinkId` → הנחיה
להגדיר את הכרטיס כ‑default מערכת; אין `webgpu` → stims רק offline עם מטמון).

---

## 4. שכבת AI — אופציונלית, model‑agnostic, דרך `controls.ts`

### כללי ברזל

1. **האפליקציה עובדת מלא בלי AI.** dark launch, אין תלות, אין דגרדציה אם כבוי.
2. **model‑agnostic.** `AIProvider` interface. מימושים: מקומי (WebGPU/WASM),
   מפתח API של המשתמש (Claude / אחר), self‑hosted. **אף פעם לא לקבע מודל בקוד.**
   פרומפטים ו‑skills = קבצי דאטה ב‑`ai/prompts/`, ניתנים לעריכה.
3. **ניזונה מאותו stream** של state + אירועים שכבר קיים (store + ControlAction log).
4. **פולטת דרך `controls.ts` בלבד.** הצעה/פעולה של AI = אותו `ControlAction`
   שכפתור או MIDI היו פולטים. אף פעם לא עוקפת את ה‑choke point. זה מה שהופך
   שליטה‑בשפה‑טבעית ל"כמעט חינם": שכבה שממירה טקסט → `ControlAction[]`.
5. **פיצ'רים אודיו** (embeddings, stems, מבנה, סולם) — מחושבים פעם דרך `Analyzer`,
   נשמרים ב‑`AnalysisCache` לפי hash תוכן, ניידים בין מכשירים.

### סקיצת interface

מומש בפועל ב-`core/ports/ai.ts` (v0.5.5) — שתי צורות זו לצד זו, לא אחת שמחליפה את השנייה:
`suggest()`/`AISuggestion` לתרחישי הצעה פסיבית ומדורגת (v0.9.25/v0.13.5, עדיין לא בנויים),
`chat()`/tool-calling לתרחיש שיחה+הבהרה (v0.5.5, בשימוש בפועל). `Msg`/`ToolDef`/`ChatChunk`
בסקיצה הישנה כאן הם `AIMessage`/`AIToolDef`/`AIChatChunk` בקוד עצמו.

```ts
interface AIProvider {
  readonly kind: 'local' | 'byo-key' | 'self-hosted'
  readonly capabilities: ('chat'|'embed-audio')[]
  suggest(prompt: string, context: unknown): Promise<AISuggestion[]>
  chat(msgs: AIMessage[], tools?: AIToolDef[]): AsyncIterable<AIChatChunk>
  /** רק ספק שצריך הורדה/אתחול חד-פעמי (מודל מקומי) מממש את זה */
  load?(onProgress: (pct: number) => void): Promise<void>
}
```

### תרחישים (ממופים לגרסאות ב‑ROADMAP)

- **NL / קול → פעולות** ("לופ על הדרופ 8 תיבות") — שכבת translate ל‑`ControlAction`. v0.5.5
- **קו‑פיילוט מיקס חי** — הצעת טראק הבא, אזהרת התנגשות הרמונית, "האנרגיה יורדת". v0.13.5
- **מצב קואצ'ינג** — ביקורת על drift בתזמון, התנגשויות EQ, מעברים חדים, gain
  staging. בזמן אמת (נדנוד עדין) + סיכום אחרי סט. v0.9.25
- **חיפוש סמנטי בספרייה** — embeddings על האודיו, "טראקים שנשמעים כמו זה". v0.8.5
- **מיפוי קונטרולר בהדגמה / מצילום** — v0.11 (עורך המיפוי) + עוזר AI

---

## 5. מה שונה מ‑Serato / rekordbox

מדורג לפי (אימפקט × ייחוד × בר‑מימוש בטווח קצר):

### ארכיטקטורה (בר‑מימוש עכשיו, לא ML)

1. **מקומי לגמרי, בלי חשבון, בלי נעילת ענן.** ספרייה / cues / grids ב‑JSON נייד,
   git‑friendly, עובד אופליין לנצח. Serato ו‑rekordbox דוחפים מנויים וענן.
2. **פתוח וסקריפטבילי.** `controls.ts` כ‑API ציבורי + מערכת plugins: pad modes
   מותאמים, FX קהילתיים, סקריפטים. אף אחד מהשניים לא באמת extensible. (v0.11.5)
3. **web‑native.** אפס התקנה לנסות, שיתוף סט כלינק, הטמעת דק בדף.
4. **ספרייה עם היסטוריית גרסאות.** ה‑cues/grids ב‑JSON — diff לשינויים ב‑crate.

### AI (תלוי מחקר, אבל זה ה‑moat האמיתי)

5. **מצב אימון/קואצ'ינג** — אין לזה מקבילה טובה בשוק. ענק ל‑DJ שלומד.
6. **קו‑פיילוט מיקס חי** — לא auto‑mix, אלא הצעות בזמן אמת.
7. **חיפוש סמנטי על האודיו** — מעבר לתגיות.
8. **stems בזמן אמת על המכשיר (WebGPU)** — בלי מנוי, בלי ענן.
9. **שליטה בשפה טבעית + קול** — hands‑free performance.
10. **מיפוי קונטרולר בהדגמה / מתמונה.**

### ביצוע

11. **מודעות‑מבנה בכל מקום** — לופים נעולי‑פרייז, "קפוץ לדרופ הבא", auto‑cue
    בגבולות פרייז.
12. **B2B מרחוק ב‑WebRTC** — שני DJ, חדרים שונים, session משותף.

> הערכה מפוכחת: 1–4 ו‑11 הם עבודת ארכיטקטורה — ודאיים. 5–10 קשים ותלויי איכות
> מודלים; לתכנן אותם כ"אופציונלי, משתפר עם הזמן", לא כהבטחה.

---

## 6. חומרה — על מה להריץ

- **Web (Chromium desktop)** — היעד היום.
- **PWA** — התקנה + אופליין (v1.0).
- **Tauri (Win/Mac/Linux)** — גישת אודיו native (ASIO/CoreAudio), `libusb` לקונטרולרים,
  SQLite. **המשתמש רוצה גרסאות דסקטופ ל‑Windows + Mac** (ראה `serato-formats.md` §4
  — Serato עצמה = Qt6/C++/ASIO/libusb, אין דרך אחרת ל‑latency רציני).
- **מסך מובנה בקונטרולר** — חלק מהקונטרולרים מריצים Android/Linux עם דפדפן. אם
  ה‑build הוא SPA סטטי טהור בלי תלות שרת, זה "כמעט חינם".
- **טאבלט** — v0.17 (מגע, פאנלים).

מה שומר על זה פתוח: **אפס תלות שרת בזמן ריצה.** הכל SPA סטטי. כל "שירות" (ניתוח
מרוחק, AI, sync) הוא אופציונלי ומאחורי interface.

---

## 7. מה עושים עכשיו

1. **לסיים v0.1.5** — ליטוש ויזואלי.
2. **v0.1.6 "seams"** — התפרים מ‑§1 (Audio, ControlTransport, Capabilities, Clock,
   Persistence, Analyzer — interfaces + העברת הקוד הקיים למאחוריהם). ~יום‑יומיים.
   קריטי לפני v0.2 (jog) ו‑v0.7 (FX) שנוגעים ישירות ב‑audio backend.
3. **חוק קבוע ב‑HANDOFF** — "core/ בלי react/dom; תלות פלטפורמה מאחורי port;
   AI פולט דרך controls.ts בלבד".
