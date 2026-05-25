# Reading Spine — TODO

Planning doc for the next round of features. Lives next to the code so it stays
current. Strike items as they ship.

## Current state (shipped)

- [x] Netflix-style browse UI with grade-organized rows (K / 1 / 2)
- [x] 28 real K-2 books with covers from Open Library + gradient fallbacks
- [x] Per-user votes, comments, reads, streak (localStorage)
- [x] Text-to-speech with natural-voice picker + global toggle
- [x] Google OAuth gated to `alpha.school`, `trilogy.com`, `2hourlearning.com`
- [x] GitHub repo + Vercel auto-deploy from `main`
- [x] **AI-generated quizzes for all 28 books** — `/api/quiz` calls
      **Claude Haiku 4.5** through the AI SDK with a zod schema; server
      caches a 12-question pool per book in Redis. Client picks **5 at
      random per attempt** with shuffled option positions, so kids can't
      memorize answer locations across attempts. **Max 2 attempts per
      book per day, need 4/5 (80%) to pass.** _Still needs grade-leveled
      difficulty (see section 1c) and quiz-integrity additions (see
      section 1d)._
- [x] **Admin user list** — `/api/admin/users` returns everyone who has
      signed in, gated by the `ADMIN_EMAILS` env var. Modal accessible from
      the avatar dropdown for admins, with search and last-active / books-
      read columns. Login events are tracked in Redis on every successful
      OAuth callback.
- [x] **Text-to-speech defaults to off** — kids opt in via the header switch.
- [x] **Amazon (US) "Buy this book" link on every book** — ISBN-13 → ISBN-10
      conversion, direct `/dp/<asin>` URLs, optional `AMAZON_AFFILIATE_TAG`
      via a `<meta>` tag.
- [x] **Leaderboard** — `/api/activity` logs reads to Upstash Redis sorted
      sets (all-time + per-ISO-week), `/api/leaderboard` returns top 25 with
      masked names. Modal accessible from the header nav; user's rank shows
      in the stats strip.

---

## 1. Internal quizzes (proof-of-reading)

**Goal:** Kids can't vote or earn streak credit until they pass a short quiz on
the book they claim to have read.

### Decisions needed
- [x] **Question source**: AI-generated (Claude Haiku 4.5)
- [x] **Pass threshold**: ~~3 of 4~~ → **4 of 5 (80%)** per spec update
- [x] **Retries**: max 2 attempts per book per day, then 24-hr cooldown
- [x] **Where to store questions**: `/api/quiz?bookId=...` with Redis cache

### Data model
```js
// Quiz cache key now includes grade: quiz:v3:<bookId>:<studentGrade>
{
  bookId: "k01",
  studentGrade: "2",     // the QUIZ-TAKER'S grade, NOT the book's grade
  questions: [
    {
      q: "Why do you think the caterpillar got a stomach ache on Saturday?",
      options: ["He ate too much junk food", "He was sad", "It was cold", "He ran a race"],
      answer: 0,
    },
    ...
  ]  // exactly 5 questions
}
```

### Build steps
- [x] Define quiz schema + `/api/quiz` endpoint (pilot for k01)
- [x] Migrate from 4 to **5 questions per attempt**, raise threshold to **80% (4/5)**
- [x] Backfill plot summaries for the remaining 27 books in `api/quiz.js`
      (pool bumped to 12 questions/book to set up section 1d.1)
- [x] Quiz UI component (one-question-at-a-time, big tap targets, K-2 friendly)
- [x] Pass/fail screen with "Try again" or celebration animation
- [x] Gate the existing "I read this" / vote / comment buttons behind a pass
- [x] Track per-user quiz state in localStorage (server tracking is TODO)
- [x] Auto-read questions aloud when the global TTS toggle is on

### Stretch
- [ ] Adaptive questions — get harder if a kid keeps passing first try
- [ ] Admin quiz-builder UI (drop in a paragraph, generate 4 questions via
      AI Gateway)

### Accuracy — open issues (status 2026-05-22)
- [x] **Upgraded generation model** from Claude Haiku 4.5 to **Opus 4.5**
      (~10x cost but materially fewer hallucinations). Catalog regen
      cost: ~$0.03 (still tiny).
- [x] **QC agent** (second Opus 4.5 pass) reviews each generated
      question for accuracy, scores 0-10, drops anything below 7.
      Catches the most obvious hallucinations the generator slipped
      through.
- [ ] **Archive.org / public-domain text RAG** (see new section below)
- [ ] **"Report this question" button** so kids and admins can flag bad
      questions; flagged ones get reviewed and the cache busted.
      See section 1f.
- [ ] **Multi-pass cross-validation** — generate the question pool 3
      times with different seeds, use Opus 4.5 to identify questions
      that appear (semantically) across all 3 runs. Only those make it
      into the final pool. See section 1g.

---

## 1f. "Report this question" workflow

**Goal:** Kids and admins can flag bad quiz questions in real time.
Flagged questions get reviewed; bad ones cause cache invalidation and
regeneration.

### Build steps
- [x] "🚩 Something doesn't look right" button below the quiz options
- [x] Small reason dialog: "Answer seems wrong" / "Not in the book" /
      "I don't understand" / "Other"
- [x] `POST /api/quiz-report` — stores reports in `quiz:reports:pending`
      Redis hash with reporter email, name, reason, full question + options.
- [x] Admin modal gets a "🚩 Flagged questions" section above the user
      table showing pending reports with **Confirm bad** / **Dismiss**.
- [x] Confirming bad calls `bustQuizCache(bookId)` which scans-and-deletes
      all `quiz:v5:<bookId>:*` keys so next request regenerates fresh
      through Opus + QC.
- [ ] **(Stretch)** After N confirmed-bad reports on a book, auto-escalate:
      "Reading Spine has flagged this book's quizzes for repeated review."

---

## 1g. Multi-pass cross-validation

**Goal:** Reduce hallucinations further by only keeping questions that
appear across multiple independent generation passes — the equivalent of
"this is the consensus a model arrives at, not a one-shot guess."

### Algorithm
1. Generate question pool 3 times with different temperatures (0.4,
   0.7, 1.0). 36 candidate questions total.
2. Use Opus 4.5 (or text-embedding-3-small via OpenAI) to compute
   semantic similarity between every pair of questions across runs.
3. Cluster: any question appearing in 2 of 3 runs (similarity > 0.85)
   is "high consensus." Discard one-offs.
4. From the consensus pool, pick the top N=12 by clustering tightness
   (most agreed-upon first).
5. If consensus pool has < 12, regenerate the missing ones with a
   "must be different from these existing questions" prompt.

### Build steps
- [x] Use Claude (Opus 4.5) for the pairwise-comparison clustering call,
      no separate embeddings dependency needed.
- [x] `lib/quiz-validator.js`: clustering + consensus extraction.
- [x] Wired into `api/quiz.js` between generation and QC (cache key
      bumped to v6).
- [ ] _(Future)_ Cost guard: skip multi-pass for books with no flag
      history, always apply for books with ≥1 confirmed bad report.
      Currently always-on; flip QUIZ_MULTI_PASS=0 in env to disable
      globally if costs become a concern.

### Cost
3x generation + 1 embeddings call per book = ~$0.04 per book first
time. Still negligible at catalog scale.

---

## 1i. TimeBack working-grade auto-sync

