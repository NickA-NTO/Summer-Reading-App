# Reading Spine — operating memory

Updated 2026-06-09. The human-readable handover doc for the Alpha
Summer Reading app. Captures the things a teammate (or me in a
fresh session) needs to know without reading every commit.

## 0. The user

- **Nick Alsford** (`nick.alsford@trilogy.com`) — sole admin, sole
  developer.
- Communication style: direct, factual, bullet-heavy, no fluff.
  Wants concrete numbers and specific examples. Pushes back on
  over-engineering. Calls out architectural mistakes when he sees
  them.
- Hard preferences (do not violate):
  - **"Use XP, not points. Kids know what XP is."**
  - **"I should be the only one"** — admin. `ADMIN_EMAILS` env var
    on Vercel = only `nick.alsford@trilogy.com`.
  - **"No teachers. Don't ever suggest having a teacher do
    something again."** Use "guide" or "admin" instead.
  - **"Stop doing your enrichment bullshit. I told you to only
    use my summaries."** No LLM synthesis of book records.
  - **"I cannot do anything that requires humans at this stage"**
    means no per-kid runtime moderation. One-time authoring is OK.
  - Don't scrape Scribd / Z-Library / Anna's Archive / Internet
    Archive borrowable books (legal: Hachette v. IA 2023).
  - Repo-root files `Clade PAYG Key.txt` and `OpenAI key.txt` are
    git-ignored and must NEVER be tracked.
- Don't commit unless explicitly asked. He confirms before pushes
  in most cases.

## 1. What the app is

A K-8 reading web app on **Vercel + Upstash Redis**. Kids:

1. Browse a catalog of books filtered by grade band.
2. Tap "I'm reading this" to declare a current book.
3. Read it off-app (physical book or audiobook).
4. Come back, take a quiz (5 of 12 multiple-choice).
5. If the quiz passes, do a voice retell with the conversational
   tutor (Whisper transcribe + GPT-4o grade).
6. Earn XP — only if quiz + retell both complete.
7. Compete on a grade-cohort leaderboard.

Auth: Google sign-in restricted to `@alpha.school` /
`@trilogy.com` / `@2hourlearning.com` / `@superbuilders.com`.

## 2. Production vs preview — the env split

The app is deployed twice, with **shared Upstash + isolated Redis
namespaces**:

| URL | Branch | Vercel env | Redis prefix |
|---|---|---|---|
| Production domain (configure when ready) | `main` | `production` | `""` (un-prefixed; historical data lives here) |
| `https://reading-spine-git-dev-alpha-academics-projects.vercel.app` | `dev` | `preview` | `preview:` |

The `KEY_PREFIX` constant in `lib/store.js` derives from
`process.env.VERCEL_ENV`. Preview writes never touch production
leaderboards, fraud state, currentlyReading, quiz cache, held-XP
queue, or anything else in Redis.

**Per-commit URLs** like `reading-spine-2l0j62guf-…vercel.app`
must NOT be used for testing — every push gets a new hash, Google
OAuth rejects them as `redirect_uri_mismatch`. Always test via the
stable branch alias above. Same goes for production once the
domain is wired.

## 3. The directories that matter

```
api/                         Serverless handlers (Vercel functions).
  quiz.js                    Quiz pool fetch + grading helpers.
                             Static bank loader at module init.
  activity.js                Reads, quiz_submit, kind="open"/"start".
                             HMAC-grading path + legacy cache fallback.
  tutor.js                   Conversational retell endpoint.
  admin/index.js             Consolidated admin endpoint (Hobby tier's
                             12-function cap forced this). All routes
                             behind ?action=... .
  auth/                      Google OAuth + /me + data-request submission.
  tts.js                     OpenAI TTS proxy + Vercel Blob cache.
  health.js                  Status + counts.

lib/                         Server-side modules.
  store.js                   Upstash Redis wrapper. All Redis through here.
                             KEY_PREFIX env namespacing. Includes data-
                             request helpers (createDataRequest etc).
  session.js                 JWT verify, isAdmin, HMAC helpers
                             (signQuizAnswer / verifyQuizAnswer for the
                             self-contained quiz grading, emailHash for
                             comment moderation).
  tutor.js                   Retell session state, second-chance rubric,
                             pre-grade + commit-mode graders.
  tts.js                     OpenAI TTS + Blob upload + cost cap.
  books.js                   Catalog metadata (server-side).
  xp.js                      WCPM tables, points-for-book, ratio
                             table (quizOutcome × retellOutcome).
  tracks.js                  Track-locking (admin gates books per kid).
  moderation.js              Comment + quiz safety classifier.
  observability.js           trackEvent / trackError → Redis log.
  caliper.js                 IMS Caliper event emission for TimeBack.
  timeback-sync.js           Pulls working-grade overrides via
                             persistQueryToAPI on a Vercel cron.

docs/
  book-summaries/<id>-*.md   Hand-authored book summaries — the only
                             editorial source. NO LLM enrichment.
  book-summaries/RULESET.md  Authoring rules for summaries.
  book-questions/<id>.json   Pre-authored quiz banks — the only quiz
                             source. NO runtime LLM generation.
  book-questions/README.md   Authoring rules + format for question banks.
  MEMORIES.md                This file.

index.html                   The whole client. One file. Hand-rolled
                             vanilla JS, no framework. ~9000 lines.

vercel.json                  CSP, security headers, runtime config.
```

