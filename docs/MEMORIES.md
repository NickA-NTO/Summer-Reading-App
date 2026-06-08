# MEMORIES — Reading Spine session context

Created 2026-06-03 as a pre-compaction snapshot. If you're a future Claude reading this, treat it as authoritative for everything that happened before whatever "now" you're in. Cross-check with `git log dev --oneline` and the TaskList tool for the live state.

---

## 0. The user

- **Nick Alsford** (nick.alsford@trilogy.com) — sole admin, sole developer
- Communication style: direct, factual, bullet-heavy, no fluff. Wants concrete numbers and specific examples. Pushes back on over-engineering. Asks for tables and console snippets when the work is mechanical.
- Hard preferences (do not violate):
  - **"Use XP, not points. Kids know what XP is."** Every kid-facing string says XP.
  - **"I should be the only one"** — admin. ADMIN_EMAILS is just him.
  - **"No teachers. Don't ever suggest having a teacher do something again."** Use "guide" or "admin" instead.
  - **"Shouldn't need empty commits going forward."** Don't use `git commit --allow-empty` for ANY reason. Make a real change or use the Vercel dashboard redeploy button.
  - **"Student comments show as First L."** (first name + last initial only — privacy).
  - Tour TTS speakers should not overlap when clicked quickly (shipped — keep working).
  - Fake comments/upvotes in seed data should be removed (still pending #46).

---

## 1. The app

- **Name**: "Alpha Summer Reading" (internal repo name: `reading-spine`)
- **Production URL**: https://reading-spine.vercel.app
- **Preview / dev URL** (stable branch alias): https://reading-spine-git-dev-alpha-academics-projects.vercel.app
- **GitHub**: https://github.com/NickA-NTO/Summer-Reading-App
- **Local path**: `C:\Users\nicka\OneDrive\Desktop\Reading Spine App`
- **Vercel project**: `reading-spine`, **Hobby tier** (12-function ceiling — currently AT 12)
- Pre-launch: **no real student users yet**. Free to break things on dev; main is what real kids will eventually use.

### Stack
- Single-file frontend `index.html` (~6900 lines, ~1500 CSS + ~5400 JS, 133 functions, ~52 inline innerHTML templates)
- Backend: `/api/*` Vercel functions (Node 24, Fluid Compute default)
- State: **Upstash Redis** (KV_REST_API_URL / KV_REST_API_TOKEN env vars)
- Audio + TTS cache: **Vercel Blob** (currently `access: "public"` — privacy risk noted)
- Auth: **Google OAuth** (HD claim + email_verified; **signature NOT verified** — #58 pending)
- LLMs:
  - **Anthropic Claude Opus 4.5** (`claude-opus-4-5`) for quiz generation (multi-pass cross-validation, 3 temperatures, QC review pass)
  - **OpenAI GPT-4o** for retell tutor conversation
  - **OpenAI GPT-4o-mini** for per-turn topic moderation
  - **OpenAI `whisper-1`** for retell transcription
  - **OpenAI `tts-1`** for voice (dev) — production still has `gpt-4o-mini-tts` (slower, more expressive)
- Allowed sign-in domains: `alpha.school, trilogy.com, superbuilders.school, 2hourlearning.com, gt.school` (env: `ALLOWED_DOMAIN`)
- Crons (`vercel.json`): TimeBack sync daily 06:00 UTC, Caliper drain daily 06:30 UTC (Hobby = daily only, no */15)

### Key file map

| File | LOC | What |
|---|---|---|
| `index.html` | 6863 | Whole client. Header, stats, hero, catalog, book modal, quiz overlay, retell overlay, admin overlay, leaderboard overlay, achievements overlay |
| `lib/store.js` | 1359 | All Redis. Reading sessions, attempts, fraud state, held XP, comments, achievements, leaderboard zincrby |
| `api/quiz.js` | 1119 | Multi-pass quiz generation + QC + cache. `getCachedQuizPool(bookId, grade, ageGrade)` lives here |
| `api/activity.js` | 819 | Quiz submit + read recording. **~385 lines of dead code post-#9 refactor** (post-quiz_submit fall-through is unreachable) |
| `api/admin/index.js` | 631 | All admin actions via `?action=` routing |
| `api/tutor.js` | 624 | Retell server: start / turn / grade actions |
| `lib/tutor.js` | 425 | Retell helpers: sessions, OpenAI calls, Whisper, hallucination filter, grader |
| `lib/xp.js` | ~250 | `OUTCOME_RATIOS` table + `xpForReadingSession()` |
| `lib/tts.js` | ~150 | OpenAI TTS wrapper. Cache prefix `v4`. Voices `{nova,shimmer,coral,ash,fable}` |
| `lib/moderation.js` | 245 | Three-tier comment classification (block/review/allow) |
| `lib/timeback.js`, `lib/timeback-sync.js` | ~300 | Caliper transport + grade-sync cron logic |
| `lib/caliper.js` | 223 | Caliper envelope builder |
| `lib/observability.js` | ~80 | `trackError(category, err, ctx)` and `trackEvent` — **bug: called with `{err}` object as 2nd arg in 11 places, dropping context** |
| `docs/Reading-Spine-Technical-Brief.md` | new | Spec doc I just wrote, mirroring the AR brief format |
| `docs/MEMORIES.md` | this file | |

---

## 2. Branch state — CRITICAL

- **`main` (production, on `reading-spine.vercel.app`)**: latest `d0b68f0`. Quiz-only flow, OpenAI TTS via `gpt-4o-mini-tts` (slower model), hero filter, anti-cheat counters (#40/#41), admin track-locking. **No retell tutor.**
- **`dev` (preview, on `reading-spine-git-dev-...vercel.app`)**: **20+ commits ahead of main, latest `070a2bd`-ish**. Has the entire #9 conversational retell tutor + atomic XP model + admin tools + cache-key fix + tts-1 swap + 15-min countdown + book modal cleanup + dev/prod env split.

**EXPLICIT USER DIRECTIVE**: do NOT promote dev → main. Voice retell tutor "is not working as expected" per the user. The dev branch is the working iteration lane until they explicitly approve a promotion.

**OpenAI voices ARE already on production** and "working" (just slower model). User confirmed this is fine.

The user reviewed the **customer-facing roadmap** version multiple times and finalized it as the "What's Coming" outline. Don't push the "Just Launched" items to main unprompted.

---

## 3. The atomic XP model (final, agreed)

After much back-and-forth (5+ iteration rounds with tables), the user signed off on this exact shape:

### Time formula (flat — NO attempt-count scaling)
```
totalMin = readingMin + quizMin + retellMin
readingMin = wordCount / WCPM_BY_GRADE[workingGrade]
quizMin    = 1 min/question (5 min standard, 3 min emergent)
retellMin  = 3 min flat
```

### Ratio table (lib/xp.js OUTCOME_RATIOS)
```
p1_p1: 1.30   # both clean — 30% bonus
p1_p2: 1.15   # one retake — 15% bonus
p2_p1: 1.15
p2_p2: 0.55   # both messy — real penalty
p1_fF: 1.00   # one section clean, other failed → baseXP
p2_fF: 0.70   # one section attempt-2, other failed
fF_p1: 1.00
fF_p2: 0.70
fF_fF: 0.00
```

### XP formula
```
xp = floor(ratio × totalMin)
```

### Cap
- **2 quiz attempts + 2 retell attempts per book, PERMANENT.** No daily reset, no 72h rolling. Admin can reset via the `reset-my-book` endpoint.
- `QUIZ_ATTEMPT_TTL_SEC = 365 days` (effectively forever)
- Client `getAttemptRecord` no longer resets on date change

### Notes the user explicitly approved
- Flat 30% bonus (NO sliding cap by book size — they reversed earlier "sliding scale" decision)
- "Pass 1 of 2 on first attempt = baseXP exactly" — even if the other section failed
- Mid-session close → 0 XP, both attempts consumed (confirmation prompt fires first)
- Retell auto-launches **even if quiz failed** (redemption path)

---

## 4. Open critical issues NOT YET FIXED

These came out of the production audit I ran (general-purpose agent). User has seen them but they're not ticketed yet. Listed in the backend list as "code-quality (from audit, not yet ticketed)" — items 20-24 in their renumbered backend display:

1. **Dead code**: ~385 lines in `api/activity.js` post-`quiz_submit` (the fraud detection + recordRead fall-through path). Unreachable after the #9 atomic refactor because every book has a quiz and `kind:"read"` is rejected for quiz-enabled books. ~10% of total codebase.
2. **`trackError` arg-shape bug**: Called as `trackError(cat, {ctx})` in 11 places, but signature is `trackError(cat, err, ctx)`. Result: every observed error logs message `[object Object]`. Daily Redis counters still tick, but message body is useless for triage.
3. **Open-redirect in `api/auth/callback.js:130-132`**: `next` param accepts `//evil.com/foo` because the check is only `startsWith("/")`.
4. **XP estimate drift**: Client computes `quizMin=3/2` (old), server uses `5/3` (new). Every quiz pass shows the kid ~2 fewer XP than they actually got.
5. **Error message API-key leakage risk**: Catch-all 500s in `api/tutor.js`/`api/quiz.js`/`api/activity.js` pass `err.message.slice(0, 300)` to the client. OpenAI/Anthropic error strings can contain key fragments ("Incorrect API key provided: sk-...XXX"). Sanitize before returning.

The user did a security audit pass and confirmed:
- No hardcoded keys ✓
- No `.env` files in git ✓
- Session cookie is HttpOnly + Secure + SameSite=Lax ✓
- `env-check` only returns presence booleans, never values ✓
- `user-diag` returns user data, no tokens ✓
- Vercel Blob retell audio is `public` — child-voice privacy risk (low because URLs use UUIDs), not API keys

#79 (cache-key mismatch) was the critical 0/5-grading bug. **Fixed on dev**, awaiting promotion.

---

## 5. Task list state (as of 2026-06-03)

User split into two layers and renumbered locally. Display labels are local 1..N per layer; underlying task IDs are global 1..79.

### 🟢 Active
- **#1 (display) — Polish UI** — frontend-led, just told me to start in preview. **Phase 1 plan presented, awaiting their go before I execute.** Phases 1-3 outlined below.

### 🛠️ Backend / Technical (24 items)
Security & Privacy:
1. Security vulnerability audit *(umbrella, task #19)*
2. Moderation block list expansion (#44)
3. Admin audit log (#49)
4. Security headers + CSP (#50)
5. Held-comment TTL + email hashing (#52)
6. Google JWT signature verification (#58)
7. Parent data export + delete (#59)
8. Rate-limit /api/auth/me (#66)
9. Caliper transport HTTPS assert (#67)

AI / Content:
10. LLM safety pass on AI quiz content (#60)
11. Moderation false-positives "sextet/essex" (#61)
12. Audio-recording retention policy review (#73)

Data / Drift:
13. Leaderboard masking for small cohorts (#53)
14. `markedCorrect` undefined after answer-strip (#62)
15. `TRACK_LEVEL` hardcoded client-side (#65)

Observability / Ops:
16. TimeBack Cognito refresh-token rotation (#54)
17. Caliper retry queue alerts + schema drift (#63)
18. Comment review queue SLA (#64)
19. Observability hardening (#68)

Code-quality (UN-TICKETED, from audit):
20. Purge ~385 lines dead code in api/activity.js
21. Fix `trackError` arg-shape (logs `[object Object]`)
22. Close open-redirect in api/auth/callback.js
23. Resolve client/server XP estimate drift
24. Sanitize error messages to prevent key-fragment leak

### 🎨 Frontend / UI & UX (14 items)
1. **Polish UI** (the active one — see Section 6)
2. Grade 4–8 catalog (#18)
3. Remove fake comments/upvotes from seed (#46)
4. Spotlight currently-reading book in catalog (#76)
5. Hero CTA verb mismatch (#56)
6. iPad Safari support for tutor (#72)
7. Live transcript in retell (#78)
8. Parent-confirmation popup for held XP (#69)
9. Parent portal (#74)
10. Welcome screen parent content v2 (#75)
11. Student comments as "First L." (#47)
12. Clear localStorage on logout (#48)
13. iPad usability (#35)
14. Adaptive instructional copy (#70)

### Completed milestones worth remembering
- #9 conversational retell tutor server + client (on dev only)
- #32 OpenAI TTS migration (on main with gpt-4o-mini-tts, dev with tts-1)
- #39 Hero filter by visible tracks (on main)
- #40 Server-side daily attempt counter (now permanent — on dev)
- #41 Quiz-open tracking
- #71 Dev/prod environment split with Redis prefix
- #77 Active tag clears after retell finalize
- #79 Cache-key mismatch (the 0/5 grading bug — fixed on dev)

### Deleted
- #55 "For parents" welcome panel — user rejected v1, will revisit as v2 (#75)
- #57 Tighten fraud freshness window — user said leave as-is, kids may already own the book

---

## 6. Active work: UI/UX polish (Phase 1 plan, awaiting sign-off)

User asked me to "begin this process in the preview environment". Said "we need to simplify while still being functional and awesome". Counted ~15 widgets above the fold on the home page.

### Phase 1 — Header simplification (proposed, NOT executed)

| Currently | After |
|---|---|
| `🔊 Text to Speech` label + voice dropdown + on/off switch (3 widgets) | Single **🔊** button — tap toggles on/off, long-press opens voice picker popover |
| `?` help button | Removed — "Replay intro tour" already exists in avatar menu |
| Brand: "Alpha Summer Reading" + "ALPHA SCHOOL" subtitle | Just "Alpha Summer Reading" — drop subtitle |
| Stats row: 5 metric chips (XP, books, reviews, rank, currently reading) | 2 chips — XP + currently reading. Books read / reviews / rank move to leaderboard page and achievements modal |
| Filter row: Grade dropdown + Genre dropdown | One **Filter** button → popover with both |

Net: 15 → 7 visible widgets, same functionality.

### Phase 2 — Book modal (planned)
Pills currently: Grade / Category / XP / Rating (4). Cut to XP + reading time (2).
Action buttons currently: I'm reading this / Done / Take Quiz / Vote up / Vote down / Amazon / Reset-for-me (admin) — collapse vote up/down into a single "Did you like it?" after read; Amazon to a less prominent spot.

### Phase 3 — Catalog & global (planned)
Tighter card spacing, cleaner row headers, type scale unification, button-style consistency pass.

### Last instruction received before this memory dump
> "These tasks should only be initiated within the preview environment for now and only rolled out into production when explicitly approved by me."
> "Begin this process in the preview environment. Once complete, add a task #1 to backend to check the preview app for code bloat and refinements."

So: when polish is complete (all 3 phases), **add a new task at the TOP of the backend list** for "audit preview for code bloat + refinements".

---

## 7. Architecture and conventions that matter

### Conventions
- **No "teachers"** anywhere in code or copy
- **XP not points** in all kid-facing strings
- **Server-resolved grade** (never trust client `body.grade`)
- **Track-locking gate is duplicated 4×** across endpoints — same logic, different inline implementations (audit flagged this)
- **Email is the primary key** everywhere. Lowercased. `email.toLowerCase()` defensively.
- **`isAdmin(email)` bypass** is added to gates that admin would hit testing (attempt counter, 15-min countdown, track-locking). NOT bypassed: fraud detection (it's already light-touch).
- **`process.env.VERCEL_ENV`-keyed Redis prefix**: `""` (production), `"preview:"`, `"development:"`. Wraps the Upstash client via Proxy so prefix is auto-applied to single-key methods.
- **`@vercel/blob`**: TTS at `tts/{hash}.mp3`, retell at `tutor/{date}/{sessionId}/turn-N.webm`, both currently `access: "public"`.

### Magic constants
- `STARTED_RECENTLY_HOLD_MS = 1 hour` (per-book quiz-after-reading-claim floor)
- `FIRST_OPEN_SUSPICION_HOURS = 6` (acquisition-time fraud check)
- `FRAUD_RATIO_HOLD = 0.25`, `FRAUD_RATIO_SOFT = 0.5` (WCPM speed ratios)
- `QUIZ_DAILY_ATTEMPT_LIMIT = 2` (permanent, despite the name)
- `RETELL_TIME_MIN = 3`
- `QUIZ_MIN_PER_QUESTION = 1`
- `SCHEMA_VERSION = 8` (quiz cache key version)
- TTS cache prefix: `v4`

### Catalog
- 57 books across 5 tracks:
  - `e` Beginning Readers (PK, 12 books)
  - `k` Grade K (11 books)
  - `a` Grade 1 (14 books)
  - `b` Grade 2 (12 books)
  - `c` Grade 3 (8 books)
- G4-8 expansion pending (#18) — single biggest scope item left

### Identity flow
- Google OAuth → kid signs in with school email
- `state.session.email` is the canonical id
- `state.session.isAdmin` from `/api/auth/me` (server uses `ADMIN_EMAILS` env)
- TimeBack `studentId` is fetched daily but NOT persisted on Redis profile (#74 / Section 8 of the brief)

### Workflow
- Develop on `dev` → preview auto-deploys
- Manual promote: `git checkout main && git merge dev --no-ff && git push`
- DO NOT auto-promote. User signs off explicitly.
- Cherry-pick option exists (`git cherry-pick <sha>`) if user wants one specific commit on main

---

## 8. Things the user has explicitly punted or rejected

- **#57 Tighten fraud freshness window** — REJECTED. "Some kids may own the book already." Leave 1h / 6h thresholds.
- **#55 v1 welcome screen parent panel** — REJECTED on aesthetic grounds. Will revisit as v2 (#75) with different approach (maybe popup/modal triggered from "For parents" link rather than inline card).
- **Live transcript in retell (#78)** — wanted but deferred to after retell core works
- **Realtime API for tutor** — discussed, deferred. Sequential mode is v1.
- **iPad voice support (#72)** — known gap, separate task. Chrome-first for now.
- **Sliding bonus by book size** — user initially wanted but reversed in favor of flat 30%
- **"Try again tomorrow" wording** — user rejected because the cap is permanent, not daily

---

## 9. Recent significant pivots / decisions

- **2026-05-XX**: User decided "2 attempts ever per book, no daily reset". Changed both server TTL (72h → 365 days) and client localStorage (dropped daily-reset branch).
- **2026-05-XX**: User wanted ratio model where ratio applies to total time (reading + quiz + retell). Pass-1-of-2 on attempt 1 = baseXP exactly. No sliding bonus by book size.
- **2026-05-XX**: User asked for fully conversational tutor (not quizmaster-style). System prompt rewritten with reactive examples, temperature bumped 0.7 → 0.95, frequency/presence penalties added. Banned "Awesome" / "Nice" default opener.
- **2026-06-XX**: User found Whisper hallucinating "Thank you for watching". Filter added in `lib/tutor.js transcribeAudio` + prompt-bias with book context.
- **2026-06-XX**: User found cache-key mismatch (the 0/5 grading bug). Fixed.
- **2026-06-XX**: User added `gt.school` to ALLOWED_DOMAIN.
- **Today (2026-06-03)**: User wants UI polish in preview, no prod promotion until they say so.

---

## 10. Open questions waiting on user input

These are not on the task list but came up in conversation and don't have decisions yet:

1. **Polish UI Phase 1**: which specific cuts to keep — TTS as switch or stateful button? Which metric chips visible? Filter as popover or inline? (Asked just before this memory dump was requested.)
2. **TimeBack store integration**: Caliper schema sign-off (Section 7 of the brief). Identity field format (email vs studentId). Idempotency key.
3. **Audio retention policy**: 14-day default OK pre-launch; needs parent-portal pairing (#73) once parents enter the picture.
4. **Parent portal auth**: password (option A in #74) vs magic link (option B). User leaned A but not locked in.
5. **iPad retell**: ship v1 to production without iPad parity, or hold until #72 is done?

---

## 11. Files to NEVER touch without permission

- `vercel.json` cron schedules — Hobby tier only allows daily
- `.gitignore` — already covers all sensitive patterns
- `package.json` engines field (Node ≥20)
- Anything under `.claude/`
- Direct edits to `main` branch (always go through `dev → merge → push`)

---

## 12. If you need to verify branch state RIGHT NOW

```bash
cd "C:\Users\nicka\OneDrive\Desktop\Reading Spine App"
git branch --show-current        # should be `dev`
git log main..dev --oneline      # commits ahead of main
git log dev --oneline -5         # recent commits on dev
git status --short               # uncommitted changes
```

If `dev` is way ahead of `main`, that's expected — the whole #9 retell tutor + polish work lives there.

---

## 13. The most important paragraph

**Do not push to `main` without explicit approval from Nick.** The voice retell tutor on dev "is not working as expected" per his words. The previous successful promotion was `d0b68f0` (Bundle B + dev/prod split). Everything since is dev-only. Production is currently quiz-only with the older OpenAI TTS model — and Nick has confirmed that's fine while the retell stabilizes.

The user's testing has surfaced a long tail of small bugs in the retell flow (mic permission delays, TTS dropouts on turns 2/3, Whisper hallucinations, the cache-key 0/5 grading bug). Most are fixed on dev but he hasn't done end-to-end signoff yet.

The UI/UX polish work I'm about to start does NOT change the retell mechanics; it's purely surface-level simplification. Stay surgical.

---

*End of memory dump. Read SECTION 6 carefully before resuming work — there's a specific question awaiting user response that should resolve before any code changes.*