**Goal:** Stop relying on email heuristics or manual admin edits. Pull the
canonical working grade from TimeBack's mastery system (the same one
that drives our other apps' cohorting).

### Current state
- [x] **Manual fallback**: admin can set per-user working grade via the
      admin modal (dropdown in user table). Grade persists to the user's
      Redis profile and is returned by `/api/auth/me` on next sign-in.
- [x] `resolveWorkingGrade()` in `api/auth/me.js` does: (1) explicit
      Redis profile.grade if set, (2) `guessGradeFromEmail`, (3) "K".
- [ ] **Auto-sync from TimeBack** (the real fix — below).

### Algorithm (mirrors other Alpha apps)

**Step 1 — Canonical source: `rpt2_mastery`**
For each student with a Reading mastery row, read:
```
HMG = rpt2_mastery.highest_grade_mastered    # highest grade AlphaTest passed ≥90%
WG  = rpt2_mastery.working_grade_level       # = HMG + 1, per TimeBack rule
```
Values are -1 (PK) → 0 (K) → 1…12.

**Step 2 — Bucket into cohort (mechanical)**
| Subject | pk2 cohort | g38 cohort |
|---|---|---|
| Reading | WG ≤ 2 (PK–G2) | WG ≥ 3 (G3–G8) |

**Step 3 — Apply manual overrides** (`data/overrides.json → overrides[]`)
For students with a mastery row but the canonical WG is wrong. Three classes:

- **3a. Old-system pass**: student passed under a prior platform AlphaTest
  doesn't recognise. Corrective signal = the TimeBack Reading course
  they're currently enrolled in and actively using. Filter:
  ```
  enrollment exists in rpt2_enrollment for a Reading course
  course.primary_grade_level > canonical WG
  earned_xp > 0 OR active_minutes > 0 in rpt2_daily_activity within last 60d
  ```
  → override to course grade level. (e.g. Marshall Jensen: WG 1 → 4)

- **3b. Mastery test invalidated**: passed but the test was voided
  (admin error, glitch). User asserts correct WG; override directly.
  (e.g. Corinne McGowan: WG 1 → 3)

- **3c. Mastery is too fresh (cohort hygiene)**: student mastered G2
  within last 30 days. RIT growth on Spring MAP still reflects PK-2
  work. Pin WG back to 2 for one more reporting cycle, then drop the
  override next refresh. (e.g. Diego Bash, Charlotte Pogue, Mya Hadnot)

**Step 4 — Apply additions for missing students** (`data/overrides.json → additions[]`)
Students with no Reading mastery row at all (fell out of Step 1). Used
mainly for PK kids working in Mentava:
```
rostered  = exists in rpt2_enrollment WHERE course_id = Mentava
            AND begin_date <= today AND (end_date IS NULL OR end_date >= today)
active    = exists in rpt2_daily_activity WHERE app_name = 'Mentava'
            AND calendar_date >= today - 30
            AND (earned_xp > 0 OR active_minutes > 0)
PK if rostered AND active
```
The rostering check is the critical gate — keeps unauthorized kids off.
Anyone passing both gets WG -1 and is added to pk2.

**Step 5 — Recompute cohort post-override**
After an override flips WG, re-run Step 2. Student may move pk2 ↔ g38.
`highest_mastered` recomputed as `WG - 1` (or null when WG ≤ 0).

### Build steps
- [x] **Access**: resolved via TimeBack Reporting MCP (`getData`
      tool) — read-only SQL against `rpt2_mastery`, `rpt2_student`,
      and friends.
- [x] **Sync function**: `bulkSetWorkingGrades()` in `lib/store.js`.
      Per-row policy: skip non-signed-in users, skip admin overrides
      (unless `force=true`), skip no-op same-grade updates, otherwise
      write with `gradeSetBy: "timeback-sync"`.
- [x] **Admin UI**: paste-JSON panel in the admin modal posts to
      `/api/admin?action=bulk-set-grades`. Shows applied / skipped /
      not-yet-signed-in / errors with full per-row detail.
- [x] **Manual override precedence**: server-enforced — manual `"admin"`
      grades survive sync unless force flag is set.
- [ ] _(Future)_ **Persist the SQL query as a callable HTTP endpoint**
      via `persistQueryToAPI`, then add a Vercel cron at e.g. 4am
      daily that calls it and POSTs the result to bulk-set-grades.
      Closes the manual loop.
- [ ] _(Future)_ **Override file** `data/overrides.json` for the three
      manual override classes (Step 3a/3b/3c). Apply between the
      MCP query and the bulk endpoint.
- [ ] _(Future)_ **PK additions** (Step 4) — for kids with no Reading
      mastery row but active Mentava enrollment.
- [ ] _(Future)_ **Audit log** Redis list `grade:sync:log` surfaced in
      admin UI.
- [ ] _(Future)_ **Dry-run mode** for bulk endpoint.

### Open decisions
- [x] How do we get access to TimeBack's `rpt2_*` tables? Resolved —
      TimeBack Reporting MCP `getData` tool (Claude-side); future cron
      uses `persistQueryToAPI` to expose the same query as an HTTP endpoint.
- [x] Should the sync run for all known users? Resolved — sync sends
      ALL Alpha-domain students with a Reading mastery row; server
      filters down to "users who have signed into Reading Spine"
      so we don't pre-populate strangers.
- [ ] Legal/compliance posture on copying student grade data into our
      Redis — both systems operated by Alpha, but confirm with admin.

---

## 1h. Archive.org / public-domain text RAG

**Goal:** For books whose full text is legally available, pass the actual
text (or large excerpts) into the AI prompt so questions are grounded
in the real book rather than my hand-written summary.

### Source mapping

| Source | Coverage | Access |
|---|---|---|
| **Project Gutenberg** | Public-domain only (pre-1929 ish) | Free HTTP / JSON API |
| **Archive.org Open Library** | Many books; full text via "borrow" requires login + limited concurrent loans | Books API + IIIF/text APIs |
| **Standard Ebooks** | Curated public-domain editions, clean text | Free |
| **Wikisource** | Public-domain works | Free, structured |
| **Publisher previews** (Penguin, HarperCollins) | First-chapter excerpts | Variable; scraping risk |

### Which of our 28 books are public-domain?
- **Definitely PD (pre-1929)**: Peter Rabbit (1902), Ugly Duckling (1843),
  Mother Goose (anonymous, very old), Goldilocks (folk tale)
- **Likely still copyright**: Wild Things (1963), Cat in the Hat (1957),
  Hungry Caterpillar (1969), Velveteen Rabbit (1922 — PD), Frog and Toad
  (1970), Owl at Home (1975), Corduroy (1968), Where the Wild Things Are,
  Magic Faraway Tree (1943 — depends on jurisdiction)
- **Almost certainly copyright**: Knuffle Bunny (2004), Geeger (2020s),
  Mercy Watson (2005), Fantastic Mr. Fox (1970), Lighthouse Family (2002)

### Verdict (2026-05-22 prototype)
**Yes — full-text generation materially improves quiz quality.** See
`scripts/rag-experiment-findings.md` for the side-by-side. In short:

- Summary pool tests "did the kid see a synopsis?"
- Full-text pool tests "did the kid actually read the book?"

Specific wins from the full text: questions hit details our hand-written
summary skips (sand-bank setting, Benjamin Bunny, gooseberry net, lost-shoe
locations) and distractors are story-grounded rather than generic. Neither
pool hallucinated. Cost goes from ~$0.025 to ~$0.04 per generation pass —
trivial at catalog scale.