`scripts/` is intentionally empty. The previous `enrich-catalog.js`
script and `rag-experiment.*` files were deleted — both were
artifacts of the LLM-enrichment era we've moved past.

## 4. The quiz pipeline (current architecture)

**Critical history:** we tried LLM-at-runtime three different ways
(legacy summaries, enriched book-records, summaries-only with
deterministic checks). All produced hallucinations. **Final
architecture: static question banks authored OUTSIDE the app.**

```
External authoring agent  (Claude or similar, NOT in production)
  reads docs/book-summaries/<id>-*.md
  writes docs/book-questions/<id>.json
  format spec in docs/book-questions/README.md

External QC agent         (separate, also outside the app — TODO build)
  reviews each generated question against the QC checklist below
  flags telegraphed / circular / self-referential / grade-vocab issues
  returns either "pass" or list of fixes needed

Human review              (Nick, before committing)
  open the .json, verify every question + answer + 4 distractors

Commit + push             Vercel rebuild picks up the file

App at request time:
  /api/quiz?bookId=...&v=<schemaVersion>
    → BOOK_QUESTION_BANKS map lookup (loaded at module init)
    → attachAnswerTokens (HMAC each question's correct index)
    → strip raw answer index (admin sees it, kid doesn't)
    → respond with questions + answerToken per Q

Client picks 5 of 12 randomly, shuffles options per Q.

On submit, /api/activity quiz_submit:
  for each answer: verifyQuizAnswer(bookId, qText, chosen, token)
  recomputes HMAC, compares — no Redis pool lookup needed
  → grading is self-contained, schema changes can't break it
```

### QC checklist (every question must pass)

1. **Telegraphing** — question stem must not contain words that
   match the correct answer. ("What is the cookbook called?" with
   answer "How to Cook" — REJECTED.)
2. **Circular** — answer text must not appear verbatim in the
   question. ("What color socks does she wear?" → "Yellow socks"
   when "yellow socks" was already in the question — REJECTED.)
3. **Self-referential distractors** — distractor must not use the
   question's subject noun. ("What do fish have?" with "A fish"
   as a distractor — REJECTED.)
4. **Grade-inappropriate vocabulary** — no "narrator" /
   "protagonist" / "theme" / "perspective" for PK/K/G1. Say "the
   person telling the story" / "the main kid" / "the lesson".
