# PLAN v0.8.9 — ייצוא בנק סאמפלר עם הקלטות ("אסוף והעתק")

מקור: `workshop-output/FEATURE_SPEC_SAMPLER_EXPORT.md` (מאושר 22/09, כולל הכרעת ההתנגשות:
לשאול דריסה-או-שם-אחר). לאחר אישור: להעתיק ל-`workshop-output/PLAN_SAMPLER_EXPORT.md`,
ענף `feat/v0.8.9-sampler-bank-recordings` מ-`main`, ורק אז קוד.

## Context

`exportSamplerBank`/`importSamplerBank` (`src/controls.ts:1835-1935`) שומרים רק JSON —
סלוט מוקלט חי (v0.7.5, Blob ב-IndexedDB) מדולג במפורש ורק נספר בהודעה. חוב מ-`HANDOFF.md`.
הגרסה הזו מוסיפה מצב ייצוא שני שמעתיק גם את קובצי ה-WAV לתיקייה שהבעלים בוחר.

## מה נמצא בקוד (מאומת)

- `src/platform/sampler-idb/store.ts`: `StoredSamplerSlot{contentHash?, recordingId?,
  trackName, bpm?, mode, gain, syncEnabled}`, `StoredSamplerBank`; `exportSamplerBankToFile`/
  `importSamplerBankFromFile` — JSON בלבד היום, `showSaveFilePicker`/`showOpenFilePicker`.
- `src/platform/sampler-recordings-idb/store.ts`: `saveRecordingBlob`/`getRecordingBlob`/
  `deleteRecordingBlob` — Blob תמיד `audio/wav`, מפתח `recordingId` (uuid).
- `src/platform/recorder-fsaccess/writer.ts`'s `saveSplitMasterRecording` — התקדים המדויק:
  `showDirectoryPicker({mode:'readwrite'})` + `dir.getFileHandle(name,{create:true})` בלולאה.
- `src/controls.ts:1362-1402` `resolveSamplerSlots` — **כבר** מטפל בכשל חלקי: סלוט עם
  `recordingId` שה-Blob שלו חסר/פגום נספר כ-`recordingFailed` ומוצג בהודעה, שאר הבנק ממשיך.
  **אין צורך לבנות מנגנון חדש לזה** — רק לוודא שהמסלול החדש (כתיבת blob חדש ל-IndexedDB
  בייבוא) עובר דרך אותו `resolveSamplerSlots`/`patchSamplerSlot`.
