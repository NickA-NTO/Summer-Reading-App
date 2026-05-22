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
- [ ] Teacher quiz-builder UI (drop in a paragraph, generate 4 questions via
      AI Gateway)

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
  Google Workspace org units, teacher dashboard assignment, or admin
  override.
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
- [ ] `wordCount` field on every book in `CATEGORIES` (28 lookups, ~15 min)
- [ ] WCPM lookup table in `lib/xp.js` (Hasbrouck-Tindal norms)
- [ ] `workingGrade` attribute per student. MVP: derive from a teacher
      dashboard or admin assignment. Stretch: pull from Google Workspace
      `gradeLevel` org-unit attribute.
- [ ] Quiz prompt updates: include `studentGrade` so AI calibrates
      difficulty. Cache key becomes `quiz:v3:<bookId>:<studentGrade>`.

### Build steps (in order)
- [ ] **Phase A — XP without grade leveling** (~1 hr)
  - Add `wordCount` to every book
  - Hardcode a default grade per student (use `guessGradeFromEmail` plus
    an admin override)
  - Compute XP on quiz pass; store in Redis
  - Replace leaderboard sort key from `count` to `xp`
- [ ] **Phase B — Grade-leveled quizzes** (~1 hr)
  - Server endpoint takes `studentGrade` and includes it in the AI prompt
  - Quiz cache keyed by `(bookId, studentGrade)` so each grade gets its own pool
  - 8-question pool generated per grade; client still picks 5 random per
    attempt
- [ ] **Phase C — Grade-leveled retell** (depends on 1b being built first)
  - Pass `studentGrade` into the retell grading prompt: stricter
    plot-point coverage and vocabulary expectations at higher grades
  - 80% retell score required for XP to be awarded
- [ ] **Phase D — Working-grade management UI**
  - Admin can set/edit a student's working grade
  - Optional self-service: kid picks their own grade once (locks until
    teacher overrides)

### Open decisions
- [ ] **Where does the student's working grade come from for v1?** Three
      options:
      - (A) Default to Google Workspace org unit `gradeLevel` if available,
        else fall back to email heuristic, else K
      - (B) Admin/teacher sets explicitly per student (no inference)
      - (C) Kid picks once at first login
      _Recommend: B for accuracy. A is too unreliable._
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
- [ ] Track which question IDs a student has seen for a given book.
      Store as a Redis set `quiz:seen:<email>:<bookId>` (with TTL of the
      24-hour cooldown).
- [ ] On attempt 2, **exclude any question the student has already seen
      on attempt 1**. Pool must be large enough — bump generation to
      10–12 questions per book so attempt 2 always has 5 fresh questions
      available.
- [ ] If the pool is exhausted (somehow), force-regenerate a brand new
      set via Claude with a "must be entirely different angle" prompt
      and bump the cache key.
- [ ] Verify with AI grading that attempt 2's questions aren't
      semantically near-duplicates of attempt 1's (use a cheap embeddings
      check, or just rely on the prompt to enforce diversity).

### 1d.2 Reduced rewards on 2nd-attempt passes

**Problem:** First-try passes mean the student actually retained the
content. Second-try passes — especially after multiple shuffled exposures
to the questions — are weaker signal.

**Fix:**
- [ ] **Internal leaderboard points**: 1st attempt pass = **100%** of
      book points; 2nd attempt pass = **50%**. Tunable in env var
      `POINTS_RETAKE_MULTIPLIER`.
- [ ] **Caliper event to TimeBack** (depends on 1e): reflect the 2nd
      attempt by setting `scoreGiven` to the actual quiz score, and
      include an `extension` field flagging it as the retake — TimeBack
      can apply its own XP penalty if desired.
- [ ] Make the reduction visible in the post-quiz success screen:
      "Great work! You earned **8 points** (would have been 16 on first
      try) — try to get it right first next time!"
- [ ] Admin can override (e.g., if a student's first attempt was
      glitched by a connectivity issue) — admin sets a per-attempt
      override flag in Redis.

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
| 2nd | 8 hours | Held; warn + notify teacher dashboard |
| 3rd | 24 hours | Held; admin must approve to release |
| 4th+ | 72 hours, escalating | Held; account flagged for review |

**Student-facing UX when blocked:**

The quiz button shows: **"⏰ Take a break and re-read. You can try
quizzes again at 2:00pm."** No accusatory language — frame as healthy
pacing. Tooltip: "Reading is best when you have time to enjoy it.
Come back after lunch!"

**Admin-facing UX:**
- New "Held XP" section in the admin modal showing flagged events
- Per-student "trust score" indicator (visible on the user list)
- One-click "Approve" or "Reject" per held event
- "Reset offence counter" button (in case the kid had a legitimately
  fast read — like a 30-page Knuffle Bunny)

**Open decisions:**
- [ ] **Threshold tuning**: 0.25 / 0.5 ratios are guesses. After v1 ships,
      review logs and adjust based on legit-fast-reader false positives.
- [ ] **Offence counter reset window**: never, monthly, or
      after-N-clean-submissions? _Recommend: decay 1 per week of clean
      submissions to allow recovery._
- [ ] **Whitelist for known fast readers**: should teachers be able to
      mark a specific kid as "advanced reader, don't flag"? Probably yes.
