# PLAN v0.8.10 — שירים שכבר ניגנו יורדים בהצעות ומסומנים

מקור: `workshop-output/FEATURE_SPEC_SUGGEST.md` (מאושר 20/09). אחרי אישור התוכנית הזאת
הצעד הראשון הוא להעתיק אותה ל-`workshop-output/PLAN_SUGGEST.md` (כמו התקדים
`PLAN_BARSYNC.md`), ורק אז קוד.

## Context

ההצעות (`mixRecommendations`) מתעלמות ממה שכבר ניגנת הערב. שיר שנטען לדק לפני חצי שעה
מוצע שוב כאילו חדש. ההיסטוריה קיימת (`store.history`, בזיכרון בלבד, נשמרת מ-v0.8.3) ולא
מחוברת. הגרסה הזאת מחברת אותה, **בלי לשנות את הבחירה עצמה** (שער BPM/סולם נשאר).

## מה נמצא בקוד (מאומת)

- `src/core/recommend.ts` — `mixRecommendations(decks, tracks, excludeIds?)`, טהור. מחזיר
  `{matches: Map<id, MixMatch>, noBpmSkipped, reason}`.
- `src/app/components/Library.tsx:151-183` — ה-memo של ההצעות. סלקטור פרימיטיבים בלבד
  (אזהרה: לא להוסיף שדות שזזים ב-frame-rate). `history` מתועד ב-`store.ts:154-167` כ"רק
  `history.length` או `getState()` פעם אחת".
- `Library.tsx:584-591` — בניית `list`: `ctl.sortedFilteredTracks()` ואז, ב-`mixOnly`, סינון
  ל-`recs.has(id)`. **היום ההצעות לא ממיינות כלום** — הן רק מסמנות ומסננות.
- `Library.tsx:726-736` — התג הקיים `N skipped · no BPM` (התבנית להעתקה לתג החדש).
- `Library.tsx:1145-1225` — `matchTitle` + הנקודה + `sr-only`. משם נגזר הסימן החדש.
- `Track.contentHash` עצל (`core/types.ts:38`); `HistoryEntry.contentHash` תמיד קיים.
- **גילוי:** ל-`Track` כבר יש `lastPlayedAt` (v0.8.0, נשמר בין סשנים לפי hash). **לא**
  משתמשים בו: ההחלטה של שלום (13/09) שההיסטוריה היא סשן בלבד, ו"ניגן הערב" ≠ "ניגן פעם".
- שפת הרכיב: מחרוזות `Library.tsx` באנגלית (`mixable`, `skipped · no BPM`). **נשארים
  באנגלית כדי להתאים** (`HANDOFF.md` מדבר על עברית — אם רוצים לתרגם, זו גרסה נפרדת).

## העיצוב

### 1. `core/recommend.ts` (טהור)

- פרמטר רביעי אופציונלי: `context?: { playedHashes?: ReadonlySet<string> }`.
- `MixMatch` מקבל `played?: boolean` (מוגדר רק כשיש `context`).
- `MixRecommendations` מקבל `playedCount` ו-`unverifiedAgainstHistory`:
  - שיר עם `contentHash` שנמצא ב-`playedHashes` → `played: true`, נספר ב-`playedCount`.
  - שיר **בלי** `contentHash` (עדיין לא נטען/נותח) → אי אפשר לדעת; נספר ב-
    `unverifiedAgainstHistory` (לא מדלגים בשקט).
  - שני קבצים עם אותו hash — שניהם `played` (מתועד כהתנהגות ידועה).
- **בלי `context` (או סט ריק) הפלט זהה בייט-בייט להיום** — זה קריטריון קבלה ובדיקה.
- ההצעה נשארת ב-`matches` גם כשהיא `played`. `strong`/`keyMatch` לא משתנים.

### 2. `Library.tsx`

- `historyLen = useStore(s => s.history.length)` (פרימיטיב, בטוח). ה-memo בונה
  `playedHashes` מ-`useStore.getState().history` ומעביר כ-`context`; `historyLen` נכנס
  למערך התלויות (עם הערת eslint כמו של `recentlyRemovedTick`).
- מצב מקומי `hidePlayed` (`useState(false)`, כמו `mixOnly` — פילטר תצוגה, לא הגדרה).
- בניית `list` בענף `mixOnly` (ורק שם, ורק כש-`library.sortKey == null`, כלומר שלום לא
  בחר מיון בעצמו — מיון ידני מנצח): מיון **יציב** — לא-ניגן לפני ניגן. עם `hidePlayed`
  ה-`played` מסוננים החוצה.
- תג בסרגל הכלים ליד `skipped · no BPM`, רק כש-`playedCount > 0`:
  `N played` — לחיצה מחליפה בין "מורד" ל"מוסתר" (`aria-pressed`). כש-`hidePlayed` פעיל
  הטקסט אומר במפורש `N hidden`. **אין תג `0`.**
- תג נוסף, רק כש-`unverifiedAgainstHistory > 0` **וגם** `history.length > 0`:
  `N not checked against set history` (עם title שמסביר: "לא נטען עדיין, אין hash").
