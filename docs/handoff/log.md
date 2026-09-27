# יומן שיחות

תיעוד היסטורי — מה נעשה בכל שיחה ומתי. **לא נקרא בתחילת שיחה.**
ההווה נמצא ב‑[`HANDOFF.md`](../../HANDOFF.md).

| תאריך | גרסה | מה נעשה | CLEAR אחרי? |
| --- | --- | --- | --- |
| 2026-08-29 | v0.2.1 ✅ | `vitest` — מסגרת הבדיקות הראשונה בריפו, בתוך `npm run check`. חמישה אינווריאנטים ב‑`tests/repo/` שהופכים את כללי הפיצול מהערות לבדיקות; כל אחד הוכח נופל בלי התיקון שלו. שלושה באגים נמצאו — **כולם בבדיקות עצמן**, ואחד מהם רק בהרצת סבב ההכשלה שוב אחרי התיקון | — |
| 2026-08-27 | v0.1.0 | scaffold, מנוע אודיו, decks, mixer, waveform, library, MIDI + FLX4, ריפו ציבורי בגיטהאב | — |
| 2026-08-28 | — | ROADMAP.md (20 גרסאות), HANDOFF.md, נוהל שיחה | — |
| 2026-08-28 | — | codegraph init בפרויקט; הוספת v0.1.5 (design overhaul) לרודמפ | 🟢 שיחה חדשה לפני v0.1.5 |
| 2026-08-28 | v0.1.5 | שכתוב שפת עיצוב: tokens+Inter, Button/Knob/Fader, Deck+Platter, Waveform, Mixer, TopBar, Library + מצבים. build+lint ירוק. ממתין לבדיקה ויזואלית | אחרי ליטוש |
| 2026-08-28 | v0.1.5 | +DnD, +recommend.ts (mix highlight), תיקון גלילה, תיקון feedback loop של הקנבס, כיול פריסה ל‑1536×710. docs: פורמטי תגיות + architecture/directions. ROADMAP: גרסאות .5/.6/.7. 13 commits מקומיים, לא נדחף | 🟢 שיחה חדשה — לסיים ליטוש + push |
| 2026-08-29 | v0.2.0a ✅ | מנוע scratch: `AudioWorklet` עם מצביע קריאה חתום מחליף את `AudioBufferSourceNode` (שקופא ופולט DC באחורה/עצירה). `SourcePlayer` עם fallback גלוי, anchors+epoch למיקום, סוף‑טראק כהודעה. נמדד: זהות ביט‑לביט במהירות 1.0, 4500/4500 אחורה, ‎-999dBFS ב‑0. תפס אפנון Nyquist ב‑gain ו‑`addModule` שמשקר | — |
| 2026-08-28 | v0.1.7 ✅ | `library/tags.ts` — ID3v2/MP4/Vorbis/RIFF/AIFF + parseKey→Camelot; `readLibraryTags` פאס שני batched; עמודות Artist/Key; `mixRecommendations` עם התאמת סולם. נמדד: BPM 96.9%, Key 97.2%, Duration 100%, 0.6ש' על 360 קבצים | 🟢 מומלץ `/clear` | <!-- dead-path -->
| 2026-08-29 | v0.2.0 | **הכשלת ה‑worklet בכוונה** — שלושה מסלולי כשל מול האפליקציה החיה (`addModule` נדחה · `addModule` מצליח בלי לרשום מעבד · `throw` אמיתי ב‑`process()`), שלושתם מייצרים את הפיל `no scratch`. אימות הפוך: ‎-1.5 ל‑400ms הזיז 0.923→0.328ש' מול צפי 0.323. הזרקת התקלה הוחזרה, הקומיט מסמכים בלבד. **+ פיצול המסמכים** — HANDOFF מ‑41KB ל‑13.1KB, `docs/handoff/` נוצר, וארבעה פריטים שהיו קבורים בבלוק "נכתב" צפו | 🔴 שיחה חדשה |
