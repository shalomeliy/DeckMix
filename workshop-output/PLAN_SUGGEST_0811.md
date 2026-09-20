# PLAN v0.8.11 — מדרגות ומשפט הסבר להצעות

מקור: `workshop-output/FEATURE_SPEC_SUGGEST.md` (מאושר). אחרי אישור: להעתיק ל-
`workshop-output/PLAN_SUGGEST_0811.md`, ענף חדש `feat/v0.8.11-suggestion-reasons` מ-`main`
**אחרי** שהענף של v0.8.10 ממוזג (או מעליו — לבדוק `git log origin/main..`), ורק אז קוד.

## Context

היום כל הצעה היא נקודה (מלאה/טבעת) שאומרת "מתאים" ולא **למה**, והסדר ב-Mix Only הוא סדר
הספרייה. v0.8.10 הוסיפה רק "ניגן/לא ניגן". כאן: מדרגות מיון ברורות + משפט סיבה במילים.
**הבחירה עצמה לא משתנה** (אותו שער BPM ≤8%, אותו strong/loose).

## סטייה מה-spec (וההסבר)

ה-spec דיבר על מיון בתוך מדרגה לפי מרחק BPM. **מוותרים על זה:** `refBpm` תלוי במחוון הטמפו
החי של הדק, ולכן מיון לפי מרחק היה מקפיץ שורות בזמן שהוא מזיז את הפיידר. מדרגות בלבד
(מתהפכות רק כשעוברים את סף ה-3%, כמו שהנקודה כבר עושה), ובתוך מדרגה — הסדר הקיים.

## מה נמצא בקוד

- `recommend.ts`: `MixMatch` כבר נושא `multiplier`, `refBpm`, `trackBpm`, `keyMatch`, `strong`,
  `played`. `orderMixList` מחלק היום ל-2 (לא-ניגן, ניגן).
- `Library.tsx` (`TrackRow`): `matchTitle` נבנה בתוך ה-JSX מאותם שדות — הסיבות כבר קיימות
  כמחרוזת, מפוזרות. זו המקור היחיד שצריך לאחד.
- שורות ב-`useVirtualRows` עם `ROW_HEIGHT` קבוע (h-9) — **אסור להוסיף שורה שנייה**.

## העיצוב

1. **`core/recommend.ts` (טהור):**
   - `matchReasons(match): string[]` — רשימת ביטויים קצרים בסדר קבוע:
     `tempo ±N BPM` (מחושב `refBpm − trackBpm×multiplier`, מעוגל, סימן מפורש) או `half-time`/
     `double-time` כשהמכפיל ≠1 · `key compatible` / `key clashes` / **`key unknown`** (כש-
     `keyMatch===undefined` — לא "לא תואם") · `already loaded this set`.
   - `matchTier(match): 0|1|2` — 0 לא-ניגן+strong, 1 לא-ניגן+loose, 2 ניגן.
   - `orderMixList`: כשלא `keepOrder` → מיון **יציב** לפי `matchTier`. (כשיש `keepOrder`, כמו
     היום: לא נוגעים.)
   - אין שדה score/ציון. לא מוסיפים לוגיקת בחירה.
2. **`Library.tsx`:** `matchTitle` נגזר מ-`matchReasons(match).join(' · ')` (מקור אחד לכותרת,
   ל-`sr-only` ול-title). בשורה **הנבחרת בלבד**: הביטויים מוצגים כטקסט עמום קטן אחרי שם
   השיר, באותה שורה, מקוצר (`truncate`) — בלי לשנות גובה. אין שינוי בשורות שאינן נבחרות.
3. **Hint:** מרחיב את `library.mixOnly` ב-`hints.ts`: נקודה מלאה = הצעה הדוקה, טבעת = חלקית,
   ✓ = כבר נטען; סדר: הדוקות, חלקיות, אחר כך ✓.

## קבצים

`src/core/recommend.ts`, `src/app/components/Library.tsx`, `src/core/hints.ts`,
`tests/core/recommend.test.ts`. סגירה: `package.json`+lock → 0.8.11, `HANDOFF.md`, `ROADMAP.md`
(שורת v0.8.11), `docs/handoff/v0.8.11.md`.

## בדיקות (בסגנון הקיים)

- `matchReasons`: התאמה 1:1 → `tempo +2 BPM`; half-time; שיר בלי סולם → `key unknown` (ו**לא**
  `key clashes`); סולם מתנגש; שיר ששוחק → כולל `already loaded this set`; סדר הביטויים קבוע.
- `matchTier`: 4 מקרים; strong-ניגן → מדרגה 2 (ניגן מנצח).
- `orderMixList`: strong לפני loose לפני ניגן; סדר קיים נשמר בתוך מדרגה (יציבות); `keepOrder`
  לא מסדר מחדש; דטרמיניסטי.
- **`matches` זהה ל-v0.8.10** (אותם מפתחות, אותו `strong`) — בדיקת רגרסיה שהבחירה לא זזה.

## אימות

1. `npm run check` ירוק. 2. `javascript_tool`: גובה כל שורה נשאר `ROW_HEIGHT` גם לשורה נבחרת
עם משפט ארוך (מדידה, לא ניחוש). 3. שלום בודק באפליקציה (Browser pane לא בוחר תיקייה).
4. `change-reviewer` על ה-diff. 5. `context_check.py`.

## הוראות בדיקה לשלום (בעברית, בסוף)

מנגן שיר ב-Mix Only, לוחץ על שורה מוצעת: אחרי השם מופיע משפט כמו `tempo +2 BPM · key
compatible`. הסדר: קודם הצעות עם נקודה מלאה, אחריהן טבעת, ובסוף אלה עם ✓. סימן שבור: שורה
שגבוהה יותר משאר השורות אחרי בחירה, או `key clashes` על שיר שאין לו סולם בכלל.

## סיכונים

- משפט ארוך ב-title קטן על המסך של שלום (~24% קטן): חיתוך עם `truncate` והמלא ב-`title`.
- מדרגות מתהפכות כשהטמפו עובר סף 3% — התנהגות קיימת של הנקודה, מוצהרת כאן.
