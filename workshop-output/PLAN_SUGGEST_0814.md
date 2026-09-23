# PLAN v0.8.15 — זיכרון זוגות שיר→שיר שדורגו "מצוין"

**מספר גרסה עודכן 23/09:** נבנה תחילה כ-v0.8.14, אבל שיחת Claude נפרדת עבדה במקביל
עלי אותו repo ותפסה את אותו מספר לפיצ'ר אחר (Mix Assist — יישור קו צהוב, Mix-in pad).
שום קוד לא התנגש — רק התיוג. שם הקובץ הזה נשאר עם המספר הישן (`_0814`) כדי לא ליצור
כפילות ורלוונטיות של קישורים; **התוכן והמספר בכותרת מעודכנים ל-v0.8.15**. פרטים:
`HANDOFF.md` → "⚠ לקח 23/09".

מקור: `workshop-output/FEATURE_SPEC_SUGGEST.md` (מאושר 20/09), שלב 3 מתוך 4 של פיצ'ר
ה"הצעות" — v0.8.10 (שירים שכבר ניגנו) ו-v0.8.11 (מדרגות + הסבר) כבר בנויים ובפרודקשן.
השלב הזה תוכנן בספק המקורי כ-v0.8.12, הוזז ל-v0.8.14 ואז ל-v0.8.15 (ROADMAP.md שורה
66-67). ההחלטה המוצרית עצמה (זוגות, לא שיר בודד) כבר אושרה ב-20/09 — הפלואו הזה רק
ממלא את הפרטים שהספק המקורי השאיר פתוחים ("יוגדרו ב-PLAN.md אחרי החלטה 3"), עם שלום,
בשיחה הזאת (22/09).

## Context

היום `mix-ratings-idb` זוכר "בנקודה הזאת ביציאה — עבד טוב", לפי שיר יוצא בלבד. אין זיכרון
של **לְמה** יצאת. הגרסה הזאת מוסיפה: כששיר A עבר בהצלחה ("מצוין") לשיר B, ואחר כך A
מתנגן שוב — B יסומן כ"התאמה מצוינת" בהצעות.

## החלטות מוצר שהתקבלו מהשיחה עם שלום (22/09)

1. **כיוון: חד-סטרי בלבד.** A→B מסומן "מצוין" לא אומר כלום על B→A. אם ההפך גם עבד טוב,
   הוא ייכתב בנפרד כשזה יקרה בפועל (דירוג משלו).
2. **מיקום בתצוגה: פס קבוע מעל הטבלה, לא שינוי סדר.** "התאמות מצוינות" — עד 2-3 שירים,
   קבוע במקום, לא זז, לא צריך לגלול אליו. **הטבלה הרגילה למטה נשארת בדיוק כמו היום** —
   לא מדרגה חדשה, לא שינוי מיון. (שלום דחה במפורש את האפשרות שהפס יזוז/יגדל דינמית —
   "קבוע במקום" היה חלק מהניסוח שאישר.)