- `src/controls.ts:1835-1876` `exportSamplerBank` — כבר סופר `recordedCount` ומציג הודעה.
- `src/app/components/Settings.tsx:329-358` `SamplerBankIO` — שני כפתורים היום, קריאה ל-
  `ctl.exportSamplerBank()`/`ctl.importSamplerBank()`. `caps.fsAccess` נקרא בכל מקום כ-
  `useStore((s) => s.capabilities)` (ר' `SystemPanel` באותו קובץ, שורה 368).
- `showDirectoryPicker` קיים ב-`window` רק כש-`caps.fsAccess` true (`platform/capabilities.ts:19`).

## העיצוב

### 1. מודול פלטפורמה חדש: `src/platform/sampler-bank-fsaccess/store.ts`

לא הרחבת `sampler-idb`/`recorder-fsaccess` — כל אחד נשאר באחריות אחת (IndexedDB / כתיבת
בייטים שהאפליקציה הרגע הקליטה), זה תזמור readIDB→writeDisk+manifest.

```ts
interface BankManifest { version: 2; bank: StoredSamplerBank; recordings: { recordingId: string; fileName: string }[] }

export async function exportSamplerBankWithRecordings(
  bank: StoredSamplerBank,
  getBlob: (id: string) => Promise<Blob | undefined>,
): Promise<'ok' | 'cancelled'>

export async function importSamplerBankWithRecordings(
  saveBlob: (id: string, blob: Blob) => Promise<void>,
): Promise<{ bank: StoredSamplerBank; recordingsFound: number; recordingsMissing: number } | 'cancelled'>
```

(`getBlob`/`saveBlob` מוזרקים מ-`controls.ts` כדי ש-`sampler-recordings-idb` לא ייקרא
משני מקומות בפלטפורמה — `platform/` → `platform/` ישיר מותר, אבל כך התלות אחידה עם שאר
הקובץ החדש, שכל שאר הקלט/פלט שלו הוא File System בלבד.)

**ייצוא (`exportSamplerBankWithRecordings`):**
1. פילטר `bank` לסלוטים עם `recordingId` (סלוטי `contentHash` לא נוגעים כאן, נכנסים
   ל-JSON כרגיל — כבר קורה, לא שינוי).
2. שם בסיס = `'soundgrid-sampler-bank'`. בונים את רשימת השמות: `<base>.json` +
   `<base>-rec-<recordingId>.wav` לכל סלוט מוקלט.
3. `showDirectoryPicker({mode:'readwrite'})`. `AbortError` → `'cancelled'`.
4. **בדיקה מקדימה**: לכל שם, `dir.getFileHandle(name, {create:false})` — אם מצליח (קובץ
   קיים) יש התנגשות. אם יש ≥1 התנגשות: `window.confirm('A file named "<name>" already
   exists in this folder. Overwrite it? Click Cancel to pick a different name instead.')`
   (השם הראשון שהתנגש, לא כל הרשימה — שלום מחליט פעם אחת לכל הרצה).
   - `true` → ממשיכים לכתיבה עם השם הנוכחי, דריסה מכוונת.
   - `false` → `window.prompt('Pick a different name:', base)`. ריק/`null` → `'cancelled'`.
     שם חדש → חוזרים לשלב 2 עם השם החדש (עד שאין התנגשות או שהמשתמש מבטל).
5. כותבים: כל WAV (`getBlob(recordingId)` → `blob.arrayBuffer()` → `writable.write`), ואז
   ה-JSON (`{version:2, bank, recordings}`) — JSON אחרון, כדי שקובץ מניפסט לא יצביע על
   WAV-ים שעדיין לא נכתבו אם התהליך נקטע (best-effort, לא טרנזקציה אמיתית — FS Access
   אין לה rollback, מתועד כהערה בקוד, לא כבאג).
6. מחזיר `'ok'` + כמה סלוטים נאספו בפועל (Blob חסר ב-IndexedDB ברגע הייצוא עצמו — נדיר,
   נספר בנפרד, לא עוצר את השאר).

**ייבוא (`importSamplerBankWithRecordings`):**
1. `showDirectoryPicker({mode:'read'})`. חיפוש קובץ `.json` יחיד בתיקייה (אם אין/יש כמה
   — שגיאה מפורשת, לא ניחוש). קורא ומפענח `BankManifest`; `version !== 2` או `bank` לא
   מערך → שגיאה (כמו `importSamplerBankFromFile` היום).
2. לכל רשומה ב-`recordings`: `dir.getFileHandle(fileName)` → אם נכשל, נספר
   `recordingsMissing` **ולא עוצר** (המניפסט הוא רשימת כוונה, לא הבטחה). אם הצליח:
   `getFile()` → `Blob` → `saveBlob(recordingId, blob)` (כותב ל-IndexedDB **תחת אותו
   recordingId שכבר במניפסט** — אין צורך ליצור id חדש, וזה מה שמאפשר ל-
   `resolveSamplerSlots` הקיים לפתור את הסלוט בלי שינוי).
3. מחזיר את ה-`bank` הגולמי + הספירות. **לא** קורא ל-`resolveSamplerSlots` בעצמו — זה
   נשאר באחריות `controls.ts`, כמו הייבוא הקיים.

### 2. `src/controls.ts`

- `exportSamplerBank` נשאר **בדיוק כמו היום** (JSON בלבד) — לא נוגעים.
- פונקציה חדשה `exportSamplerBankWithRecordings()`: כמו `exportSamplerBank` אבל בונה
  `bank` **בלי** להשמיט `recordingId` (בניגוד לשורה 1847 הקיימת), קורא למודול החדש עם
  `getRecordingBlob`, הודעה: `"Sampler bank + N recording(s) saved."` /
  `"Sampler bank saved — M of N recordings could not be collected (missing from storage)."`
  אם יש פער בין `recordedCount` לכמה שנאספו בפועל.
- פונקציה חדשה `importSamplerBankWithRecordings()`: מנקה סלוטים (כמו `importSamplerBank`
  היום), אותה סניטציה (`isSamplerMode`, `gain` clamp, `invalid` count), שומר כל blob
  שהוחזר דרך `saveRecordingBlob`, `saveSamplerBank`, **קורא ל-`resolveSamplerSlots()`**
  (לא `{silent:true}`) — זה כבר מדווח `recordingFailed`/`unresolved` בעצמו. הודעה נוספת
  משולבת: "Sampler bank imported — N recordings restored" (+ `invalid`/`recordingsMissing`
  אם > 0, אותו ניסוח כמו הקיים).

### 3. `src/app/components/Settings.tsx` — `SamplerBankIO`

- `const caps = useStore((s) => s.capabilities)`, `const recordedCount = useStore((s) =>
  s.sampler.slots.filter((sl) => sl.recordingId).length)`.
- כפתור שלישי, מוצג רק כש-`caps.fsAccess`: `"Export bank + recordings (N)"` — `disabled`
  (לא נעלם) כש-`recordedCount === 0`, עם `title` שמסביר "No recordings in this bank".
  קורא `ctl.exportSamplerBankWithRecordings()`.
- כפתור רביעי (Import from folder), מוצג רק כש-`caps.fsAccess`, קורא
  `ctl.importSamplerBankWithRecordings()`.
- טקסט התיאור למעלה מתעדכן: מזכיר שהקלטות דורשות את הכפתור השני.

### מה **לא** בגרסה הזו

בחירה בין "החלף/מזג" בייבוא לבנק מלא — נשאר כמו היום (מנקה הכל). קליטת WAV שנוסף ידנית
בלי להופיע במניפסט. שינוי ל-`contentHash` (סלוטי ספרייה) — לא נוגעים.

## קבצים

חדש: `src/platform/sampler-bank-fsaccess/store.ts` (+ טסט). עורכים: `src/controls.ts`,
`src/app/components/Settings.tsx`. סגירה: `package.json`+lock → 0.8.9, `HANDOFF.md`,
`ROADMAP.md` (v0.8.9 → ✅), `docs/handoff/v0.8.9.md`.

## בדיקות

- **`sampler-bank-fsaccess`:** קשה לבדוק ב-vitest (File System Access לא קיים ב-jsdom) —
  לחלץ פונקציה טהורה קטנה לבדיקה: `buildManifestNames(base, bank)` → רשימת שמות
  צפויה, ו-`nextCandidateName` (מה שקורה אחרי prompt). אלה ייבדקו ב-`tests/core` או
  ליד המודול; שאר הפונקציה (IO אמיתי) לא ניתנת ל-unit test, כמו `writer.ts` היום (אין לו
  קובץ טסט — נבדק ידנית בלבד, תקדים קיים).
- **`controls.ts`:** אין היום טסט ל-`exportSamplerBank`/`importSamplerBank` (משתמשים
  ב-store/engine חיים) — לא מוסיפים כאלה כאן, עקבי עם הקיים.
- **רגרסיה:** `exportSamplerBank`/`importSamplerBank` הרגילים (JSON) לא משתנים כלל —
  בדיקה ידנית שהם עדיין עובדים כמו היום.

## אימות

1. `npm run check` ירוק.
2. **ידני, ע"י שלום (File System Access לא נגיש ל-Browser pane):** להקליט על פאד → "Export
   bank + recordings" → תיקייה חדשה → לוודא JSON+WAV נוצרו → למחוק/לנקות את הבנק (או
   בתיקייה/מחשב אחר) → "Import from folder" מאותה תיקייה → הפאד מנגן. מקרה שני: לבחור
   שוב אותה תיקייה (שם קיים) → לוודא שהדיאלוג "Overwrite?" קופץ, לבדוק את שני המסלולים
   (דריסה, ושם אחר).
3. `change-reviewer` על ה-diff.
4. `context_check.py` בסוף.

## הוראות בדיקה לשלום (בעברית, בסוף)

מקליטים על פאד סאמפלר, פותחים Settings, לוחצים "Export bank + recordings" ובוחרים תיקייה
חדשה. בתיקייה אמורים להיות קובץ JSON וקובץ WAV. לוחצים שוב על אותו כפתור לאותה תיקייה —
אמור לקפוץ דיאלוג ששואל דריסה או שם אחר. סימן שבור: הכפתור לא מגיב, או שאין WAV בתיקייה
בכלל, או שדריסה/שם-אחר לא באמת קורים.

## סיכונים

- **אין rollback אמיתי ל-File System Access** — ייצוא שנקטע (למשל הדפדפן קרס) יכול
  להשאיר תיקייה עם חלק מה-WAV-ים בלי JSON. מתועד כהערה, לא "באג" — v0.7.5's
  `saveSplitMasterRecording` באותו מצב בדיוק, ולא תוקן שם.
- **`window.confirm`/`window.prompt` חוסמים** (כמו ב-`CratesRail.tsx` כבר) — עקבי עם
  התקדים הקיים בפרויקט, לא סטייה.
