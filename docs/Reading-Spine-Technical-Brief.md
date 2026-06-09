# Alpha Summer Reading: Technical Brief

**For:** Engineering / TimeBack integrations / future maintainers
**From:** Nick Alsford
**Date:** 2026-06-03
**Status:** v1 — describing the system as built, with open product questions for the next iteration

---

## How to read this brief

Sections 1–6 describe the system as it currently stands on production (`reading-spine.vercel.app`) — treat as scoped and decided. Section 7 is the one open technical question for the TimeBack team. Sections 8–11 are open product questions for the next alignment meeting.

---

## 1. The ask, in one sentence

When a K–8 student reads a real, well-loved book during the summer, give them a single web app that picks books at the right level, generates a fresh AI-written comprehension quiz on demand, has them prove they read it (multiple-choice quiz + verbal retell with an AI buddy), grades both halves on the server, and credits a per-student XP balance — designed to plug into the TimeBack store on the same 1 XP ≈ $0.01 / portal-point conversion the existing economy uses.

**Calibration note (current production):** The XP formula targets ~1 XP per active minute of focused work (reading + quiz + retell). A grade-3 student reading a 30-minute book and acing both quiz and retell on the first try earns ~49 XP. A grade-3 student finishing *Charlotte's Web* (~290 min) earns ~388 XP for a clean run. Heavy summer readers landing 2–3 chapter books a week clear ~1500 XP / week, sized to be a meaningful share of summer learning incentives without dominating them.

## 2. Worked examples

**Example A — In-band, both halves clean (3-5 band, chapter book):**
- Titus (G3, working grade 3, age grade 3) finishes *Fantastic Mr. Fox* and passes both the quiz and the retell on the first try.
- Book: 32,000 words. WCPM @ G3 = 110 → 291 min reading.
- Quiz (5 Q × 1 min) + retell (3 min) = 299 total min.
- Outcome `p1_p1` → ratio 1.30.
- Credit: `floor(1.30 × 299)` = **388 XP** to Titus's balance.

**Example B — Stretching down, in-band reading for K (picture book):**
- Evangeline (K, working grade K, age grade K) finishes *The Very Hungry Caterpillar*.
- Book: 224 words. WCPM @ K = 30 → 7 min reading.
- Total: 7 + 5 + 3 = 15 min. Both halves clean.
- Credit: `floor(1.30 × 15)` = **19 XP** — small but proportional, matches the K reading-time expectation.

**Example C — Cross-grade reading, K kid stretching to a chapter book:**
- Evangeline (working grade K) tackles *Charlotte's Web* (32,000 words).
- WCPM @ K = 30 → 1067 min reading (clearly a multi-week project).
- Total: 1067 + 5 + 3 = 1075 min. Both clean.
- Credit: `floor(1.30 × 1075)` = **1397 XP** — the K kid earns more than the G3 kid for the same book, because the system expects her to invest more time, and rewards it.

**Example D — Retake mess (one section needs 2nd attempt):**
- Titus passes the quiz on the first try, then needs 2 attempts at the retell to pass.
- Outcome `p1_p2` → ratio 1.15.
- Credit: `floor(1.15 × 299)` = **343 XP**. Visible 45-XP penalty for the messy retell vs. a clean run.

**Example E — Failed retell after passing quiz (pass 1 of 2):**
- Titus passes the quiz on attempt 1, fails both retell attempts.
- Outcome `p1_fF` → ratio 1.00.
- Credit: `floor(1.00 × 299)` = **299 XP**. Pass-1-of-2 still earns the baseline pay — failing the OTHER section drops the bonus but not the base.

**Example F — Both sections messy:**
- Outcome `p2_p2` → ratio 0.55 → `floor(0.55 × 299)` = **164 XP**. Real penalty, but kid still came out ahead of total-failure (0 XP).

