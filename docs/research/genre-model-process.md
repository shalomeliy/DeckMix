# ז'אנר חדש במסלול של הסימונים (v0.9.38)

מסלול קבוע, במקום לאלתר בכל ז'אנר. המודל נכנס לאפליקציה **רק אם עבר את המודל הכללי במדידה על שירים שלא ראה**.

1. שלום מסמן ביד שירים בז'אנר ולוחץ "גמרתי" על כל שיר. מתחת ל-`MIN_SONGS_FOR_GENRE_MODEL` שירים גמורים (`src/core/sound/genre-coverage.ts`) אין מודל,
   והטבלה ב-Settings > Library כותבת בשם הז'אנר כמה שירים חסרים.
2. ייצוא הסימונים (`deckmix-vocal-marks-YYYY-MM-DD.json`).
3. `node --import ./scripts/train/alias-register.mjs scripts/train/dump-strip-probs.mjs <marks> <תיקיית מוזיקה> <out.json> --rows` (רק על המחשב של שלום, שם האודיו).
4. `python scripts/train/fit-genre-marks.py <out.json> "<ז'אנר>" --review=<list.json>`: מודל לכל שיר בלי השיר עצמו (leave-one-out). הרשימה מציגה היכן מודל בטוח בהפך מהסימון שלו.
5. שלום עונה על הרשימה; תשובות נשמרות ב-`scripts/train/review-answers.json`.
6. המודל נכנס ל-`src/core/sound/vocal-genre-models.json` רק אם ציון ה-leave-one-out שלו גבוה מהמודל הכללי **וגם** ההחמצות (קול שלו שהציור לא סימן) לא קפצו. מעלים את `VOCAL_STRIP_VERSION` ואת ה-hashes בבדיקות.
7. ז'אנר מתחת לרף נשאר על המודל הכללי, והטבלה אומרת את זה.