### Recommended approach
- [ ] Build a `lib/book-text.js` with optional `fullText` field on each
      book, populated where legally available. Pre-fetched at deploy
      time and committed as JSON, so production never hits Gutenberg
      live.
- [ ] Fetch + cache from:
      1. Project Gutenberg JSON API for known-PD works (Peter Rabbit,
         Velveteen Rabbit, Ugly Duckling, Goldilocks, the Usborne
         folk-tale source stories)
      2. Archive.org Books API for books available without borrow
         (look up by ISBN, check `is_readable`)
- [ ] When generating quizzes, if `fullText` is available pass it as
      the source-of-truth INSTEAD of the hand-written summary. Bump
      `SCHEMA_VERSION` to invalidate old caches.
- [ ] Document the legal posture: "We use Archive.org's public-domain
      and openly-licensed texts only. Copyrighted works fall back to
      our hand-written summaries."
- [ ] Stretch: full-text RAG via chunked retrieval — embed every
      paragraph, retrieve top-5 most relevant for each question type
      (probably overkill for picture books; revisit for the chapter
      books only).

### Open decisions
- [ ] **Legal review** — even quoting "small excerpts" of in-copyright
      books for internal AI prompting may or may not be fair use.
      Confirm with school's counsel before scraping anything beyond
      Project Gutenberg.
- [x] **Hosted text vs. live fetch** — pre-fetch at deploy time, ship as
      committed JSON. Decided.

---

## 1c. Grade-leveled difficulty + XP system

**The problem this solves:** A G2 student can game the system by reading
only K books (8 easy quizzes → high "books read" count → top of leaderboard).
Reading should be incentivized at the student's actual ability, not at the
easiest possible level.

**The solution:** Every kid has a "working grade" attribute. Quizzes,
retells, and XP are all calibrated to **that grade**, not the book's grade.
A G2 reading a K book still gets G2-difficulty questions and G2-strict
retell grading. They _can_ read easier books, but the rewards scale to
the challenge.

### Spec
- **Working grade per student** — K, 1, 2, 3 (eventually 4+). Comes from
  the TimeBack mastery sync (1i) or an admin override.
- **Quizzes are grade-leveled, not book-leveled** — the AI prompt includes
  the student's grade so questions test comprehension at that level.
  Examples:
  - G2 student reading The Very Hungry Caterpillar:
    Question = "Why do you think the caterpillar built a cocoon?"
    (inference, abstract — G2 standard)
  - K student reading The Very Hungry Caterpillar:
    Question = "What color was the egg in the picture?"
    (literal recall — K standard)
- **Pass threshold: 80% on the MCQ quiz** (= 4 of 5 questions)
- **Retell strictness scales** — same grade-leveling concept for the
  AI-graded retell (section 1b): G2 retell needs more sequencing,
  vocabulary, and inference than K retell to count as 80%.

### XP system

Every book has an XP value computed from:

```
expectedMinutes = bookWordCount / wcpmForStudentsGrade
xpEarned        = floor(expectedMinutes)   // only if passed quiz AND retell
```

- `bookWordCount` = total words in the book (data we need to add per book)
- `wcpmForStudentsGrade` = expected oral-reading-fluency rate for the
  student's grade (Hasbrouck-Tindal end-of-year norms — standard reference)

**Reference WCPM (end-of-year, Hasbrouck-Tindal 2017):**

| Grade | WCPM (50th percentile) |
|---|---|
| K   | 30  |
| 1   | 60  |
| 2   | 100 |
| 3   | 110 |
| 4   | 130 |
| 5   | 140 |

**Worked examples** (XP a G2 student earns on a clean pass):

| Book | Words | Minutes (G2: 100 WCPM) | XP |
|---|---|---|---|
| The Very Hungry Caterpillar | 225 | 2.3 | **2 XP** |
| Where the Wild Things Are | 340 | 3.4 | **3 XP** |
| The Cat in the Hat | 1,629 | 16.3 | **16 XP** |
| Fantastic Mr. Fox | 10,500 | 105 | **105 XP** |
| The Magic Faraway Tree | 46,000 | 460 | **460 XP** |

This naturally discourages gaming — a G2 grinding 50 K-level picture books
nets ~100 XP, while a single Fantastic Mr. Fox passed cleanly nets 105 XP
in roughly the same number of clicks.

**The same G2 book is worth differently to different grades** because
the denominator (WCPM) changes:

| Book | K reader (30 WCPM) | G2 reader (100 WCPM) |
|---|---|---|
| Hungry Caterpillar | 7 XP | 2 XP |
| Cat in the Hat | 54 XP | 16 XP |

A K reader gets more XP for the same book — fair, because it's harder for them.

### Data we need to add
- [x] `wordCount` field on every book — stored in `lib/books.js` (server)
      since the server needs it to compute points. Client doesn't need it
      yet; we'll add it to `CATEGORIES` when the UI shows "est. reading
      time" or "worth X points" badges.
- [x] WCPM lookup table in `lib/xp.js` (Hasbrouck-Tindal norms)
- [ ] `workingGrade` attribute per student. **MVP shipped**: derive
      from `guessGradeFromEmail`, defaults to "K" otherwise.
      **Outstanding**: admin UI to override per student; eventually
      pull from Google Workspace `gradeLevel` org-unit attribute.
- [ ] Quiz prompt updates: include `studentGrade` so AI calibrates
      difficulty. Cache key becomes `quiz:v3:<bookId>:<studentGrade>`.
      _(Phase B)_

### Build steps (in order)
- [x] **Phase A — points without grade-leveled quizzes** (shipped)
  - [x] Add `wordCount` to every book (in `lib/books.js`)
  - [x] WCPM lookup table + `pointsForBook(wordCount, grade)` in `lib/xp.js`
  - [x] Default grade per student via `guessGradeFromEmail` fallback
  - [x] `/api/activity` computes points on quiz pass
  - [x] `recordRead` writes to new `lb:points:*` sorted sets
  - [x] `getLeaderboard` ranks by points (returns books + points per row)
  - [x] Stats strip shows total points (✨) and rank (🏆)
  - [x] Quiz success screen celebrates points earned
- [x] **Phase B — Grade-leveled quizzes** (shipped)
  - [x] Server resolves student's grade from `guessGradeFromEmail`
  - [x] Cache key bumped to v4 and keyed by `(bookId, studentGrade)` —
        different grades get different question pools because difficulty
        is calibrated to the reader
  - [x] AI system prompt includes per-grade difficulty guidance (K =
        literal recall; G2 = inference, theme, cause-effect; etc.)
  - [x] Prompt instructs Claude to NOT dumb down questions when student
        is older than book level, and NOT over-complicate when younger
- [ ] **Phase C — Grade-leveled retell** (depends on 1b being built first)
  - Pass `studentGrade` into the retell grading prompt: stricter
    plot-point coverage and vocabulary expectations at higher grades
  - 80% retell score required for full points to be awarded
- [x] **Phase D — Working-grade management UI** (shipped)
  - [x] Admin can set/edit a student's working grade via dropdown
        in the admin user table.
  - Kids do **NOT** self-select grade (decided against — too easy to
    game). 1i auto-sync from TimeBack will be the primary source;
    admin override is the manual escape hatch.