**Example G — Out-of-attempts (both quiz attempts failed, retell auto-runs anyway):**
- Titus fails the quiz twice. Retell auto-launches. He passes retell attempt 1.
- Outcome `fF_p1` → ratio 1.00.
- Credit: **299 XP**. Retell is a real redemption path — a kid who can verbally describe the book still earns base XP.

**Example H — Both fail:**
- Quiz: fail twice. Retell: fail twice. Outcome `fF_fF` → 0 XP. Book is locked for this student (2-attempt cap is permanent, no daily reset).

**Example I — Closed mid-retell:**
- Kid passes quiz, taps × on the retell modal before completing it.
- Confirmation prompt fires. If confirmed: 0 XP awarded, all attempts marked used. No "come back to the retell" — the section is atomic.

These anchor cleanly against expected reader output. A summer-active grade-3 kid earning ~5000–8000 XP across the summer ≈ $50–$80 of portal credit lands the system in the same magnitude as the existing AR + Rings economy without dominating either.

## 3. Data sources

**Quiz generation:** Anthropic Claude Opus 4.5 (`claude-opus-4-5`), multi-pass cross-validated.
- 3 parallel generations at temperatures 0.4 / 0.7 / 1.0
- Cluster + consensus filter (≥2 of 3 runs must agree for a question to survive)
- Server-side QC review pass (also Opus 4.5) scores each survivor 0–10 on accuracy, age-appropriateness, distractor quality
- Anything < 7 dropped. Anything < 8 surviving questions for a book → entire pool is regenerated.

**Quiz cache:** Upstash Redis, keyed by `v8:{bookId}:{workingGrade}[:age{ageGrade}]`. The cache is the **only source of truth for the answer key** — clients never see the answer index.

**Voice retell:** OpenAI APIs.
- `whisper-1` for transcription (with prompt-bias to suppress YouTube-corpus hallucinations like "Thanks for watching")
- `gpt-4o` for tutor next-message generation (warm conversational system prompt, temperature 0.95, frequency/presence penalties)
- `gpt-4o-mini` for per-turn topic moderation
- `gpt-4o` for end-of-conversation grading rubric
- `tts-1` (model) with voice from `{nova, shimmer, coral, ash, fable}` — kid-picked at first sign-in

**Audio storage:** Vercel Blob, public bucket, 14-day TTL per clip. Path-prefixed by date (`tutor/YYYY-MM-DD/{sessionId}/turn-N.webm`) for future cleanup-cron filtering.

**Reading time / WCPM:** Built-in table per working grade (PK=15, K=30, G1=60, G2=100, G3=110 WCPM …). Book metadata table includes word counts for all 57 books in the K-3 catalog.

**TimeBack working-grade sync:** Daily Vercel cron (06:00 UTC) hits the persisted reporting query `971e9db1-70ad-493c-b41f-f23c75acf022` on `api.alpha-1edtech.ai`, pulls `rpt2_mastery` rows, bulk-updates working grade + age grade per student.

**Caliper events:** Quiz pass events fire-and-forget to TimeBack's Caliper sensor endpoint (env: `TIMEBACK_CALIPER_URL`). Failed deliveries queue to a Redis retry list, drained daily by a 06:30 UTC cron.

## 4. Data fields tracked per student per book

| Field | Example | Notes |
|---|---|---|
| `student_email` | `evangeline.tanner@gt.school` | Google OAuth subject — primary key everywhere |
| `working_grade` | `K` | Drives WCPM, catalog visibility, XP base |
| `age_grade` | `K` | Optional; drives quiz/retell content maturity. Falls back to working_grade. |
| `book_id` | `k01` | App-internal id; maps to a fixed catalog row |
| `book_title` | `The Very Hungry Caterpillar` | |
| `word_count` | `224` | Used for WCPM-based reading-time estimate |
| `quiz_outcome` | `p1` \| `p2` \| `fF` | Pass attempt 1, pass attempt 2, or failed both |
| `retell_outcome` | `p1` \| `p2` \| `fF` | Same encoding |
| `total_xp` | `19` | Final credited amount, atomic |
| `started_at` | ISO 8601 | When kid clicked "I'm reading this" |
| `quiz_submitted_at` | ISO 8601 | First passing or final failed submit |
| `retell_completed_at` | ISO 8601 | Final tutor finalize |
| `tutor_transcript` | text array | Full conversation, only stored for held grades |
| `tutor_audio_urls` | string array | 14-day Vercel Blob links, held grades only |
| `quiz_attempts_used` | `0` \| `1` \| `2` | Permanent — does not reset |

