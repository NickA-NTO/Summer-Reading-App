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
      `/api/quiz` calls OpenAI through the AI SDK with a zod schema, caches
      results in Redis so retries see the same 4 questions. Quiz UI walks the
      kid through one question at a time, requires 3/4 to pass.
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
- [ ] **Question source**: hand-written vs. AI-generated via Vercel AI Gateway?
      _Recommend: AI-generated, then hand-reviewed for K-2 tone and accuracy._
- [ ] **Pass threshold**: 3 of 4? 4 of 5? _Recommend: 3/4, with one retry._
- [ ] **Retries**: unlimited, capped, or cooldown after fail?
- [ ] **Where to store questions**: bundled in `index.html` (fast, no DB) or
      pulled from a `/api/quiz?bookId=...` endpoint (lets us update without
      a deploy)?

### Data model
```js
{
  bookId: "k01",
  questions: [
    {
      q: "What did the caterpillar eat on Saturday?",
      options: ["A leaf", "All the foods in the picture", "Nothing", "A pizza"],
      answer: 1,
      tts: true              // read aloud automatically on K-1 quizzes
    },
    ...
  ]
}
```

### Build steps
- [ ] Define quiz schema + add `quizzes.js` (or `/api/quiz/[id].js`)
- [ ] Write or generate 4 questions per book × 28 books = **112 questions**
- [ ] Quiz UI component (one-question-at-a-time, big tap targets, K-2 friendly)
- [ ] Pass/fail screen with "Try again" or celebration animation
- [ ] Gate the existing "I read this" / vote / comment buttons behind a pass
- [ ] Track per-user quiz state: `{ bookId: { passed, attempts, lastScore } }`
- [ ] Show a "📝 Take the quiz" pill on the book detail modal once read
- [ ] Auto-read questions aloud when the global TTS toggle is on

### Stretch
- [ ] Adaptive questions — get harder if a kid keeps passing first try
- [ ] Teacher quiz-builder UI (drop in a paragraph, generate 4 questions via
      AI Gateway)

---

## 2. Leaderboard

**Goal:** Kids see how their class / grade / school is doing and feel motivated
to read more. Privacy-first because K-2.

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

- [ ] **Database choice** (blocks leaderboard + class management). Decide on
      Neon Postgres (recommended) vs. Upstash Redis vs. something else.
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