### Open decisions
- [x] **Where does the student's working grade come from for v1?**
      **Decided:** primary source is TimeBack auto-sync (1i); admin
      override in the admin modal is the manual escape hatch.
      Kids do NOT self-select. Email heuristic remains as the bootstrap
      fallback for users not yet known to TimeBack.
- [ ] **What happens if a kid passes the quiz but fails the retell?**
      Half XP? Zero XP? Quiz-only fallback if retell isn't implemented yet?
      _Recommend: For v1 (before retell ships) — quiz pass alone = full XP.
      Once retell ships, both required for full XP, quiz-only = half XP._
- [ ] **Daily / weekly XP caps?** Prevents marathon gaming.
      _Recommend: not initially — see if it becomes a problem._

---

## 1d. Quiz integrity & anti-gaming

**Goal:** Reading Spine has to actually prove reading, not just generate XP
clicks. Three mechanisms address the most likely gaming vectors.

### 1d.1 Question rotation on retake

**Problem:** Today we generate an 8-question pool and pick 5 random per
attempt. A student who fails attempt 1 sees questions 1, 3, 4, 7 → could
get attempt 2 with questions 2, 5, 6, 7, 8 (overlap on Q7). With only an
8-question pool, near-duplicate questions across attempts are inevitable
even with shuffling.

**Fix:**
- [x] Track which question IDs a student has seen for a given book.
      Stored as `seenQTexts[]` on the per-attempt localStorage record
      (Redis tracking is overkill — daily cap + 30-day pool cache).
- [x] On attempt 2, **exclude any question the student has already seen
      on attempt 1**. Pool bumped to 12 questions per book so attempt 2
      always has 5 fresh questions.
- [x] If the pool is exhausted (somehow), fall back to the full pool —
      good enough since the cache busts every 30d and on flagged reports.
- [ ] _(Future)_ Verify with AI grading that attempt 2's questions aren't
      semantically near-duplicates of attempt 1's — see 1g multi-pass
      cross-validation, which makes near-dup questions impossible to
      begin with.

### 1d.2 Reduced rewards on 2nd-attempt passes

**Problem:** First-try passes mean the student actually retained the
content. Second-try passes — especially after multiple shuffled exposures
to the questions — are weaker signal.

**Fix:**
- [x] **Internal XP**: 1st attempt pass = **100%** of book XP;
      2nd attempt pass = **50%**. Tunable via env `POINTS_RETAKE_MULTIPLIER`.
- [ ] **Caliper event to TimeBack** (depends on 1e): reflect the 2nd
      attempt by setting `scoreGiven` to the actual quiz score, and
      include an `extension` field flagging it as the retake — TimeBack
      can apply its own XP penalty if desired.
- [x] Reduction is **NOT** shown to the student (per UX decision —
      avoids accusatory framing). Success screen just shows what they earned.
- [ ] Admin can override (e.g., if a student's first attempt was
      glitched by a connectivity issue) — admin sets a per-attempt
      override flag in Redis. _(Not yet built; admin can reset
      fraud flags as a workaround.)_

### 1d.3 Speed-based fraud detection ("rapid-fire submissions")

**Problem:** A G2 student submits a quiz for Book A at 12:00, then
another for Book B at 12:05. That's 5 minutes for what should have been
~30–60 minutes of actual reading. Almost certainly gaming — copying a
friend's answers, asking ChatGPT, or just guessing.

**Detection algorithm:**

For each quiz submission, compute:

```
minExpectedReadingMins = bookWordCount / wcpmForStudentsGrade
elapsedSinceLastSubmissionMins = nowMins - lastQuizSubmittedMins
suspicionRatio = elapsedSinceLastSubmissionMins / minExpectedReadingMins
```

- `suspicionRatio < 0.25` → **definitely gaming**, hold XP for admin review
- `suspicionRatio < 0.5` → **flagged**, but still award XP at 50%
- `suspicionRatio >= 0.5` → normal

For the *first* quiz of the day, compare against "last quiz of the
previous session" with a generous floor (e.g., assume 30 min minimum
gap if no recent quiz).

**State to track:**
```
user:<email>:lastQuizAt          → ISO timestamp of last submission
user:<email>:lastQuizBookId      → book they just claimed
user:<email>:flagCount           → integer, lifetime offences
user:<email>:flagCooldownUntil   → ISO timestamp, locked-out until
user:<email>:heldXp              → array of {bookId, xp, reason, ts}
                                   waiting for admin approval
```

**Consequences (escalating):**

| Offence # | Cooldown (no quiz submissions allowed) | XP status |
|---|---|---|
| 1st | 2 hours | Held for admin approval; auto-warn student |
| 2nd | 8 hours | Held; warn + notify admin |
| 3rd | 24 hours | Held; admin must approve to release |
| 4th+ | 72 hours, escalating | Held; account flagged for review |

**Student-facing UX when blocked:**

The quiz button shows: **"⏰ Take a break and re-read. You can try
quizzes again at 2:00pm."** No accusatory language — frame as healthy
pacing. Tooltip: "Reading is best when you have time to enjoy it.
Come back after lunch!"

**Admin-facing UX:** (all shipped)
- [x] New "Held XP" section in the admin modal showing flagged events
- [x] Per-student flag-count badge (🚨×N visible on the user list)
- [x] One-click "Approve" or "Reject" per held event
- [x] "Reset flags" button (in case the kid had a legitimately
      fast read — like a 30-page Knuffle Bunny)

**Open decisions:**
- [ ] **Threshold tuning**: 0.25 / 0.5 ratios are guesses. After v1 ships,
      review logs and adjust based on legit-fast-reader false positives.
- [ ] **Offence counter reset window**: never, monthly, or
      after-N-clean-submissions? _Recommend: decay 1 per week of clean
      submissions to allow recovery._
- [ ] **Whitelist for known fast readers**: admins can mark a specific
      kid as "advanced reader, don't flag." Probably yes.
- [ ] **Notification channel for held events**: email digest to admin?
      In-app red dot? Both?

### 1d.4 First-open fairness gate (soft order proxy)

**Problem:** The WCPM speed check catches a kid bouncing between quizzes
in a single sitting, but not the kid who opens *Fantastic Mr. Fox* in
Reading Spine for the first time, clicks the Amazon link, then somehow
submits a passing quiz 45 minutes later. They physically can't have
ordered + received + read the book — but the WCPM check alone might let
them through if it's their first quiz of the day.

**Fix (shipped):**
- [x] `POST /api/activity { kind: "open", bookId }` records a server
      timestamp the first time a student opens a given book's modal.
      SETNX semantics — only the first open writes; later opens are
      ignored so the floor never shifts.
- [x] In the fraud engine, read `firstOpenAt` and compute
      `hoursSinceOpen`. If `< FIRST_OPEN_SUSPICION_HOURS` (default 6),
      tag the submission as "open-suspicious."
- [x] Soft combine matrix:
      - WCPM clean + open clean        → clean
      - WCPM clean + open suspicious   → soft_flag (one signal)
      - WCPM soft  + open clean        → soft_flag (existing behavior)
      - WCPM soft  + open suspicious   → **held** (both signals agree)
      - WCPM hold  + anything          → held (WCPM hold is strong)
- [x] If `firstOpenAt` is null (legacy users, device-hopping, race
      conditions) the check is skipped — never penalize for missing
      telemetry.

**Net effect:** kids who already had a book at home and only just
discovered it in the app stay protected by the WCPM check (they read at
a normal pace because they actually read the book). Kids trying to
quick-cheat right after opening get caught by the combined signal.