5. **Parallelism** — all 4 options share determiner / number /
   form. No 3-vs-1 mismatch (e.g. "A car / A wagon / A scooter /
   His bike" — REJECTED).
6. **Source grounding** — every fact in question + answer must
   trace to a line in the hand-authored .md.
7. **Closed-list distractors** — distractors should use other
   content FROM the same book where possible (other characters,
   other items). Generic real-world distractors are weaker.
8. **No exclusionary phrasing** — no "besides" / "except" /
   "not" / "never" / "doesn't" — K-2 can't reliably parse
   negation.

### Cache invalidation — two axes

| Bump when | What invalidates |
|---|---|
| `SCHEMA_VERSION` in `api/quiz.js` | Generation/grading pipeline changes |
| `version` in `<bookId>.json` | Question content edits |

Both stamps land on the client's saved-quiz-progress blob in
localStorage. `loadQuizProgress` invalidates if either is stale.

### HTTP cache

`/api/quiz` sends `Cache-Control: no-store`. Client appends
`?v=<schemaVersion>` so any old cached URL becomes a new cache key
(forces a fresh fetch even for kids whose browsers cached the old
24h max-age responses).

## 5. The retell pipeline

Voice-only path that runs AFTER quiz pass. Whisper transcribes the
kid's audio; GPT-4o grades against a 4-axis rubric
(retell_quality, character_recall, event_recall, stayed_on_topic,
**each 0-3, max 12 total**). The grader is grounded in the
hand-authored book summary and uses a 3-bucket anti-guessing rule:
pure genre tropes score 0, accurate-but-simple references to the
book's actual content score 1 (partial credit so simple-spoken /
ESL readers aren't failed), specific/rich detail scores 2-3.

XP outcome tiers (lib/xp.js retellOutcomeFromRubric):
≥10/12 = clear pass (p1), 7-9/12 = marginal (p2), <7/12 = fail (fF).

### Second-chance flow (#85, revised #24)

1. Kid answers initial open-ended question.
2. **Preliminary grade** (gpt-4o-mini): if total ≥ 10/12 AND every
   axis non-zero → clear pass, finalize immediately, award bonus XP.
3. Otherwise → tutor asks one targeted follow-up probing the
   weakest axis.
4. After turn 2 → commit-mode grade. Pass = final ≥ 7/12. (No longer
   requires beating the preliminary — being right is the bar, not
   improving on yourself; #24.)
5. `null` verdicts only fire on grader infrastructure faults →
   held-XP queue.

## 6. XP

Computed in `lib/xp.js` per reading session:

```
xp = readingMin × ratio
where:
  readingMin = wordCount / WCPM(workingGrade)
  ratio comes from a table keyed by (quizOutcome, retellOutcome)
    p1 + p1 (passed both, first attempt) → 1.3×
    p2 + p1 (passed quiz on retake)       → 0.95×
    ... etc, fF + fF → 0
```

WCPM by working grade: PK=15, K=30, 1=60, 2=100, 3=110, 4=130, 5=140.

Example: One Fish Two Fish (619 words):
- PK reader: 619/15 × 1.3 ≈ **64 XP max**
- K reader: ≈ **37 XP max**
- G1 reader: ≈ **23 XP max**
- G2 reader: ≈ **18 XP max**
- G3 reader: ≈ **17 XP max**

**The XP stat at the top of the page reads from `/api/leaderboard`,
NOT from `/api/auth/me`.** `refreshMyRank()` is the function that
updates it. `renderStats()` updates books/streak/comments but NOT
XP. After any server-side XP change (retell completion, quiz
pass, etc.) you must call BOTH `renderStats()` AND
`refreshMyRank()`. The retell-done handler does this as of the
latest deploy.

## 7. Admin

`ADMIN_EMAILS` env var on Vercel (comma-separated, case-insensitive
match). Current intent: **only `nick.alsford@trilogy.com`**.
Verify both `production` and `preview` environments in Vercel
dashboard → Settings → Environment Variables.

Admin gets:
- Full quiz pool with answer key visible (green outline + ✓ correct).
- Unlimited quiz retries.
- Admin menu in the header.
- Skip wait button (bypasses the "you just started reading"
  cooldown).
- ♻️ Regen Quiz button (wipes localStorage + in-memory state;
  with static banks it doesn't bust Redis since there's nothing
  to bust).
- Per-answer debug box on the result screen.

## 8. Security guardrails (shipped)

- Google JWT verified against JWKS at sign-in.
- CSP with allowlisted `img-src` (covers.openlibrary.org,
  *.openlibrary.org, archive.org, *.archive.org for OL's redirect
  chain, *.googleusercontent.com, books.google.com),
  `connect-src`, `script-src`.
- HSTS, COOP, `X-Frame-Options: DENY`, Permissions-Policy locked.
- Per-email rate limits on /tts, /quiz, /tutor, /activity,
  /leaderboard, /admin, selfData (5/hr).
- HMAC quiz answer tokens (no Redis lookup at grade time).
- All localStorage scoped under `rs.*` prefix; logout wipes them.
- Held-XP queue for borderline retells; admin approves.
- Comment moderation (3-tier: block / review / allow) with TTL'd
  held queue.
- Pre-quiz "you just started reading" warning, per-grade thresholds
  (PK/K 15min, G1 30min, G2+ 60min).

## 9. Privacy

- `parent-data` requests now go through admin approval (not
  self-service). `POST /api/auth/me?action=request-data` and
  `?action=request-deletion` queue a pending request.
- `users:tombstoned` Redis set blocks writes after a delete.
- Comments stored with HMAC email hash, not raw email.
- Leaderboard masks grade cohorts < 5 members (anonymous +
  bucketed).
- COPPA / GDPR endpoints exist (exportUserData / deleteUserData)
  but only run via admin approval now.

## 10. Authoring workflow (the static bank flow)

1. Hand-write the book summary in
   `docs/book-summaries/<id>-<title-slug>.md`. Use the format in
   `docs/book-summaries/RULESET.md`. Commit when ready.
2. Run the external **quiz-authoring agent** (NOT part of the
   app). It reads the .md, produces a draft `<id>.json` in
   `docs/book-questions/`.
3. Run the external **QC agent** against the .json. It applies
   the QC checklist (Section 4) and returns pass / fixes-needed.
4. Iterate steps 2-3 until clean.
5. Bump the `version` field in the JSON.
6. Commit + push. Vercel picks it up; kids' saved progress
   auto-invalidates via the bankVersion stamp.

If a question bank is missing or invalid, the book returns
`no_quiz_questions: 503` and the kid sees a clear "Quiz not ready"
message. The app does NOT fall back to LLM generation.

## 11. Open TODOs (post-launch nice-to-haves)

### High impact
- **Grade 4-8 catalog expansion** (#18) — only Grade 3 is shipped.
- **External QC agent** — build the standalone QC tool that runs
  the checklist (Section 4) over a generated `<id>.json`.
- **iPad / tablet usability** (#35, #72) — retell mic + audio
  playback on Safari needs verification.
- **Admin audit log** (#49) for user-diag and users actions.
- **Comment-review queue SLA** (#64) + admin alert when pending grows.

### Medium impact
- **Caliper retry queue overflow alert** + schema-version drift
  monitor in `/api/health` (#63).
- **Rate-limit `/api/auth/me`** and other read endpoints (#66).
- **TRACK_LEVEL hardcoded client-side** drift risk (#65) — same
  pattern we just closed for SCHEMA_VERSION.
- **TimeBack Cognito refresh-token rotation** + admin alert on
  auth_failed (#54).
- **Retell anti-cheat** (#83) — detect verbatim summary recitation.
- **Live transcript in retell** (#78) — kid sees their words as they speak.
- **Observability hardening** (#68) — alert routing + longer
  retention + error grouping.

### Low impact
- **Moderation false-positives** on innocent text ("sextet" /
  "essex") (#61).
- **Adaptive instructional copy** based on working + age grade (#70).
- **Audio retention beyond 14 days** (post-launch policy review) (#73).
- **Parent portal** — read-only dashboard + held-XP approvals (#74).
- **Pre-auth welcome screen v2** — parent-facing content (#75).
- **Parent-confirm popup for held XP** — release sooner (#69).
- **Caliper transport HTTPS startup assert** (#67).

## 12. Operational gotchas

- **Vercel Hobby tier caps at 12 serverless functions.** That's
  why admin endpoints are all behind `/api/admin?action=...`.
- **Vercel preview URLs change per commit.** Google OAuth only
  trusts the `git-dev` branch alias — always test there.
- **`ADMIN_EMAILS` is env-only.** Setting it in code would leak.
- **Hard refresh ≠ load fresh JS** if the browser already has the
  page in its disk cache and the URL/headers haven't changed. The
  cache-buster `?v=...` on `/api/quiz` is what guarantees a kid
  picks up new bank content.
- **`state.session.quizSchemaVersion`** on the client refreshes
  at every `openQuiz` call (re-fetches `/api/auth/me`) so a
  server-side schema bump invalidates kids' saved quizzes without
  requiring a hard refresh.
- **localStorage quiz progress** is stamped with BOTH
  `schemaVersion` and `bankVersion`. Either mismatching wipes the
  blob. SCHEMA bumps when the generation/grading pipeline
  changes; bank version bumps when question content edits.
- **`process.cwd()` in serverless functions** resolves to the
  project root on Vercel. `docs/book-summaries/` and
  `docs/book-questions/` are both readable at runtime — that's
  how the loaders work at module init.

## 13. Last-known commits worth referencing

- **HMAC answer tokens** (12fd101) — grading self-contained, no
  Redis lookup at submit.
- **Static question bank** (263756d) — runtime LLM removed
  entirely.
- **bankVersion + schemaVersion dual invalidation** (3e9f2b1) —
  content edits and pipeline changes are independent.
- **Code audit cleanup** (c66b5d8) — 371 lines of stale LLM-era
  code removed.
- **Per-grade pre-quiz warning thresholds** (bab2b1b) — PK/K 15min,
  G1 30min, G2+ 60min.
- **Retell second-chance rubric** (8573d17) — early-pass + targeted
  follow-up + score-must-increase rule.
