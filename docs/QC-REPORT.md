# TTS & Quiz QC Report

> **Round 2 addendum (2026-07-06) — full pre-rollout QC.** See [§8](#8-round-2-2026-07-06--full-pre-rollout-qc) below for the second pass: live-prod TTS verification, end-to-end student-flow audit, full 516-question quality review, and the fixes shipped from it.

_Scope: TTS audio quality + quiz-question correctness. TimeBack/Caliper integration is tracked separately (owned by another workstream) and is out of scope here._

_Generated: 2026-07-02_

---

## 1. Summary

| Area | Status |
|---|---|
| Full-catalog TTS re-synth | ✅ Complete (9,891 / 9,920 clips, 4 voices) |
| "Orange"→"range" onset clipping | ✅ Fixed catalog-wide |
| Quiz wording fixes (Goldilocks, Ice Cream) | ✅ Shipped + pushed |
| Missing quiz banks (14 books) | ⚠️ Open issue — hidden from students, but no quiz exists |
| Voice-retell path for those 14 | ❓ Unverified |

All committed QC work is on `origin/main` (up to `8f70256`). Nothing awaiting push.

---

## 2. TTS Re-synth (COMPLETE)

**Goal:** eliminate `tts-1` onset clipping (short words like "Orange" spoken as "range" — a defect Whisper QC could not detect because it auto-corrected the transcription) **and** unify the whole catalog on one voice model.

**Method:** re-synthesized every clip with **`gpt-4o-mini-tts-2025-12-15`**, verify-before-store (each clip transcription-checked before being written to Blob), resumable via `resynth.progress`. Script: [`scripts/repair-tts.js`](../scripts/repair-tts.js) with `RESYNTH_ALL=1`.

**Result:**
- **9,891 / 9,920** clips re-synthed across 4 voices (nova, shimmer, ash, fable).
- **0 real defects.**
- **"Orange" verified fixed** — now 1.25–2.16s full-length across all voices (was 0.41–0.58s clipped).

### Known non-issues — 11 "stillBad" (false positives, NOT defects)
These 11 clips "failed" verification only because Whisper's *spelling* of correct audio differs. Duration-checked — all full-length, correct speech. **No action needed.**

| Voice | Intended | Whisper heard | Why it's fine |
|---|---|---|---|
| ash | "150 pounds." | "£150" | Whisper wrote currency symbol; audio says the words (3.4s) |
| ash | "180 pounds." | "£180." | same |
| fable | "80 pounds." | "£80." | same |
| ash | "Wrecks it." | "REXIT" | phonetically identical |
| nova/shimmer/fable | "N's." | "Ends"/"Ends name." | letter-N-plural genuinely sounds like "ends" |
| nova | "Jim." | "gym" | near-homophone |
| fable | "Jim." | "Chin" | Whisper mishear; audio correct |
| nova/shimmer | "Klabble Bunny." | "Clabble Bunny." | invented name, C/K spelling variance |

---

## 3. Quiz-Question Fixes (SHIPPED)

| Book | Question | Fix | Commit |
|---|---|---|---|
| Goldilocks (k04) | "What does Baby Bear say when he finds Goldilocks?" | Added **"in his bed"** so the answer "She's still in it" has an antecedent. Book-accurate. | `ba04f7f` |
| Should I Share My Ice Cream? (e05) | "…all gone by the time he decides?" | Reworded to **"…by the time he decides to share?"** for clarity. Answer unchanged. | `8f70256` |

For both, TTS for the new question text was synthed + verified across all 4 voices to Blob, so "Hear it" plays the new wording immediately.

### Verified correct (no change needed)
- **Gruffalo Q8** ("favourite food = roasted mouse") — confirmed book-accurate.
- **e05 "thinks too long"** — the melting angle is already covered by e05 Q1 ("It melts in the sun") and Q4 ("Nothing but a puddle"); Q8 correctly targets the *cause* (theme). Not redundant.
- **Answer-position rotation** — banks store answers in a `0,1,2,3` pattern, but the client Fisher-Yates **shuffles options per attempt** ([index.html:6082](../index.html:6082)) and picks a random 5-of-~12. Students never see the pattern. (Caveat: shuffle is client-side; a network inspector sees canonical order but not the answer key, which is HMAC-protected.)

---

## 4. Non-QC change made during this work

| Change | Commit |
|---|---|
| Added `raditya.dwiprasta@alpha.school` to `HARDCODED_BYPASS_QUIZ_HOLDS` (time-based quiz-hold exemption; **not** admin). | `148d87b` |

---

## 5. Open Issue — 14 books with no quiz bank

**14 of 55 shipped books have no `docs/book-questions/*.json` bank:**

- **8 Usborne titles:** `u01` Enormous Turnip, `u02` Gingerbread Man, `u03` Chicken Licken, `u04` Jack and the Beanstalk, `u05` Princess and the Pea, `u06` Elves and the Shoemaker, `u08` Rapunzel, `u09` Pinocchio. _(Note: there is no `u07` in the catalog — so it is 8 titles, not "u01–u09".)_
- **6 Beginning-Reader titles:** `e06` Hop on Pop, `e08` Biscuit, `e09` Little Bear, `e10` Frog and Toad All Year, `e11` Goose on the Loose, `e12` Pirate Pat.

**Current behavior:**
- These 14 are **already hidden from students** by the `#91` `bookHasQuiz` filter ([index.html:4148](../index.html:4148)), which gates catalog rows, genre rows, and the hero on the server's `availableQuizBookIds` list ([api/quiz.js:157](../api/quiz.js:157)).
- **Admins still see them** unless they opt into the avatar-menu "hide books without quizzes" toggle (`rs.admin.hideNoQuizBooks`, [index.html:7493](../index.html:7493)).
- All 14 **are** registered in `QUIZ_BOOKS` and have hand-authored summaries — but the runtime AI-generation fallback is **disabled**, so hitting "Quiz" on one returns **`503 no_quiz_questions`** ([api/quiz.js:1621](../api/quiz.js:1621)).

**Decision needed:**
1. **Author the 14 missing banks** (from existing summaries) so the books can be un-hidden, **or**
2. Leave them hidden from students (current state) and optionally default admins to hide too (one-line change at [index.html:4152](../index.html:4152)), **and/or**
3. Confirm the **voice-retell** path works for these 14 so there's at least one XP route while banks are pending _(unverified — recommend checking)_.

---

## 6. Stale / uncommitted files

Working-tree clutter present but **not** committed. None are TTS/QC artifacts I authored; most are TimeBack/reference material likely from the other workstream.

**Modified:**
- `.claude/settings.local.json`

**Untracked:**
- `.lessons_map.json`, `.single_map.json`, `.units_map.json`
- `Alpha-Summer-Reading-Book-List.docx`, `Alpha-Summer-Reading-QC-Test-Plan.docx`
- TimeBack docs: `Auth API…pdf`/`.txt`, `Developer guide…pdf`/`.txt`, `Product overview…pdf`/`.txt`, `TIMEBACK_INTEGRATION_PLAYBOOK.md`

**Gitignored progress/report files (safe to delete after review):**
- `resynth.progress`, `prewarm.progress`, `repair-tts.report*.txt`, `.env.repair`, `.env.prod.local`

**Recommendation:** the `.json` map files and `.docx`/PDF references should either be added to `.gitignore` or committed by whoever owns them — they don't belong to the QC work. I did not touch them.

---

## 7. Reference — key files

- [`scripts/repair-tts.js`](../scripts/repair-tts.js) — re-synth + verify tool (`RESYNTH_ALL=1` for full migration).
- `docs/book-questions/*.json` — 41 static quiz banks (source of truth for questions).
- `docs/book-summaries/*.md` — 55 hand-authored book-only summaries (quiz source; book-only facts, no secondary sources).
- Blob TTS clips: keyed `sha256("v6|"+voice+"|"+text)` at `tts/{key}.mp3`.

---

## 8. Round 2 (2026-07-06) — full pre-rollout QC

Second full pass before student rollout: verified round-1 fixes against **live production**, audited the complete student flow (quiz ↔ retell ↔ XP state machine), the whole audio pipeline, and every question in all 41 banks (516 questions).

### 8.1 Round-1 fixes re-verified on live prod

- **"Orange" onset clipping** — downloaded the live Blob clips: 1.25–2.16 s across all 4 voices, Whisper hears "orange" in every one. Fixed for real.
- **Goldilocks / Ice-cream wording fixes** — new question text present in the banks; TTS clips for the new wording exist and are valid MP3s in all 4 voices on the live Blob store.
- **TTS catalog coverage** — swept all **2,190 unique quiz strings** (every question + every option) against the live Blob store (nova): **0 missing**. Random-sample GETs across the other voices: all valid MP3s, plausible durations. No base64 anywhere in the audio path — clips are binary MP3s on the Blob CDN; the only base64 audio is the 108-byte silent-unlock WAV, which decodes to a valid RIFF/WAVE and is CSP-safe (blob: URL).

### 8.2 Fixed this round — quiz banks (9 MAJOR: dual-correct / ambiguous / TTS-confusable)

| Bank | Q | Problem | Fix |
|---|---|---|---|
| a09 v4 | Q5 | "He costs too much" also true (mother's money line) | distractor → "He is too small" |
| a11 v4 | Q11 | summary says "peasant / farmer" — both options correct | "A farmer" → "A fisherman" |
| b07 v4 | Q9 | Rabbit/Mole/Weasel were ALSO dug out + join underground | distractors → Squirrel/Deer/Owl |
| b08 v5 | Q6 | "Eat soft fruit" is also against Mother Bird's rules | distractor → "Eat bugs and worms" (required, so clearly not against) |
| c02 v4 | Q8 | hotel register IS a guest book | "The guest book" → "A letter" |
| c05 v6 | Q12 | egg sac is NOT left at fairgrounds (Q13 contradicts) | stem → "What does Charlotte make to keep her eggs safe?" |
| c06 v4 | Q9 | "A doctor" defensible for *Dr.* Carey (dentist) | → "A sailor" |
| e02 v4 | Q13 | Willems vs "Mo Williams" — homophones under TTS | → "Mo Winters" |
| k08 v4 | Q4 | hat wording unsupported (summary self-contradicted); "red" leaked Q3 | stem → sign wording; k08 summary reconciled |

TTS for every changed string synthed + verified (Whisper) to Blob in all 4 voices — "Hear it" plays the new wording immediately.

### 8.3 Fixed this round — student-flow / audio dead-ends

- **Retell mic-permission denied had no Skip** — a kid on a policy-blocked (school-managed) device who passed the quiz looped forever on "Try again" with no XP path. Now uses the standard recovery UI: Try again **or Skip** → no-device finalize banks quiz-tier XP.
- **Quiz submit during fraud cooldown (423)** — client had no `cooldown` case: showed "this won't count against you" (false) with an infinite retry loop into the same 423. Now: honest cooldown screen, no retry button, window mirrored to localStorage, and the time formatter is day-aware ("tomorrow at 9:12 AM") since cooldowns run 2–72 h.
- **CONTINUE-READING steered kids into bank-less books** — the #91 filter covered rows/hero-favorites but not continue-reading or the book modal. `/api/auth/me` now clears `currentlyReading` for a book with no question bank (same pattern as track-locked), so the kid lands on the normal picker instead of a 503 dead-end.
- **Onboarding voice preview stuck on "Playing…"** — cold synth could outlive the tap's gesture window; `play()` rejection was swallowed (no sound, no fallback, label stuck). Now falls back to browser TTS and fixes the label.
- **TTS budget-cap 429 handling was dead code** — `ttsBudgetReached` was never set, so after cap every utterance paid a doomed API round-trip (and burned per-email rate limit); the designed banner never showed. Now wired: flag set on `tts_budget_reached`, banner shown once, prewarms stop.

### 8.4 Verified sound (no change needed)

- **Attempt machine**: server-authoritative counter + submissionId dedupe; out-of-attempts and fail-both auto-route to the retell (base-XP path) — the old lockout class is closed. localStorage wipes / cross-device can't reset attempts or downgrade a pass.
- **Grading**: HMAC answer-tokens (per-email, day-bucketed with yesterday fallback — no midnight bug); no raw `answer` field leaks to non-admin clients.
- **XP integrity**: SADD dedupe + delta top-up, compensating SREM on award failure, single-finalize NX lock. No double-award or lost-XP path found.
- **Retell resilience**: mic-lost, stalled-thinking, upload-timeout, empty-recording, grader-LLM-failure all have recovery UIs; silence stays retryable; grader failure resolves to fF keeping base XP.
- **speak() pipeline**: seq/abort race logic sound; silent-WAV unlock valid + CSP-allowed; quiz narration token logic sound (single-part narration); voice picker consistent client↔server incl. legacy id normalization.
- **Answer-order security**: banks store answers in rotation but the client shuffles per attempt; only HMAC tokens leave the server for students.

### 8.5 Known issues left OPEN (ranked)

1. **14 books still have no quiz bank** (8 Usborne u01–u09 minus u07, 6 Beginning-Reader e06/e08–e12) — hidden from students; each needs an authored bank. The retell engine itself doesn't depend on banks, but students have no entry point without a quiz. **Decision still needed** (§5).
2. **Server 423 ordering** ([api/activity.js](../api/activity.js) ~794): cooldown fires *after* the attempt INCR and *before* the outcome is stored — a legitimate pass during cooldown burns an attempt and the pass is discarded. Client now explains honestly, but consider: check cooldown *before* INCR, or store a pass before the 423.
3. **Terminal retell fail is device-local** (`_retellShowResult`): fF_fF sets `read=true` locally but the server never records it — the book reappears on other devices and can be redone for fF_pX XP. Decide intended semantics.
4. **Retell tutor clips >15 s** get cut by the absolute stall-watchdog and re-read in browser voice — make the watchdog inactivity-based (reset on `timeupdate`).
5. **Whisper upload MIME hardcoded `audio/webm`** ([lib/tutor.js](../lib/tutor.js) ~410) while Safari sends mp4/AAC — works today (OpenAI keys off filename), latent breakage if they validate part MIME.
6. **Quiz-start prewarms dead narration strings** ("Here are your choices." + "Option A is …" per question) that the refactored narration never plays — wasted synth budget + ~15 extra rate-limit slots per quiz start.
7. **401 mid-flow copy** — expired session during quiz submit / retell turn shows generic "Try again" loops instead of "sign in again" guidance (rare: 7-day cookie).
8. **Answer-then-close race** can corrupt a saved slate → one burned attempt on resume (self-heals on close).
9. **Minor bank polish list** (non-blocking): cross-question stem/option leaks in ~14 banks (only ever *help* the student; client draws 5-of-12 so they inflate scores slightly), a02 Q1 odd-one-out options, b02 Q8 yes/no format, b06 triple-toast redundancy, a08 Q11 pronoun, a10 Q12 through/past, e01 Q2/Q7 weak distractors, k01 Q12 overlap, k07 "dungarees", e04 "Desperate", c02 Q9 M's/N's TTS-confusable, e02 Q4 "neither".
10. **Stale Redis TTS URL never self-heals** if a blob is manually deleted (client falls back to browser voice for that phrase forever). Only matters after manual blob deletions.

### 8.6 Round 3 (2026-07-06) — open-issue burn-down + browser-voice elimination

Implemented by model-tiered subagents (Opus: bank editorial pass + audio pipeline; Sonnet: tutor server + quiz flow), each change re-verified line-by-line in a Fable QC pass afterward.

**Browser-voice elimination (the "browser voice sucks" directive):**
- **CDN-first playback** — the client now computes the clip URL itself (`sha256("v6|voice|text")` on the public Blob host) and plays it directly; `/api/tts` is only consulted to synth a missing clip. Rate-limit 429s, serverless cold starts, and Redis hiccups can no longer dump a kid to the robot voice for a clip that exists. Ordered candidates: cache → CDN → API → heal → browser (true last resort).
- **Heal path** — `/api/tts?heal=1` evicts a stale Redis URL and re-verifies/re-synths (fixes "deleted blob = that phrase robotic forever"); the client fires one heal per utterance when an API-provided URL errors.
- **Budget cap** no longer silences the cloud voice: capped sessions still play cache/CDN clips and only skip the synth-triggering API calls.
- **Retell tutor watchdog** is now inactivity-based (6 s without progress, 90 s absolute ceiling) instead of an absolute 15 s cut; a clip that already played >2 s is treated as delivered rather than re-read robotically from the start.

**Fixed open issues #3–#8 (from §8.5):**
- Terminal 0-XP retell fail now calls `markRetellDone` server-side (durable, cross-device); tutor `action=start` now refuses a retell-done book (409, admin-exempt) — the redo-for-XP loophole is closed. `doneBookIds` already unioned retellDone, so the client shows Done everywhere.
- Whisper upload MIME now follows the request Content-Type (Safari mp4/AAC no longer labeled webm).
- 401 mid-quiz and mid-retell now show "sign in again" with a working Sign-in button (reload) instead of infinite Try-again loops; copy verified truthful (quiz 401 fires before the attempt INCR; retell pass + retellPending are server-durable).
- Answer-then-close race: saves are now self-consistent (`idx` derived from `answers.length`), resume reconciles/heals old corrupt blobs (fully-answered blobs route straight to submit), and the server validates slate shape BEFORE the attempt INCR so malformed slates never burn an attempt.
- **Bank polish: all ~33 MINOR items fixed** across 29 banks (cross-question leaks de-leaked, weak/absurd distractors replaced, "neither" phrasing removed, dungarees/Desperate vocabulary simplified, M's/N's and palace/castle sound-alike traps removed, k01 antecedent restored using the book's own "small house" wording). Every changed string verified against its summary; all 516 questions re-validated; TTS synthed + Whisper-verified for every new string in all 4 voices; nova coverage sweep: **0 missing**.

**Still open after round 3:** §8.5 #1 (14 books need authored banks — decision), #2 (server 423 attempt-burn ordering — anti-fraud semantics decision), #6 (dead prewarm strings — cost only, mostly moot now that CDN-first skips the API), plus k04's accepted Q12→Q11 leak.

### 8.7 Live-prod checks run

- `/api/health`: all green (redis, anthropic, polly, tts, auth), quiz schema v11.
- Blob CDN: 2,190-string coverage sweep + MP3-validity sampling (frame-walk durations + Whisper spot-transcriptions). Probe tools: `scripts/qc-tts-probe.mjs`, `scripts/qc-orange-check.mjs`.
- Unauthenticated endpoints correctly 401.
- Authenticated quiz/submit flows were verified by code-trace only — no synthetic student data was written to prod.