### 1d.5 Hard order-aware gate (upgrade, gated on org-owned Amazon account)

**Goal:** Replace the soft 6-hour heuristic with a deterministic gate
once we own the Amazon account books are ordered through.

### Build steps
- [ ] When the org-owned Amazon account places an order for a kid (via
      whatever ordering flow we land on — direct API or operator-driven),
      record `order:<email>:<bookId>` =
      `{orderedAt, expectedDeliveryAt, source: "org"}` in Redis.
- [ ] Extend the quiz-modal logic: if there's an active "org" order for
      `(email, bookId)` and `now < expectedDeliveryAt + minReadingTime`,
      the quiz button is replaced with a friendly countdown:
      *"📦 Your copy arrives Thursday — quiz unlocks Friday afternoon."*
      Hard gate (not soft) because we KNOW the kid doesn't have the book.
- [ ] Track own-account Amazon-link clicks via
      `buyclick:<email>:<bookId> = clickedAt` (fire-and-forget on
      Amazon-link tap). Use ONLY to *relax* the existing soft gate — if
      a click is < 7 days old, treat the first-open suspicion threshold
      as 0 (assume the kid just bought it). Never use to penalize.
- [ ] Admin manual unlock — `POST /api/admin?action=unlock-quiz` for
      cases where a kid has the book through library/loan/friend.
      Bypasses the order-aware gate for one quiz attempt.

### Cost / risk
Mostly Redis writes + one new endpoint. The trickiest part is the order
intake (depends on which Amazon flow lands). Soft 1d.4 covers us until
this is ready.

### Build order

These are independent but all depend on the XP system from section 1c.

1. Question rotation (1d.1) — small, ~1 hour, just Redis tracking
2. Reduced 2nd-attempt rewards (1d.2) — small, ~30 min in-app, but
   blocked by TimeBack write API for the sync part
3. Speed-based fraud detection (1d.3) — medium, ~2-3 hours, needs new
   admin UI
4. First-open fairness gate (1d.4) — shipped 2026-05-22
5. Hard order-aware gate (1d.5) — blocked on org-owned Amazon account

---

## 1e. TimeBack integration via Caliper events

**Two systems, kept separate:**

| | What it is | Who awards | Source of truth |
|---|---|---|---|
| **Internal points** | The in-app leaderboard ranking number | Reading Spine (us) | Our Redis |
| **TimeBack XP** | School's official XP credit on the kid's record | **TimeBack** | TimeBack's database |

Reading Spine **does NOT award XP** to students directly. Our job is to
emit Caliper Analytics events to TimeBack whenever a kid demonstrates
quiz mastery; TimeBack ingests the events and credits XP per its own
rules. Our internal "points" power the in-app leaderboard only and
exist independently of TimeBack's XP.

### Caliper Analytics primer