- [ ] **Notification channel for held events**: email digest to admin?
      In-app red dot? Both?

### Build order

These are independent but all depend on the XP system from section 1c.

1. Question rotation (1d.1) — small, ~1 hour, just Redis tracking
2. Reduced 2nd-attempt rewards (1d.2) — small, ~30 min in-app, but
   blocked by TimeBack write API for the sync part
3. Speed-based fraud detection (1d.3) — medium, ~2-3 hours, needs new
   admin UI

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
      tenant/sensor IDs we need
- [ ] **Identity mapping** — does TimeBack key on email, OneRoster
      student `sourcedId`, or a TimeBack-specific user ID? We need to
      know how to fill the `actor` field of the Caliper event
- [ ] **Event format version** — Caliper v1.1 vs. v1.2 (most recent)?
      TimeBack might only accept a specific version
- [ ] **Idempotency** — Caliper events have a UUID `id` field; we'll
      generate a deterministic one from `(email, bookId, attemptNumber)`
      so retries don't credit XP twice
- [ ] **When to emit** — immediately on quiz pass (real-time XP) or
      batched (cheaper but feedback loop is delayed)? Recommend
      immediate.
- [ ] **What about 2nd-attempt passes?** — do we emit a different event
      type, or modify the `scoreGiven` to reflect the 50% retake penalty?
      Recommend: emit the actual score, let TimeBack apply its own
      retake rules

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
- [ ] Add env vars: `TIMEBACK_CALIPER_URL`, `TIMEBACK_CALIPER_TOKEN`,
      `TIMEBACK_SENSOR_ID`
- [ ] `lib/caliper.js`: event builder functions (one per event type),
      UUID v5 deterministic ID helper, validation against the schema
- [ ] `lib/timeback.js`: POSTs to the Caliper endpoint, retry with
      exponential backoff, idempotency via the deterministic event ID
- [ ] Wire into the quiz completion handler: on pass (4/5 or 5/5),
      fire-and-forget the AssessmentEvent + GradeEvent pair
- [ ] Failure queue in Redis (`caliper:retry`), with a Vercel Cron job
      retrying failed events every 5 min until success or 24-hr giveup
- [ ] Admin view: "Caliper sync health" — count of events sent / queued
      / failed in the last 24 hours

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
- [ ] **Privacy**: store the raw audio (in Vercel Blob) for teacher review,
      or transcribe-and-discard? _Recommend: transcribe-and-discard by
      default, with an opt-in "let my teacher hear it" toggle._
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
- [ ] Teacher dashboard view of retell transcripts (with consent)
- [ ] Multi-language retell (Spanish, etc.) for ESL learners

---

## 2. Leaderboard

**Goal:** Kids see how their class / grade / school is doing and feel motivated
to read more. Privacy-first because K-2. **Ranked by internal POINTS, not
book count** — see section 1c for how points are calculated. Note: these
points are *internal-only* and distinct from the official TimeBack XP
that's awarded via Caliper events (see section 1e).

### Migration from "books read" → "points"
- [x] V1 leaderboard ranks by `count` of unique books read (already shipped)
- [ ] **V2: rank by internal points**. Bump `DATA_VERSION` to invalidate
      any prior local cache. Redis sorted-set key changes from
      `lb:reads:all` to `lb:points:all`.
- [ ] Existing reads get retroactive points if we can compute it (we'd
      need `wordCount` + the student's working grade at the time of
      reading, which we don't have for old records — so likely just
      zero-out and start fresh).
- [ ] Leaderboard row displays `42 pts` instead of `7 books`. Optional
      hover-tooltip: "from 4 books read".

### Decisions needed
- [ ] **Scopes shown**: my class only? my grade? whole school? all three?
      _Recommend: tabs for **My Class / Grade / School**._
- [ ] **Time windows**: weekly + all-time? add monthly?
- [ ] **Identity**: real names, "First L." initial, or kid-chosen handles?
      _Recommend: first name + last initial, pulled from Google profile._
- [ ] **Class membership**: how do we know a kid's class?
      - Option A: Google Workspace org units (admin sets up groups)
      - Option B: a teacher dashboard where teachers add their roster
      - Option C: kids self-select once at first login
      _Recommend: Option B short-term, Option A long-term._
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
- [ ] **Teacher / admin role** — a separate role with class-management UI.
      Will need a `role` column on `users` and a permissions check in
      middleware.
- [ ] **Preview env vars** — set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
      `AUTH_SECRET`, `ALLOWED_DOMAIN` for **Preview** env in Vercel, and add
      `*.vercel.app` preview redirect URIs to the Google OAuth client. Without
      this, PR previews show "Auth not configured."

---

## Polish (small wins, anytime)

- [ ] Default card badge shows grade letter (`K` / `1` / `2`) instead of `K-2`
- [ ] Grade pill in the modal metadata row
- [ ] Search bar in the header (filter all books by title/author)
- [ ] "My List" actually works (save-for-later separate from reads)
- [ ] Empty-state illustration for the "Keep Reading" row when it's empty
- [ ] Better loading state on the modal while the cover image fetches
- [ ] Light theme toggle (some classrooms have screens in bright sun)
- [ ] Accessibility audit (keyboard nav, screen reader, focus rings)
- [ ] Custom domain: `read.alpha.school` or similar