## 5. Trigger logic (pseudocode)

```
# Constants — see lib/xp.js
OUTCOME_RATIOS = {
  p1_p1: 1.30,  p1_p2: 1.15,  p2_p1: 1.15,  p2_p2: 0.55,
  p1_fF: 1.00,  p2_fF: 0.70,
  fF_p1: 1.00,  fF_p2: 0.70,
  fF_fF: 0.00,
}
QUIZ_MIN_PER_QUESTION = 1     # 5 min for 5-Q quiz, 3 min for 3-Q emergent
RETELL_MIN            = 3
QUIZ_DAILY_ATTEMPT_LIMIT = 2  # permanent cap, no daily reset

# Per session
on quiz_submit(student, book, answers):
  attempt = recordQuizAttempt(student, book)            # INCR Redis counter
  if attempt > QUIZ_DAILY_ATTEMPT_LIMIT and !isAdmin:
    return 429 too_many_attempts
  pool = getCachedQuizPool(book.id, working_grade, age_grade)
  if not pool: return 409 no_quiz_pool                  # stale cache → tell kid to reopen
  pass = grade(answers, pool) >= 4 of 5
  quiz_outcome = pass ? (attempt == 2 ? p2 : p1) : fF
  store readingSession(student, book, {quiz_outcome, attempt, ts})
  return { passed, score, retellRequired: true }        # NO XP yet — atomic

on retell_finalize(student, book, transcript):
  rubric = grade_conversation(transcript, book)         # LLM rubric
  retell_outcome = rubric.overall_pass == true ? p1
                 : rubric.overall_pass == null ? HELD
                 : fF
  sess = getReadingSession(student, book)               # has quiz_outcome
  total_min = reading_min(book, working_grade)
              + QUIZ_MIN_PER_QUESTION * book.question_count
              + RETELL_MIN
  ratio = OUTCOME_RATIOS[sess.quiz_outcome + "_" + retell_outcome]
  xp = floor(ratio * total_min)
  if retell_outcome == HELD:
    addHeldXpEntry(student, book, xp, rubric, transcript, audio_urls)
  else if xp > 0:
    recordRead(student, book, xp)                       # leaderboard + dedupe
    clearCurrentlyReading(student)
    evaluateAchievements(student)
    fireCaliperEvent(student, book, attempt, score, xp)
  clearReadingSession(student, book)                    # atomic — fresh next time
```

**Idempotency note:** the per-book read set (`user:{email}:books`) is SADD-deduped on the server. Even with localStorage tampered or repeated submits, a kid can only earn XP for the same book once. Admin can override via `reset-my-book`.

## 6. Catalog

57 books currently shipped, 5 reading tracks:

| Track ID | Label | Grade | Book count |
|---|---|---|---|
| `e` | Beginning Readers | PK | 12 |
| `k` | Grade K | K | 11 |
| `a` | Grade 1 | 1 | 14 |
| `b` | Grade 2 | 2 | 12 |
| `c` | Grade 3 | 3 | 8 |

Each book has: id, ISBN, title, author, age range, word count, palette colors, blurb. Quiz is generated on-demand and cached forever (keyed by version + book + grade).

**Default visibility rule:** working grade ± 1 (a G3 kid sees G2 / G3 books by default; admin can override per-track per-student). Admins see every track for QA.

**Grades 4–8 catalog is the single biggest scope item left.** Currently blocking heavy-reader G4+ kids from full participation.