3. **לחיצה על הצעה בפס מריצה את המיקס בפועל, לא רק טוענת שיר** — תוספת שנוספה **אחרי**
   שהתוכנית הזו כבר הוצגה לשלום ואושרה בעקרון, ומבטלת במפורש שורה אחת מהלא-מטרות של
   `FEATURE_SPEC_SUGGEST.md` המקורי ("טעינה אוטומטית של שיר — האפליקציה מציעה, שלום
   מחליט"). **הביטול הזה מוגבל לפס "התאמות מצוינות" בלבד** — בטבלה הרגילה לחיצה/דאבל־קליק
   ממשיכים לטעון בלבד, בלי מיקס אוטומטי, בדיוק כמו היום.
   - **הרגע שהמיקס מתחיל: מיד כשלוחצים** (לא ממתין שהשיר המתנגן יגיע לאותה נקודת יציאה
     שהייתה בפעם הקודמת). נקודת היציאה ממשיכה להיות מחושבת חי בדיוק כמו היום
     (`nextCandidateFrom`, ב-`startAutoTransition`) — רק נקודת ה**כניסה** של השיר הנכנס
     היא זו שנשמרת ומשוחזרת.
   - **אם השיר שמתנגן בדק המקור מוחלף בזמן שהשיר השני נטען** (טעינה יכולה לקחת שנייה-
     שתיים) — **המיקס האוטומטי לא מתחיל**, ומוצגת הודעה שהשיר המקורי כבר לא מתנגן. שלום
     בחר במפורש באפשרות "לעצור ולהגיד" על פני "להמשיך בכל מקרה".

## מה נמצא בקוד (מאומת ע"י architecture-expert + קריאה ישירה)

- `src/platform/mix-ratings-idb/store.ts` — `idb-keyval`, מפתח
  `soundgrid:mixratings:<contentHash>`, ערך `number[]` של שניות יציאה. שיר יוצא בלבד.
  `getExcellentPoints` לא זורק, `markExcellent` כן (התקדים לקובץ החדש).
- `src/controls.ts:2764-2783` `finishTransition()` — יודע גם `t.fromDeckId` וגם
  `t.toDeckId` באותו scope, אבל היום קורא רק את `decks[t.fromDeckId].track` לתוך
  `pendingMixRating`. ה-TO track זמין באותו רגע ולא נקרא.
- `src/controls.ts:2827-2842` `rateMixTransition()` — ב-`'excellent'` קורא ל-`markExcellent`
  בלבד, עם `return` שקט אם אין `contentHash` (החלטה קיימת, לא לשנות את ההתנהגות של
  נקודת היציאה עצמה).
- `src/app/state/store.ts:221-226` `pendingMixRating` — טיפוס עם שדות ה-FROM בלבד.
- `src/core/recommend.ts` — טהור. `MixContext.playedHashes?: ReadonlySet<string>`
  (שורה 47) הוא התקדים המדויק מ-v0.8.10: שדה אופציונלי, בלעדיו ההתנהגות זהה להיום.
  `DeckMixState` (שורות 51-59) יש לו `trackId`/`camelot` אבל **אין** `contentHash`.
  `matchReasons` (שורה 192) בונה משפטים בסדר קבוע; `match.played` (שורה 207) הוא
  התקדים לאיך מוסיפים סיבה חדשה.
- `src/app/components/Library.tsx:157-188` — ה-memo שבונה `playedHashes` מ-`history`;
  אותו מקום יבנה גם `excellentPairs`.
- `src/app/state/store.ts:328` — `notice: { text, tone: 'warn'|'info', source } | null`,
  תבנית קיימת להודעה לא-חוסמת (`setNotice`/`clearNotice`, נקרא מ-`controls.ts` בעשרות
  מקומות). זה הכלי הקיים לכלל "לא לדלג בשקט" — לא בונים מנגנון חדש.

## העיצוב

### 1. אחסון חדש — `src/platform/mix-pairs-idb/store.ts` (קובץ חדש)

מבנה זהה בכוונה ל-`mix-ratings-idb/store.ts` (עקרון הפרויקט: קובץ קטן אחד לנושא, לא
מיזוג נושאים קרובים אבל שונים לתוך אותו docstring). הערך כולל גם `entrySec` (נקודת
הכניסה הגולמית של השיר הנכנס, כפי שנבחרה — **לפני** יישור הפאזה החי, בדיוק כמו ש-
`exitPointSec` כבר נשמר גולמי היום) — כדי שלחיצה על ההצעה תדע לאן לקפוץ בשיר הנכנס:

```ts
// מפתח: soundgrid:mixpairs:<fromHash>
// ערך: { toHash: string; entrySec: number }[], ייחודי לפי toHash (רשומה אחרונה מנצחת)
export async function getExcellentFollowUps(fromHash: string): Promise<{ toHash: string; entrySec: number }[]>  // לא זורק
export async function markExcellentPair(fromHash: string, toHash: string, entrySec: number): Promise<void>  // זורק
```

קריאה לפי `from` בלבד (לא מחרוזת מורכבת `"from:to"`) — כי בזמן הצעה יש רק צורך ב"מה בא
טוב אחרי השיר שמתנגן עכשיו", לא בסריקת כל הספרייה. שני reads לכל היותר (דק A + דק B).

### 2. `core/recommend.ts` (טהור)

- `DeckMixState` מקבל `contentHash?: string | null` (לא היה שם — רק `camelot` נוסף בעבר
  להתאמה הרמונית).
- `MixContext` מקבל `excellentPairs?: ReadonlySet<string>`, מפתחות מורכבים
  `` `${fromHash}:${toHash}` `` — נבנה פעם אחת ב-`Library.tsx` ומועבר כ-`Set` שטוח, בלי
  טיפוס מקונן חדש שמגיע ל-`core/`.
- בלולאת המועמדים, אחרי שנבחר `best` (השורה שכבר בוחרת לאיזה דק המועמד מתאים הכי טוב):
  `const excellentPair = context?.excellentPairs?.has(\`${best.contentHash}:${t.contentHash}\`)`.
  נבדק מול `best` (לא מול "איזשהו דק פעיל") כדי שהסיבה תיקרא לשיר הנכון גם כששני הדקים
  מתנגנים.
- `MixMatch` מקבל `excellentPairAfter?: { fromName: string; entrySec: number }` (לא רק
  `boolean` — גם שם השיר היוצא לטקסט "אחרי X: מצוין", וגם `entrySec` כדי שהפס יוכל
  להעביר אותו הלאה ל-`startExcellentPairTransition` בלי לחזור ל-IDB בזמן הלחיצה).
- `matchReasons` מוסיף "excellent pair (after {name})" בסוף הרשימה, אחרי "already loaded
  this set" — אותו עיקרון: משפט קצר, מקור יחיד לטולטיפ/sr-only/שורה נבחרת.
- `matchTier` **לא משתנה** — החלטת שלום: בלי קפיצת מדרגה. הפס החדש הוא ערוץ תצוגה נפרד,
  לא שינוי מיון.
- פונקציה טהורה חדשה וקטנה, `excellentPairSuggestions(tracks, matches, limit = 3):
  Track[]` — מסננת את `matches` ל-`excellentPairAfter != null`, יציבה (סדר `tracks`),
  חתוכה ל-`limit`. זה מה ש-`Library.tsx` מרנדר בפס; אין היגיון תצוגה שלא ניתן לבדיקה
  ב-`core/`.

### 3. `finishTransition` / `pendingMixRating` / `rateMixTransition` (`controls.ts`, `store.ts`)

- `controls.ts:2571-2580` `ActiveTransition` מקבל שדה חדש: `entrySec: number` — הערך
  **הגולמי** שהועבר ל-`startAutoTransition` (הפרמטר `entrySec`, לא `enterSec` המיושר-
  פאזה שמחושב בשורה 2700). נקבע בבניית `activeTransition` (שורות 2741-2748), אותו
  דפוס בדיוק כמו `exitPointSec` שכבר עובר את המסלול הזה היום.
- `store.ts:221-226` — `pendingMixRating` מקבל שני שדות חדשים: `toContentHash: string |
  undefined` ו-`entrySec: number`.
- `controls.ts:2772` — מוסיפים `const toTrack = useStore.getState().decks[t.toDeckId].track`,
  ו-`toContentHash: toTrack?.contentHash`, `entrySec: t.entrySec` ל-`pendingMixRating`
  שנבנה שם. זה לא חוזר על ה-anti-pattern של `transport-webmidi/manager.ts` (שמתעד
  `platform/` שקורא ל-`app/` ישירות) — `controls.ts` הוא ה-choke point המיועד, קורא
  ל-store הוא הדפוס התקין שלו בכל הפונקציה הזאת כבר.
- `controls.ts:2831` — לצד `markExcellent`, קריאה ל-`markExcellentPair(fromHash, toHash,
  entrySec)`, **רק אם שני ה-hash קיימים**. אם `toContentHash` חסר (השיר הנכנס עדיין לא
  נותח — תרחיש כתיבה אמיתי, לא רק תצוגה: אין טריגר מאוחר יותר שיתקן את זה, בניגוד לפער
  הקריאה של v0.8.10 שמתעדכן בכל רינדור) — **לא נכשל בשקט**: `setNotice({ text: 'Pair
  not saved — the other track hasn't finished analyzing yet', tone: 'info', source:
  'mixRating' })`. נקודת היציאה עצמה (`markExcellent`) עדיין נשמרת כרגיל — זה רק הזוג
  שלא נשמר. `NoticeSource` (`store.ts:22-34`) מקבל ערך חדש: `'mixRating'`.

### 4. לחיצה על הצעה בפס מריצה את המיקס — `startExcellentPairTransition` (`controls.ts`, חדש)

פונקציה חדשה, ליד `loadSuggestionToDeck` (שורות 499-511) שהיא כבר עושה חצי מהעבודה
הזאת עבור הטבלה הרגילה — לא בונים תשתית אסינכרונית חדשה, רק מרכיבים שלושה חלקים קיימים:

```ts
async function startExcellentPairTransition(
  fromDeckId: DeckId,
  fromHashAtClick: string,
  toTrack: Track,
  entrySec: number,
) {
  // 1. אותה בדיקת "דק פנוי" ואותה הודעת סירוב כמו loadSuggestionToDeck (499-511)
  // 2. await loadTrackToDeck(target, toTrack) — מחכה שהניתוח (כולל beatGrid) יסתיים,
  //    כי loadTrackToDeck כבר awaited בפנים (controls.ts:222-484), אין צורך במנגנון חדש
  // 3. בדיקת זהות: אם decks[fromDeckId].track?.contentHash !== fromHashAtClick כבר —
  //    setNotice({ text: `Deck ${fromDeckId} is playing a different track now — mix not started`,
  //    tone: 'warn', source: 'mixRating' }) ו-return, בלי לקרוא ל-startAutoTransition
  // 4. startAutoTransition(fromDeckId, target, entrySec) — קריאה רגילה, ללא שינוי
  //    בפונקציה הקיימת; phaseAlignedEntrySec (שורה 2700) כבר מיישר את entrySec השמור
  //    מול המיקום החי של דק ה-from עכשיו, גם אם עבר זמן מאז שהזוג דורג
}
```

- **שלב 3 (בדיקת זהות) הוא התוספת האמיתית** — `startAutoTransition` עצמו כבר בודק
  `from.playing`/`beatGrid` בזמן הקריאה (2640-2676), אבל לא בודק **איזה** שיר זה. בלי
  הבדיקה הזאת, אם שלום מחליף שיר בדק המקור בזמן שהשיר השני נטען (טעינה+ניתוח יכולים
  לקחת שנייה-שתיים), המיקס האוטומטי היה רץ עם `entrySec` שנשמר לזוג *אחר*, על שיר
  שמתנגן עכשיו בדק המקור ולא קשור. שלום אישר במפורש (22/09): לעצור ולהגיד, לא להמשיך.
- הגנות ה-cancel הקיימות (`cancelTransitionIfEitherDeckTouched` וכו') ממשיכות לעבוד
  ללא שינוי מהרגע ש-`startAutoTransition` בפועל מתחיל — הן כבר מכסות "מגע ידני אחרי
  שהמיקס האוטומטי רץ", וזה לא משתנה כאן.
- הפעולה הזאת **חלה רק על שורה בפס "Excellent matches"**. הטבלה הרגילה ממשיכה לקרוא
  ל-`loadSuggestionToDeck` (טעינה בלבד, בלי מיקס אוטומטי) בדיוק כמו היום.

### 5. `Library.tsx`

- באותו memo שבונה `playedHashes` (שורה 157-188): לכל דק שמנגן, `getExcellentFollowUps`
  (async, כמו קריאות אחרות ל-idb-keyval בקובץ הזה) → בונה `excellentPairs: Set<string>`
  שטוח (`"from:to"`) ומעביר ב-`context`; ה-`entrySec` הנלווה עובר עם `MixMatch` (סעיף 2).
- פס קבוע מעל הטבלה, מוצג **רק כש-`excellentPairSuggestions(...)` לא ריק**: "Excellent
  matches" + עד 3 שורות קצרות (שם השיר + "after {from}"). **לחיצה על שורה בפס קוראת
  ל-`startExcellentPairTransition`** (מריצה את המיקס מיד) — שונה מדאבל-קליק על שורה
  בטבלה הרגילה, שממשיך לטעון בלבד (`loadSuggestionToDeck`). ההבדל בהתנהגות בין הפס
  לטבלה **מוצג בטקסט** ליד הפס ("click to mix now"), כדי שלא יפתיע. **אין תג ספירה
  חדש בסרגל הכלים** — זה לא נספר כמו `N played`/`N skipped`, כי מספר "כמה זוגות יש" לא
  אומר כלום למשתמש; הפס עצמו הוא האינדיקציה.
- שיר שכבר מוצג בפס **ממשיך להופיע גם בטבלה הרגילה** במקום הרגיל שלו (לפי BPM/סולם) —
  לא מוסר משם. הפס הוא תוספת, לא מיון מחדש.

### 6. Hint mode

- מזהה חדש ב-`src/core/hints.ts` לפס "Excellent matches" — כולל המשפט שמסביר שלחיצה
  כאן שונה מלחיצה בטבלה (מריצה מיקס, לא רק טוענת). אנגלית כמו שאר הפיצ'ר, בהתאם לתקדים
  v0.8.10/v0.8.11.

### מה **לא** בגרסה הזאת

זוג ההפך (B→A) לא נכתב אוטומטית. אין UI לניהול/מחיקת זוגות שנשמרו. אין ספירת "N זוגות
לא זמינים" כששיר-היעד יצא מהספרייה — הוא פשוט לא יופיע בפס (כמו כל שיר אחר שלא בספרייה),
בלי הודעה נפרדת: זו לא התנהגות "מדלגת בשקט" חדשה, זה אותו כלל שכבר חל על כל הרשימה
(מציגים רק שירים שבספרייה). ציון/מספר בממשק — נשאר לא-מטרה מהספק המקורי. **אין המתנה
לנקודת היציאה המדויקת שהייתה בפעם הקודמת** — שלום בחר במפורש "מיד כשלוחצים"; נקודת
היציאה החיה ממשיכה בדיוק כמו היום.

## קבצים

חדש: `src/platform/mix-pairs-idb/store.ts`. עורכים: `src/core/recommend.ts`,
`src/controls.ts`, `src/app/state/store.ts`, `src/app/components/Library.tsx`,
`src/core/hints.ts`, `tests/core/recommend.test.ts`. בסגירה: `package.json` +
`HANDOFF.md` + `ROADMAP.md` (שורת v0.8.14 ✅) + `docs/handoff/v0.8.14.md`.

## בדיקות (`tests/core/recommend.test.ts`, בסגנון v0.8.10)

1. בלי `context.excellentPairs` (או ריק) ≡ הפלט של היום — בייט-בייט.
2. זוג קיים (A→B), A מתנגן → B מקבל `excellentPairAfter: { fromName: 'A', entrySec }`
   בתוך `matches`.
3. **כיוון בלבד:** זוג A→B קיים, B מתנגן → A **לא** מקבל `excellentPairAfter` (אין
   הסקה הפוכה).
4. `excellentPairSuggestions` — יציבה, חתוכה ל-3, לא כוללת שיר שכבר על דק.
5. `matchTier` לא זז עבור שיר עם `excellentPairAfter` (עדיין לפי strong/played בלבד).
6. שני קבצים עם אותו `contentHash` — זוג שנשמר לאחד חל על שניהם (עקבי עם התנהגות
   `played` מ-v0.8.10).
7. דטרמיניזם: אותו קלט → אותה תוצאה בכל קריאה.

בדיקות נוספות ל-`startExcellentPairTransition` (`controls.ts`, לא `core/` — לא ניתן
ל-unit test טהור כי תלוי ב-engine/store; מכוסה ב-code path קיים + אימות ידני):

8. `loadSuggestionToDeck` הקיים ממשיך לעבוד ללא שינוי (רגרסיה) — הטבלה הרגילה עדיין
   רק טוענת.
9. `markExcellentPair` נקרא עם שלושת הארגומנטים (`fromHash, toHash, entrySec`) רק
   כששני ה-hash קיימים; `entrySec` הוא הערך הגולמי (`t.entrySec`), לא הערך המיושר.

## אימות

1. `npm run check` ירוק (`tsc -b` + `oxlint` + `depcruise` + `vitest`).
2. **באפליקציה, `localhost:5173`** (השרת הרץ אצל שלום):
   - a. לנגן מעבר אוטומטי מלא (Mix Assist) בין שני שירים, ללחוץ "Excellent", לטעון את
     השיר הראשון שוב לדק פנוי → הפס "Excellent matches" מציג את השיר השני.
   - b. **לחיצה על השורה בפס** → הבדיקה החשובה: השיר השני נטען לדק הפנוי, מתמקם
     בנקודת הכניסה השמורה, והמיקס האוטומטי רץ מיד (קרוספיידר זז לבד, בלי לגעת בכלום).
   - c. **תרחיש ההחלפה:** ללחוץ על שורה בפס, ומיד (בזמן שהשיר השני נטען) להחליף את
     השיר בדק המקור בשיר אחר → המיקס האוטומטי **לא** אמור לרוץ, ואמורה להופיע הודעה.
   - `javascript_tool`/`read_console_messages` לבדיקת DOM ושגיאות; שלום מאמת בעצמו
     ב-Chrome שלו (הבדיקות הטהורות + הצפייה הישירה בקרוספיידר הן ההוכחה הרשומה —
     תרחיש (b)/(c) הם live audio behavior, לא ניתנים לבדיקה אוטומטית מלאה).
3. סקירה עצמאית: `change-reviewer` על ה-diff — לשים לב במיוחד לבדיקת הזהות בשלב 3 של
   `startExcellentPairTransition` (הסיכון המרכזי של התוספת הזו).
4. `python scripts/context_check.py` בסוף.

## סיכונים

- **פער כתיבה, לא רק קריאה:** אם השיר הנכנס עדיין לא נותח כשלוחצים "Excellent", הזוג
  לא נשמר לצמיתות לאותו מעבר — אין הזדמנות שנייה. מטופל ב-`setNotice` לא-חוסם, לא
  בשקט.
- **נתונים דלילים בהתחלה** (הספק המקורי כבר מזכיר את זה) — הפס לא יופיע כמעט אף פעם
  בהתחלה. זה תקין וצפוי, לא באג; לא נוסף מנגנון "אין עדיין" כי הפס עצמו נעלם כשהוא ריק
  (עקבי עם "אין תג 0" מ-v0.8.10).
- **חלון א-סינכרוני בין לחיצה להרצה (חדש, מ-22/09):** טעינת השיר השני יכולה לקחת
  שנייה-שתיים; ללא בדיקת הזהות בשלב 3 של `startExcellentPairTransition`, אם שלום
  מחליף שיר בדק המקור באותו חלון, המיקס האוטומטי היה רץ עם נקודת כניסה שנשמרה לזוג
  אחר. `phaseAlignedEntrySec` היה מונע תקלה טכנית (סיק לא תקין), אבל לא תקלה מוצרית
  (מיקס "חכם" עם שיר לא קשור). מטופל בבדיקת זהות מפורשת לפני קריאה ל-`startAutoTransition`.
- **לחיצה על הצעה בפס שונה מלחיצה בטבלה** — סיכון בלבול: שלום (או כל משתמש) עלול
  ללחוץ על שורה בפס בהרגל של הטבלה הרגילה ולהיות מופתע שמיקס רץ בפועל. מטופל בטקסט
  מפורש ליד הפס ("click to mix now") — לא רק צבע/סמל שונה.

## הוראות בדיקה לשלום (בעברית, יימסרו שוב בסגירה)

מנגנים מעבר אוטומטי מלא בין שני שירים (Mix Assist, עד שהקרוספיידר מגיע לסוף) ולוחצים
"Excellent". טוענים את השיר הראשון שוב לדק פנוי — מעל הטבלה אמור להופיע פס "Excellent
matches" עם השיר השני. **לחיצה עליו לא רק טוענת — היא מריצה את כל המיקס לבד**: השיר
נטען, מתמקם בנקודה הנכונה, והקרוספיידר זז לבד עד שהוא עובר לגמרי לדק השני. סימן שבור:
הפס מופיע בלי שדירגת שום דבר, הטבלה הרגילה למטה משנה סדר, או שלחיצה על הפס רק טוענת
בלי להריץ את המיקס.
