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
- [x] **Pilot: AI-generated quiz for The Very Hungry Caterpillar (k01)** —
      `/api/quiz` calls **Claude Haiku 4.5** through the AI SDK with a zod
      schema; server caches an 8-question pool in Redis. Client picks 4 at
      random per attempt with shuffled option positions, so kids can't
      memorize answer locations across attempts. **Max 2 attempts per day,
      need 3/4 to pass.** _Needs migration to 5 questions @ 80% pass +
      grade-leveled difficulty (see section 1c)._
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
- [ ] Migrate from 4 to **5 questions per attempt**, raise threshold to **80% (4/5)**
- [ ] Backfill plot summaries for the remaining 27 books in `api/quiz.js`
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
to read more. Privacy-first because K-2. **Ranked by XP, not book count** —
see section 1c for how XP is calculated.

### Migration from "books read" → "XP"
- [x] V1 leaderboard ranks by `count` of unique books read (already shipped)
- [ ] **V2: rank by XP**. Bump `DATA_VERSION` to invalidate any prior local
      cache. Redis sorted-set key changes from `lb:reads:all` to `lb:xp:all`.
- [ ] Existing reads get retroactive XP if we can compute it (we'd need
      `wordCount` + the student's working grade at the time of reading,
      which we don't have for old records — so likely just zero-out and
      start fresh).
- [ ] Leaderboard row displays `42 XP` instead of `7 books`. Optional
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