## 7. THE one technical question for TimeBack

**Caliper event schema agreement.**

Reading Spine fires Caliper-shaped events on every credited read to `TIMEBACK_CALIPER_URL`. The current envelope shape was reverse-engineered from a single sample and assumes TimeBack will accept it. We need:

1. **Schema confirmation:** does the event shape in `lib/caliper.js` `buildQuizEventEnvelope()` validate against TimeBack's actual sensor schema? Specifically the `actor` / `object` / `generated` block IDs.
2. **`actor.id` format:** we currently send the kid's email as `actor.id`. TimeBack uses internal student GUIDs. Two options:
   - Reading Spine looks up the GUID via the same reporting query the working-grade sync uses, includes both `email` and `studentId` on every event.
   - TimeBack tolerates email-as-id at ingest and joins on its side.
3. **`extensions.fraudFlag`:** we attach `clean | soft_flag | held | tutor_review` per event so TimeBack's dashboards can surface attempt-quality. Does that field name conflict with anything?
4. **Replay safety:** if Reading Spine retries a failed delivery (out of the `caliper:retry` queue), does TimeBack dedupe on `id` (the envelope's UUID), or do we need an idempotency key?

These are the four blockers for switching the Caliper transport from "fire and don't watch" to "fire and verify."

## 8. Identity mapping

Reading Spine identifies students by Google OAuth `email`. TimeBack uses internal `studentId`. The integration needs a join.

**Current state (lightweight):**
- `/api/auth/me` returns `studentId: session.studentId || null`. The field exists; it's never populated.
- Daily TimeBack sync cron pulls students by email and updates working/age grade. The reporting query returns `student_id`; we have it, just don't store it on the profile.

**Recommendation for the next cycle:** persist `timebackStudentId` on the Redis user profile during the daily sync (`bulkSetWorkingGrades` already has the data — one more field to merge). Then Caliper envelopes carry both `email` AND `studentId`. Clean.

**ALLOWED_DOMAIN** env var gates who can sign in at all: `alpha.school,trilogy.com,superbuilders.school,2hourlearning.com`.

## 9. Edge cases — decisions made

- **Retakes:** DECIDED — permanent 2-attempt cap per book per student. No daily reset. Failing both attempts locks the book until an admin resets it (`reset-my-book` admin action).
- **Mid-session close:** DECIDED — confirmation prompt fires. If kid confirms: 0 XP, all attempts marked used. Section is atomic.
- **Recent-start fraud check:** DECIDED — soft 1-hour floor between "I'm reading this" and quiz_submit. UI greys the quiz button for the first 15 minutes; server holds suspect submissions (< 1h) for admin review. Admin bypasses both.
- **Held grades:** DECIDED — when the retell LLM grader returns `overall_pass: null` (borderline / unclear audio), the XP is held in `heldxp:pending`. Full transcript + audio links stored for admin to approve or deny.
- **Track-locking:** DECIDED — admin can per-student force-show or force-hide each track. Server enforces on every quiz fetch + activity recordRead (no client-only filter).
- **Working grade vs age grade:** DECIDED (#30) — working grade drives reading time + catalog ± 1 + XP math; age grade drives quiz question maturity (vocabulary, distractor sophistication). They default to the same value when only one is set.
- **Voice retell hallucinations:** DECIDED — known Whisper patterns ("Thanks for watching", "Subscribe", etc.) and too-short transcripts are filtered to empty server-side, which triggers the tutor's "Oops, didn't catch that" retry instead of advancing the turn.
- **K-2 floor:** No explicit per-quiz floor. The 5-min quiz + 3-min retell time already adds a meaningful baseline on top of reading time — even a 5-minute picture book + clean run earns ~19 XP, which we judged enough to feel real without inflating the K economy.

## 10. Pilot / cohort status

**Currently:** Pre-launch. No real student users yet. The dev branch carries the in-progress voice retell flow; production is still quiz-only (5-MCQ + atomic dedupe + Caliper out).

**Cohort plan for the next pilot:**
- 5–10 students across K, G2, G3 — same grade-band coverage shape as the AR brief's Tanner family
- 2-week shakeout once voice retell promotes to main
- Success criteria:
  - Quiz-pass rate on first attempt (target: ≥ 60%)
  - Retell-pass rate on first attempt (target: ≥ 50% for K, ≥ 70% for G3)
  - End-to-end session time (target: ≤ 1.5× reading time)
  - Tutor TTS playback success (target: 99% of turns; iPad currently at ~80% — see #72)
  - Cost per session (target: ≤ $0.02 in OpenAI fees)

## 11. Existing motivational model context

Reading Spine XP is currently a **standalone leaderboard** scoped to summer reading. It does NOT yet feed the TimeBack store. The conversion (1 XP ≈ $0.01 / portal point) is a design assumption, not wired.

**Anchoring against the GT Anywhere model:**
- A G3 heavy reader (3 chapter books / week, mostly stretch-level) earns ~1000–1500 XP / week ≈ $10–$15 / week
- Lands at ~10–15% of total weekly portal-point earnings — meaningful but not dominant
- Aligned with the AR brief's calibration target (Section 10 of that doc)

This wiring is one TimeBack-engineering meeting away from being real. The Caliper event already carries `xpAwarded`; what's missing is the TimeBack-side credit handler that converts that to store balance.

## 12. Open questions consolidated for the alignment meeting

1. **Caliper schema (§7)** — TimeBack engineering to confirm event shape + `actor.id` format + idempotency key + `extensions.fraudFlag` name.
2. **Identity mapping (§8)** — Persist `timebackStudentId` on Reading Spine profile; both fields on every event. (Tentative agreement.)
3. **Store credit conversion** — Is `1 XP ≈ $0.01` the right rate, or do we want a separate `READING_SPINE_TO_STORE_MULTIPLIER` so we can tune without touching XP math?
4. **Grades 4–8 catalog** — Source list, who picks, scope (50 books? 100?). Blocking real adoption past G3.
5. **Parent portal (planned)** — Held-XP approvals, data export, password vs. magic link. Pre-launch requirement for parent-facing visibility.
6. **iPad voice retell** — Currently Chrome-first. Safari mic + VAD + WebSocket has known quirks. Blocking ~30% of student devices.
7. **Voice retell launch gating** — Do we ship the retell to production once iPad parity lands, or run quiz-only beta with retell as opt-in?
8. **Data retention** — 14-day audio retention is current default. Parent-policy review pending.
9. **AI safety pass on quiz content** — Pre-launch requirement (#60). Currently relies on the QC reviewer + safety-filter pass; no external safety classifier yet.

## 13. Reference URLs

- **Production:** `https://reading-spine.vercel.app`
- **Preview (dev branch):** `https://reading-spine-git-dev-alpha-academics-projects.vercel.app`
- **Health check (public, JSON):** `https://reading-spine.vercel.app/api/health`
- **Repository:** `https://github.com/NickA-NTO/Summer-Reading-App`
- **Vercel project:** `reading-spine` (Hobby tier; at 12-function ceiling)
- **TimeBack reporting endpoint:** `https://api.alpha-1edtech.ai/reporting/saved-queries/971e9db1-70ad-493c-b41f-f23c75acf022`
- **Caliper sink:** value of `TIMEBACK_CALIPER_URL` env var (production only)
- **Upstash Redis:** Vercel Marketplace integration on the project (KV_REST_API_URL / KV_REST_API_TOKEN)
- **Anthropic console:** project-scoped API key, `claude-opus-4-5` for quiz generation
- **OpenAI console:** project-scoped API key, `tts-1` + `whisper-1` + `gpt-4o` + `gpt-4o-mini`
- **GT Anywhere Motivational Model:** [see AR brief Section 12]