- שורה: סימן `✓` קטן בתא הראשון (אות בתיבה בסגנון v0.8.2, **לא שקיפות**), עם
  `aria-label`/`title` "Played this set", ומצטרף ל-`matchTitle` ולטקסט ה-`sr-only`.
- הודעת ריק: אם כל ההצעות `played` והן מוסתרות, הודעה מפורשת (לא מסך ריק) — מכוסה
  ב-`libraryEmptyCopy` הקיים.

### 3. Hint mode

- מזהה חדש ב-`src/core/hints.ts` לתג ולסימן (משפט אחד כל אחד, אנגלית כמו השאר) +
  `HintIcon` ליד התג. לבדוק אם `tests/repo/` דורש שכל hint id מוצג/קיים.

### מה **לא** בגרסה הזאת (נשאר ל-v0.8.11+)

מדרגות "חזק/חלש" כמיון, ציון, משפטי סיבה, אנרגיה, embeddings, זיכרון זוגות.

## קבצים

עורכים: `src/core/recommend.ts`, `src/app/components/Library.tsx`, `src/core/hints.ts`,
`tests/core/recommend.test.ts`. בסגירה: `package.json` + `HANDOFF.md` ("גרסה נוכחית") +
`ROADMAP.md` (שורת v0.8.10 ✅), `docs/handoff/v0.8.10.md`. `CLAUDE.md`/`CLAUDE-HE.md` לא
משתנים.

## בדיקות (`tests/core/recommend.test.ts`, בסגנון הקיים)

1. בלי `context` ≡ הפלט של היום (אותם `matches`, אותו `noBpmSkipped`).
2. `playedHashes` ריק ≡ בלי `context`.
3. שיר עם hash ב-`playedHashes` → `played: true`, נשאר ב-`matches`, `strong` לא השתנה.
4. שיר בלי `contentHash` → נספר ב-`unverifiedAgainstHistory`, לא `played`.
5. שני tracks עם אותו hash → שניהם `played`, `playedCount` = 2 (מתועד).
6. שיר `played` תואם-במיוחד עדיין ב-`matches` (לא נבלע).
7. דטרמיניזם: שתי קריאות זהות → `matches` באותו סדר.

לוגיקת המיון/הסתרה ב-`Library.tsx` תיגזר לפונקציה טהורה קטנה (`orderMixList` — לא
ניתנת לבדיקה אם נשארת בתוך ה-JSX) בתוך `recommend.ts`, ותקבל בדיקות: יציבות, מיון ידני
מנצח, הסתרה.

## אימות

1. `npm run check` ירוק (`tsc -b` + `oxlint` + `depcruise` + `vitest`).
2. **באפליקציה, `localhost:5173`** (השרת שכבר רץ אצל שלום): ספרייה נטענת → לטעון שיר X
   לדק A ולנגן, לטעון Y לדק B → ב-Mix Only: X/Y לא ברשימה (על הדקים), ובלחיצה על החלפה
   ולטעינה חוזרת — רואים תג `N played`. `javascript_tool` למדידת DOM: מספר שורות עם
   `aria-label="Played this set"`, סדר השורות, ו-`read_console_messages` בלי שגיאות.
   *הערה:* Browser pane לא נותן להרים את הספרייה בלי מחוות משתמש. אם אי אפשר לטעון
   ספרייה בפאנל, האימות באפליקציה נעשה ע"י שלום ב-Chrome שלו — והבדיקות הטהורות הן
   ההוכחה שנרשמת.
3. סקירה עצמאית: `change-reviewer` על ה-diff.
4. `python scripts/context_check.py` בסוף.

## הוראות בדיקה לשלום (יימסרו בעברית בסוף)

פותח את הספרייה, מנגן שיר מדק A, טוען שיר אחר לדק B; מחליף אחד מהם בשיר שלישי. בטבלה
מסמנים "Mix Only": השיר שהוצא מהדק מופיע עם ✓ בתחתית הרשימה, ובסרגל תג `1 played`.
לחיצה על התג מעלימה אותו וכתוב `1 hidden`. סימן שבור: שיר מסומן ✓ שלא ניגן בכלל, או
תג `played` שמופיע בפתיחה ראשונה, בלי שנטען כלום.

## סיכונים

- **שיר נטען ≠ שיר שהתנגן.** `history` נכתב בכל טעינה (גם בדיקה קצרה, בכוונה — החלטה
  של שלום). לכן "ניגן" משמעו "נטען בסשן". הטקסט הגלוי נשאר `played` (השפה של שלום), וה-
  `title` של התג והסימן אומר במפורש "loaded to a deck this session".
- **`contentHash` עצל** — הפער מוצג בתג ה-`not checked`.
- **קפיצת סדר:** המיון מתעדכן רק כשמשתנה `history.length` או מצב ההצעות (לא כל 5ש',
  כי התוצאה דטרמיניסטית ולכן הסדר לא זז).