[Caliper Analytics](https://www.imsglobal.org/spec/caliper/v1p2)
(IMS Global / 1EdTech standard) defines a structured JSON event format
for learning activities. The relevant event types for us:
- **AssessmentEvent** — a kid took an assessment (the quiz). Actions
  include `Started`, `Completed`, `Submitted`.
- **GradeEvent** — a result was assigned to an assessment attempt.
  Includes a score and a max-score.

A quiz-pass for our app would emit BOTH:
1. `AssessmentEvent` with `action: Completed`
2. `GradeEvent` with `score: 4`, `maxScore: 5`, `scoreGiven: 80%`

### Decisions needed
- [ ] **TimeBack Caliper endpoint** — confirm the URL the events POST to,
      auth scheme (Bearer token? OAuth client credentials?), and any
      tenant/sensor IDs we need. Env vars are wired:
      `TIMEBACK_CALIPER_URL`, `TIMEBACK_CALIPER_TOKEN`,
      `TIMEBACK_CALIPER_AUTH_SCHEME`, `TIMEBACK_SENSOR_ID`,
      `TIMEBACK_EDAPP_ID`.
- [x] **Identity mapping** — we send BOTH: actor `id` =
      `urn:uuid:<TimeBack student_id>` (preferred), with email as
      `otherIdentifiers` of type `EmailAddress`. TimeBack picks whichever
      it indexes on.
- [x] **Event format version** — Caliper v1.2
      (`http://purl.imsglobal.org/ctx/caliper/v1p2`). Confirm with TimeBack
      that this is OK or downgrade to v1.1 if required.
- [x] **Idempotency** — UUID v5 deterministic IDs from
      `(eventType, email, bookId, attemptNumber)`. Re-firing the same
      event produces the exact same `id`, so TimeBack's de-dupe gets a
      free win.
- [x] **When to emit** — immediately on quiz pass (fire-and-forget from
      `/api/activity` so the student response isn't blocked on TimeBack).
- [x] **2nd-attempt passes** — we emit the actual `scoreGiven` and tag
      `extensions.retake: true` so TimeBack can apply its own retake
      rules. We don't double-encode the penalty.

### Caliper event shape we'll send

```json
{
  "@context": "http://purl.imsglobal.org/ctx/caliper/v1p2",
  "id": "urn:uuid:<deterministic-from-email-book-attempt>",
  "type": "GradeEvent",
  "actor": {
    "id": "<oneroster-sourcedId-or-email>",
    "type": "Person"
  },
  "action": "Graded",
  "object": {
    "id": "https://reading-spine.vercel.app/quiz/<bookId>/attempt/<n>",
    "type": "AttemptItem",
    "isPartOf": {
      "id": "https://reading-spine.vercel.app/quiz/<bookId>",
      "type": "Assessment",
      "name": "<book title> — comprehension quiz",
      "maxScore": 5
    }
  },
  "generated": {
    "id": "urn:uuid:<...>",
    "type": "Score",
    "scoreGiven": 4,
    "maxScore": 5,
    "scoredBy": { "type": "SoftwareApplication", "id": "https://reading-spine.vercel.app" }
  },
  "eventTime": "2026-05-21T12:34:56.000Z",
  "edApp": {
    "id": "https://reading-spine.vercel.app",
    "type": "SoftwareApplication"
  }
}
```

### Build steps
- [x] Env vars wired: `TIMEBACK_CALIPER_URL`, `TIMEBACK_CALIPER_TOKEN`,
      `TIMEBACK_CALIPER_AUTH_SCHEME` (default Bearer),
      `TIMEBACK_SENSOR_ID`, `TIMEBACK_EDAPP_ID`.
- [x] `lib/caliper.js`: `buildAssessmentEvent`, `buildGradeEvent`,
      `buildQuizEventEnvelope`, inline UUID v5 helper (no new dep).
- [x] `lib/timeback.js`: `postCaliperEnvelope` with one retry on 5xx/network
      error; `sendCaliperEnvelopeAsync` fire-and-forget;
      `queueCaliperRetry` writes failures to Redis LIST
      `caliper:retry` (capped at 1000); `drainCaliperRetryQueue` for
      cron/admin manual drain.
- [x] Wired into `/api/activity` — every quiz completion with
      `attemptNum` set fires the envelope async. Held submissions emit
      too with `extensions.fraudFlag = "held"` so TimeBack can decide
      what to do with them.
- [x] Admin endpoint `?action=caliper-health` — surfaces config status
      and retry-queue depth.
- [x] Admin endpoint `?action=caliper-drain-retry` — manual drain pass.
- [x] Admin endpoint `?action=test-caliper` — generates a sample
      envelope using arbitrary inputs; with `send: true` dispatches it
      to the real endpoint. Returns the dispatch result so you can
      verify status codes / TimeBack response bodies.
- [ ] Vercel Cron job to drain the retry queue every ~5 min. Needs the
      same shared-secret pattern as 1i Option A. Until then, admin can
      drain manually via the endpoint above.

### Decoupled from internal points

The internal point formula in section 1c (`wordCount / wcpm`) is OURS
— displayed in the in-app leaderboard, persisted in our Redis. It is
independent of whatever XP TimeBack chooses to award based on our
Caliper events. They might be the same number, or wildly different,
and that's fine — they serve different audiences.

---

## 1b. Voice retell (AI-graded oral comprehension)

**Goal:** After a kid passes the multiple-choice quiz, prompt them to retell
the story in their own words. We record the audio, transcribe it, and grade
it with AI on plot coverage + sequence. Adds a real comprehension signal
that MCQ alone can't catch.

### Decisions needed
- [ ] **Recording length cap**: 30s? 60s? 90s? _Recommend: 60s — long enough
      for K-2 retell, short enough to stay focused._
- [ ] **Mandatory or optional?** _Recommend: optional but earns a bonus
      badge ("Storyteller" star) on the kid's reading record._
- [ ] **Pass criteria**: percent of key plot points covered? AI-assigned
      0–10 score? Pass/fail vs. graded?
- [ ] **Privacy**: store the raw audio (in Vercel Blob) for admin review,
      or transcribe-and-discard? _Recommend: transcribe-and-discard by
      default — keep this strictly between the kid and the AI grader._
- [ ] **Transcription provider**: OpenAI Whisper, Anthropic (no native ASR),
      Deepgram, or AssemblyAI? _Recommend: Deepgram or Whisper via
      a server-side proxy — both have streaming options for low latency._

### Data model
For each pass, store on the user's quiz record:
```js
{
  bookId: "k01",
  attempt: 1,
  quizScore: 3,           // out of 4
  retell: {
    durationMs: 42100,
    transcript: "The caterpillar ate apples and pears and then cake and...",
    score: 8,             // 0–10 from the AI grader
    coveredPoints: ["egg→caterpillar", "ate fruits Mon-Fri", "junk food Sat", "cocoon", "butterfly"],
    missedPoints: ["got a stomach ache"],
    audioBlobUrl: null,   // unless opted-in
    gradedAt: 1716230000000
  }
}
```

### Build steps
- [ ] Mic permission flow: small interstitial explaining why we're asking
      ("So we can hear you tell the story back!")
- [ ] Recording UI in the quiz overlay (after the "Great reading!" screen):
      big 🎤 button, animated waveform while recording, big ⏹ stop button,
      visible countdown of remaining seconds
- [ ] Browser MediaRecorder → upload as `audio/webm` to `/api/retell/upload`
- [ ] Server endpoint `/api/retell/grade`:
      1. Receive audio blob
      2. POST to Whisper (or Deepgram) for transcription
      3. Pass transcript + canonical plot summary to Claude/GPT with a
         structured-output schema asking for `{score, coveredPoints, missedPoints, encouragement}`
      4. Return result; cache by `(email, bookId)` so we don't re-grade if
         the kid reloads
- [ ] Feedback screen: show the kid which plot points they nailed, which
      they could mention next time, and a warm "way to go" message
- [ ] Tie into leaderboard: maybe a separate "Storyteller" ranking?
- [ ] Tie into admin: show retell scores per kid

### Stretch
- [ ] Inline TTS coach if the kid is silent for >10s: "Tell me about how
      the story started…"
- [ ] Admin dashboard view of retell transcripts (with consent)
- [ ] Multi-language retell (Spanish, etc.) for ESL learners

---

## 2. Leaderboard

**Goal:** Kids see how their class / grade / school is doing and feel motivated
to read more. Privacy-first because K-2. **Ranked by internal POINTS, not
book count** — see section 1c for how points are calculated. Note: these
points are *internal-only* and distinct from the official TimeBack XP
that's awarded via Caliper events (see section 1e).

### Migration from "books read" → "XP"
- [x] V1 leaderboard ranks by `count` of unique books read (already shipped)
- [x] **V2: rank by internal XP**. Redis sorted sets are now
      `lb:points:all` / `lb:points:w:<isoWeek>`.
- [x] Existing reads were zeroed out and started fresh (no retroactive
      backfill — we didn't have `wordCount` × working-grade for old records).
- [x] Leaderboard row displays `42 XP` instead of `7 books`. Books count
      is still in the secondary line ("Grade 2 · 4 books read").

### Decisions needed
- [ ] **Scopes shown**: my class only? my grade? whole school? all three?
      _Recommend: tabs for **My Class / Grade / School**._
- [ ] **Time windows**: weekly + all-time? add monthly?
- [ ] **Identity**: real names, "First L." initial, or kid-chosen handles?
      _Recommend: first name + last initial, pulled from Google profile._
- [ ] **Class membership**: how do we know a kid's class?
      - Option A: pull from TimeBack's `rpt2_student.campus` (already
        available via the MCP); per-campus leaderboards become trivial
      - Option B: admin sets up groups manually in the admin modal
      _Recommend: Option A — campus is already on the data we sync._
- [ ] **Compliance**: do we need parental consent before a kid's name shows up
      on a public ranking? Confirm with Alpha School admin before launch.

### Tech foundations (prerequisite)
This is the first feature that needs server-side state. localStorage stops
working here.

- [ ] Provision a database via Vercel Marketplace
      _Recommend: **Neon Postgres** (relational data, free tier is plenty)._
- [ ] Define schema:
  ```sql
  CREATE TABLE users (
    email TEXT PRIMARY KEY,
    name TEXT,
    grade TEXT,             -- 'K' | '1' | '2'
    class_id TEXT,          -- nullable
    created_at TIMESTAMPTZ
  );
  CREATE TABLE activity (
    id BIGSERIAL PRIMARY KEY,
    user_email TEXT REFERENCES users(email),
    book_id TEXT,
    kind TEXT,              -- 'read' | 'quiz_pass' | 'vote_up' | 'vote_down' | 'comment'
    score INT,              -- quiz score (nullable)
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX ON activity(user_email, kind);
  CREATE INDEX ON activity(created_at);
  ```
- [ ] One-time backfill: when a user first signs in after this ships, sync
      their localStorage data up to the server.
- [ ] API: `POST /api/activity` (log), `GET /api/leaderboard?scope=class|grade|school&window=week|all`

### UI
- [ ] New "Leaderboard" route or modal (header link, currently "My List")
- [ ] Scope tabs (My Class / Grade / School)
- [ ] Time window toggle (This Week / All Time)
- [ ] Top 10 list with avatar, name, books-read count, streak fire icon
- [ ] Show the current kid's rank prominently even if they're outside top 10
- [ ] Confetti / sound when a kid moves up the board

### Stretch
- [ ] Class vs. class leaderboard (which class read the most this week)
- [ ] Weekly "book of the week" award for the most-read book per grade
- [ ] Achievements / badges (e.g. "Read 5 books", "First in your class")

---

## 3. "Buy on Amazon" links

**Goal:** When a kid loves a book, parents have one tap to get it shipped home.

### Decisions needed
- [ ] **Affiliate program**: enroll Reading Spine in Amazon Associates so
      purchases generate a small revenue share for the school?
      _Recommend: yes — needs school admin sign-off + a tracking tag in env vars._
- [ ] **Multi-retailer**: just Amazon, or also Bookshop.org (supports indie
      bookstores) and a "Find at your library" link via WorldCat?
      _Recommend: all three — kids/parents pick what fits._
- [ ] **Parental gate**: should we require an "Ask a parent" interstitial
      before opening an external retailer link? (K-2 = no purchasing power,
      but also no understanding of "external link".)

### Build steps
- [ ] Add a helper `buyLinks(book)` that returns an array of `{retailer, url}`:
  - Amazon: `https://www.amazon.com/dp/<ISBN-10>?tag=<AFFILIATE_TAG>`
    (ISBN-13 → ISBN-10 conversion needed, or use search URL fallback)
  - Bookshop.org: `https://bookshop.org/books?keywords=<ISBN-13>`
  - WorldCat: `https://www.worldcat.org/isbn/<ISBN-13>`
- [ ] "Get this book" section in the book detail modal with three buttons
- [ ] Open in new tab, `rel="noopener noreferrer"`, target="_blank"
- [ ] Parental gate modal: "Ask a grown-up before tapping. Continue?"
      (One tap to dismiss for the session.)
- [ ] Add `AMAZON_AFFILIATE_TAG` env var (production only, blank for previews)

### Stretch
- [ ] "Add to family wishlist" — kids can star books a parent gets a weekly
      email digest of (would need parent auth, separate scope)
- [ ] Local library availability lookup (OverDrive / Libby API) for free
      borrow option

---

## Cross-cutting work that unlocks the above

- [x] **Database choice** — Upstash Redis (Marketplace), used for quiz cache,
      leaderboard sorted sets, and the admin user list.
- [ ] **`workingGrade` attribute per student** (blocks 1c, blocks XP-based
      leaderboard). MVP: admin sets manually per user. Stretch: pull from
      Google Workspace gradeLevel attribute on the OIDC token.
- [ ] **Migrate from localStorage to server-side state** for votes, reads,
      comments — needed once we have a DB. Keep localStorage as a fallback
      cache for offline.
- [ ] **Multi-tier admin role** — admins can already manage everything via
      `ADMIN_EMAILS`. If we ever need finer-grained roles (read-only auditor,
      org-admin vs campus-admin), add a `role` column on `users` and a
      middleware permission check. Not urgent — single-tier admin is fine
      for now since Reading Spine has no in-app teacher persona.
- [ ] **Preview env vars** — set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
      `AUTH_SECRET`, `ALLOWED_DOMAIN` for **Preview** env in Vercel, and add
      `*.vercel.app` preview redirect URIs to the Google OAuth client. Without
      this, PR previews show "Auth not configured."

---

## Polish (small wins, anytime)

- [x] Default card badge shows grade letter (`Grade K` / `Grade 1` / `Grade 2`)
      instead of `K-2`. Hot/Read badges still take precedence.
- [x] Grade pill in the modal metadata row (replaced the old age pill).
- [x] Removed the "Ages X–Y" copy from cards, hero, and modal — Alpha kids
      often read above age-grade, so working-grade is the only signal we show.
- [ ] Search bar in the header (filter all books by title/author)
- [ ] "My List" actually works (save-for-later separate from reads)
- [ ] Empty-state illustration for the "Keep Reading" row when it's empty
- [ ] Better loading state on the modal while the cover image fetches
- [ ] Light theme toggle (some classrooms have screens in bright sun)
- [ ] Accessibility audit (keyboard nav, screen reader, focus rings)
- [ ] Custom domain: `read.alpha.school` or similar

---

## Beginning Readers tier (lower-gate catalog)

**Goal:** Open Reading Spine to transitional readers below the current
20 WCPM @ 95% gate, without exposing them to books that cause despair.
A new student who can decode CVC and reads ~10–19 WCPM @ 90% on K text
gets a Track-B catalog of carefully chosen text-rich emergent titles
they can actually finish, then auto-graduates to the full catalog once
they show they're ready.

### Two-track entry

| Track | Gate (Acadience) | Catalog |
|---|---|---|
| **A — Full catalog** | ORF ≥ 20 WCPM @ 95% on K text | Everything |
| **B — Beginning Readers** | NWF-WWR ≥ 13 (end of K) AND ORF ≥ 10 WCPM @ 90% on K text | ~12 emergent titles only |

Below Track B: student is still in the decoding-instruction phase →
belongs in Lalilo/Mentava, not here.

### Catalog (~12 pilot titles, all Amazon-orderable, all text-rich enough for text-only MCQs)

**Picture-light books where plot lives in the words — pure MCQ works:**
- [ ] Mo Willems *Elephant & Piggie* ×5: *We Are in a Book!*,
      *I Will Surprise My Friend!*, *Are You Ready to Play Outside?*,
      *There Is a Bird on Your Head!*, *Should I Share My Ice Cream?*
- [ ] Dr. Seuss Beginner Books ×2: *Hop on Pop*,
      *One Fish Two Fish Red Fish Blue Fish*
- [ ] Step Into Reading Step 2 ×3: *Tiny Goes to the Library*,
      *Robin Hood and the Golden Arrow*, *The Pet Shop Mystery*
- [ ] Usborne Very First Reading Books 5–8 ×2:
      *Goose on the Loose*, *The Mouse's Houses*

**Explicitly NOT included** (would require pictures to quiz on):
- Bob Books Set 1 — plot is in the illustrations, text is too thin
- Usborne Phonics Readers — same problem
- Pete the Cat (I Can Read! Level 1) — emotion lives in art, not words

### Quiz adjustments for this tier
- [ ] New `quizStyle: "emergent"` field on these books in `QUIZ_BOOKS`.
- [ ] Generator switches prompt template by style:
      - **3 questions** instead of 5 (short books → padding-free)
      - **2 of 3 pass threshold** (67%) instead of 4 of 5
      - Question + option vocabulary constrained to first-100 Dolch
        sight words + CVC patterns
      - Test literal recall and dialogue ("Why did Piggie come over?"
        "What did Elephant say?"), NOT plot inference
- [ ] QC reviewer rubric: drop anything that depends on visual context
      ("What color was X?" only allowed if color is mentioned in the text).
- [ ] Multi-pass cross-validation (1g) still applies on top.

### UX
- [ ] TTS auto-prompted on every Track-B book: *"Tap the speaker to hear
      it first!"* shown on modal open with a gentle pulse animation.
- [ ] Cover-image quality matters more here than for older readers —
      ensure all 12 have working OpenLibrary covers, fall back to a
      hand-picked gradient if not.

### Graduation criteria (auto-unlock full catalog)
- [ ] When a Track-B student has earned **≥ 50 XP across ≥ 10 books**
      with **first-attempt-pass rate ≥ 70%**, flip
      `user.catalogTrack` from `"B"` to `"A"`. Show a celebration
      modal: *"You've leveled up! New books unlocked."*
- [ ] Manual admin override: a track field on each user with values
      `"auto"` | `"A"` | `"B"`. Default `"auto"` runs the gate logic
      above. Admin can pin to `"A"` or `"B"` for cases where the
      Acadience score doesn't reflect actual ability.

### Cost / risk
About half a day's work plus prompt tuning. Quiz pipeline already
handles per-book customization; the only new code is the `quizStyle`
branch in `api/quiz.js` and a new row in `index.html` CATEGORIES.

---

## Admin track-locking + working-grade-aware catalog visibility

**Goal:** Make sure students see only the tracks (grade rows) that
fit them — by default driven from working grade, with admin override
per-student.

### Default visibility rule
- A student with `workingGrade = X` sees tracks **at or below X**.
  Example:
    - K student → Beginning + Grade K
    - G1 student → Beginning + Grade K + Grade 1
    - G2 student → Beginning + Grade K + Grade 1 + Grade 2
- Beginning Readers track is gated by the Track-B logic above
  (NWF-WWR + ORF entry, or admin pin to Track B).
- A student NEVER sees a track above their working grade by default —
  prevents discouragement from being shown books they can't read yet.

### Admin override
- [ ] Add per-track toggle switches in the admin user table — one
      column per active track (Beginning, K, 1, 2, …):

      ```
      Email            | Grade | Beg | K | 1 | 2
      ace.weir@…       | 2     |  ☐  | ✓ | ✓ | ✓
      colm.bowen@…     | K     |  ✓  | ✓ | ☐ | ☐
      ```
- [ ] Each toggle has three states: **auto** (follows the default
      rule), **unlocked** (force-show), **locked** (force-hide).
- [ ] `setVisibleTracks(email, overrides)` writes to the user profile
      as `trackOverrides: { K: "auto", 1: "unlocked", 2: "locked" }`.

### Server enforcement
- [ ] Catalog endpoint (`/api/catalog`, new — or fold into `/api/auth/me`)
      returns only the categories the student is allowed to see, based
      on `(workingGrade, trackOverrides)`. Client-only filtering isn't
      enough; server must enforce so direct-fetch attempts on hidden
      books fail.
- [ ] Quiz endpoint `/api/quiz?bookId=…` checks the student can see the
      book's track. If not, returns 403. (Prevents the trivial
      "guess-the-bookId" workaround.)

### Use cases this enables
- A K student rated by TimeBack as G2 (rare but happens — early decoders
  with strong vocab) → admin unlocks Grade 1 and Grade 2 tracks for them.
- A G2 student who's underperforming → admin temporarily locks the
  Grade 2 track and unlocks Beginning while they catch up.
- An advanced K student who passed every K book quickly → admin unlocks
  Grade 1 early.

### Org-wide default
- [ ] Admin can also set the org default in env vars (e.g.
      `DEFAULT_TRACK_POLICY="at_and_below"` vs `"only_working_grade"`).
      Useful if Alpha wants stricter or more permissive defaults at
      different campuses.

### Build estimate
Most of the work is the admin UI + the catalog-endpoint refactor.
The visibility rule itself is ~20 LOC. Estimated half a day.

---

## First-run intro / product tour

**Goal:** A new student lands in Reading Spine and immediately understands
(a) which voice will read to them when TTS is on, and (b) how to navigate
the catalog, open a book, take a quiz, see the leaderboard. Right now we
drop them into the catalog cold.

### Two-part flow

**Part 1 — Voice picker (first thing they see after sign-in):**
- [ ] Modal: *"Hi! Pick a voice for read-aloud."* with 3-5 sample voices
      the kid can tap to preview (Polly Neural voices for quality;
      browser-voice fallback if Polly cap is hit).
- [ ] Each option plays a short pre-recorded sample sentence (e.g. *"Once
      upon a time there was a hungry caterpillar…"*).
- [ ] Selection persists to the user's profile in Redis (new
      `preferredVoiceId` field on the user hash) so it survives device
      changes.
- [ ] "Skip" / "I'll choose later" closes the modal and falls back to the
      current default-voice behaviour. Doesn't block the rest of the tour.

**Part 2 — Spotlight product tour (Shepherd.js-style):**
- [ ] Dim the page and put a callout bubble next to each key UI region
      in sequence:
      1. Hero row — *"This is your Pick of the Week. Tap any book to
         learn more!"*
      2. Grade row strip — *"Your books are organized by grade. Yours is
         highlighted — start there."*
      3. Genre rows — *"Or browse by what you're in the mood for."*
      4. Stats strip — *"Your XP and rank live up here."*
      5. Leaderboard nav link — *"See how your school is doing here."*
      6. Avatar dropdown — *"Settings, sign out, and the TTS toggle live
         in your avatar."*
- [ ] "Next" / "Back" / "Skip tour" buttons. Skip writes `tourCompleted: true`
      to the user profile so we don't re-show on later logins.
- [ ] Spotlight effect: SVG mask with a hole over the highlighted region;
      keyboard-navigable for accessibility.

### Triggering logic
- [ ] First sign-in only — set `tourCompleted` after either flow ends
      (skip or finish). Returning users never see it again.
- [ ] Admin endpoint `POST /api/admin?action=reset-tour&email=...` so we
      can re-trigger the tour for QA / demos without nuking other state.
- [ ] Footer link "Replay intro" (small, low-key) so curious kids can
      revisit it themselves.

### Open decisions
- [ ] **Vendored vs library?** Shepherd.js (~60kB) is the obvious pick
      but adds a dep; we could roll our own spotlight in ~150 LOC and
      stay zero-dep. _Recommend: roll our own — the tour is 6 steps and
      we already have the modal/overlay primitives._
- [ ] **Voice sample assets** — pre-render the same sentence in each
      voice via Polly and host as a static asset, or call /api/tts on
      first preview? Recommend pre-render (fast, no cap usage on every
      kid's first login).
- [ ] **Accessibility** — the spotlight must be navigable via keyboard
      and screen-reader-friendly (proper `aria-live`, focus management).

### Cost / risk
Tiny. Pre-rendered voice samples are a one-time ~5kB×N upload to Vercel
Blob. The tour itself is pure client-side with one Redis write at the end.

---

## 1i upgrade — Option A (automated TimeBack sync)

**Goal:** Replace the manual paste flow shipped in 1i Option B with a fully
automated daily sync.

### Build steps
- [ ] Use the TimeBack Reporting MCP `persistQueryToAPI` tool to publish the
      working-grade SQL (`rpt2_mastery` JOIN `rpt2_student` for Reading subject,
      Alpha-domain emails only) as a callable HTTPS endpoint. Save the URL + token.
- [ ] Add env vars on Vercel: `TIMEBACK_GRADE_SYNC_URL`,
      `TIMEBACK_GRADE_SYNC_TOKEN`, `RS_SYNC_TOKEN` (an internal shared
      secret so the cron can call our bulk endpoint without admin cookies).
- [ ] Loosen `/api/admin?action=bulk-set-grades` auth so it accepts either
      an admin session OR a `?token=<RS_SYNC_TOKEN>` header — letting the
      cron call it server-to-server.
- [ ] Add a Vercel cron (e.g. 4 AM UTC daily) hitting a new
      `/api/cron/sync-grades` that fetches the persisted TimeBack endpoint,
      transforms `{data: [...]}` → `{updates: [...]}`, and POSTs to the bulk
      endpoint with `RS_SYNC_TOKEN`.
- [ ] Add `gradeSyncLog` Redis list — each run appends
      `{ts, applied, skippedAdmin, skippedSame, skippedNotUser, errors}`.
      Surface last 10 runs in the admin modal.
- [ ] Dry-run mode (`?dry=1`) on the bulk endpoint — returns what WOULD
      change without writing. Run it once manually before flipping the cron on.

### Cost / risk
Essentially free: one HTTPS call per day + the Redis writes for the diff.
No new dependencies. Manual paste flow stays as fallback if the cron breaks.
