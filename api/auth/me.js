// Returns the current session as JSON. Called by the client on page load to
// populate the user's name / email / avatar / working grade / visible tracks.

import { verifySession, parseCookies, isAdmin, isEffectiveAdmin, isHardcodedBypassQuizHolds, isTombstoned } from "../../lib/session.js";
import {
  guessGradeFromEmail,
  redis,
  getCurrentlyReading,
  clearCurrentlyReading,
  getAchievements,
  evaluateAchievementsForUser,
  setInitialGradeIfMissing,
  STARTED_RECENTLY_HOLD_MS,
  STARTED_RECENTLY_HOLD_MS_RULES,
  createDataRequest,
  isBypassQuizHoldsActive,
  getReadingSession,
  getQuizAttemptCount,
  QUIZ_DAILY_ATTEMPT_LIMIT,
  getReadBookIds,
  getRetellDoneIds,
  getQuizOutcomeDurable,
} from "../../lib/store.js";
import { normalizeGrade, stallAlarmDays, estimatedMinutes } from "../../lib/xp.js";
import { resolveVisibleTracks, TRACK_ORDER, trackForBook } from "../../lib/tracks.js";
import { getBook } from "../../lib/books.js";
import { ACHIEVEMENTS } from "../../lib/achievements.js";
import { QUIZ_SCHEMA_VERSION, getAvailableQuestionBookIds, QUIZ_BOOKS } from "../quiz.js";

// Load the user's profile row from Redis (returns null on miss or error).
async function loadProfile(email) {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.hget("users", String(email).toLowerCase());
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// Resolve the student's working grade:
//   1. If the admin (or TimeBack sync) has explicitly set it in the user's
//      Redis profile, use that.
//   2. Otherwise infer from the email local-part (guessGradeFromEmail).
//   3. Default to "K" if neither yields anything.
function resolveGrade(profile, email) {
  if (profile && profile.grade) return normalizeGrade(profile.grade);
  return normalizeGrade(guessGradeFromEmail(email) || "K");
}

export default async function handler(req, res) {
  const secret = process.env.AUTH_SECRET;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (!secret) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "auth_not_configured" }));
  }

  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);

  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({
      authenticated: false,
      // #71 — surface the environment even when unauthenticated so the
      // welcome screen can show the PREVIEW banner before sign-in.
      env: (process.env.VERCEL_ENV || "production").toLowerCase(),
    }));
  }

  // #13 — a session whose account was deleted (tombstoned) must not keep
  // resurrecting profile / achievement rows via the writes below. Treat it
  // as logged out so the client shows the welcome screen.
  if (await isTombstoned(session.email)) {
    res.statusCode = 401;
    return res.end(JSON.stringify({
      authenticated: false,
      accountRemoved: true,
      env: (process.env.VERCEL_ENV || "production").toLowerCase(),
    }));
  }

  // #20 — rate-limit the authenticated path. The default GET runs
  // loadProfile + evaluateAchievementsForUser + several Redis reads on
  // every call; without a cap a client loop hammers Redis unbounded.
  // Generous (120/min) so normal page loads + post-quiz refreshes never
  // hit it; fails open on a Redis blip. Applies to GET and POST alike;
  // the POST self-data branch additionally enforces its own tight
  // selfData bucket below.
  {
    const { checkRateLimit, send429, LIMITS } = await import("../../lib/rate-limit.js");
    const rl = await checkRateLimit({
      email: session.email, bucket: "me",
      max: LIMITS.me.max, windowSec: LIMITS.me.windowSec,
    });
    if (!rl.ok) return send429(res, rl);
  }

  // #59 — COPPA/GDPR self-service: export + erasure live on the same
  // endpoint to stay under the Vercel Hobby 12-function cap. Folded
  // here because /api/auth/me is the natural "self" surface, already
  // authenticated, and scoped exactly to the verified user.
  //
  // Self-service data endpoints have been retired. Users can no longer
  // export or delete their own data directly — they submit a REQUEST
  // that goes into an admin queue. The admin then runs the underlying
  // exportUserData / deleteUserData. This adds friction in both
  // directions: no accidental erasures, and exfil attempts hit a human
  // gate.
  //
  // POST /api/auth/me?action=request-data       → queue an export request
  // POST /api/auth/me?action=request-deletion   → queue a deletion request
  // The legacy ?action=export / ?action=delete endpoints return 410 so a
  // stale client can surface "this feature moved" instead of silently
  // failing.
  const action = new URL(req.url, `http://${req.headers.host}`).searchParams.get("action");
  if (action === "export" || action === "delete") {
    res.statusCode = 410;
    return res.end(JSON.stringify({
      error: "endpoint_removed",
      message:
        "Self-service data export/deletion was retired. Submit a request via the user menu — an admin will process it.",
    }));
  }
  if (action === "request-data" || action === "request-deletion") {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: "method_not_allowed" }));
    }
    // Same tight rate limit applies — the request endpoint itself
    // could be abused to spam the admin queue. 5/hour is generous for
    // legitimate use; well below abuse threshold.
    const { checkRateLimit, send429, LIMITS } = await import("../../lib/rate-limit.js");
    const rl = await checkRateLimit({
      email: session.email, bucket: "selfData",
      max: LIMITS.selfData.max, windowSec: LIMITS.selfData.windowSec,
    });
    if (!rl.ok) return send429(res, rl);

    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const type = action === "request-data" ? "export" : "deletion";
    const result = await createDataRequest({
      email: session.email,
      type,
      reason: typeof body.reason === "string" ? body.reason : "",
    });
    if (!result.ok) {
      res.statusCode = 503;
      return res.end(JSON.stringify({
        error: result.reason || "request_failed",
        message:
          "We couldn't submit your request right now. Try again in a minute.",
      }));
    }
    return res.end(JSON.stringify({
      ok: true,
      id: result.id,
      status: result.status,
      alreadyPending: !!result.alreadyPending,
      message: result.alreadyPending
        ? "You already have a pending request of this type. An admin will review it shortly."
        : "Your request has been submitted. An admin will review it shortly.",
    }));
  }

  const profile = await loadProfile(session.email);
  const grade = resolveGrade(profile, session.email);
  // Lock the kid's initial grade the first time we see them. This is the
  // anchor for the stretch-ladder achievements: growth makes badges easier
  // to keep earning, never harder. Idempotent — no-ops once set.
  if (!profile?.initialGrade) {
    try {
      const locked = await setInitialGradeIfMissing(session.email, grade);
      if (locked && profile) profile.initialGrade = locked;
    } catch {}
  }
  const trackOverrides = profile?.trackOverrides || {};
  // Admins see every catalog tier regardless of working grade — they need
  // the full view for QA and for managing student-side track-locking.
  // Students get the normal at-or-below-working-grade rule (+ overrides).
  const trueAdmin = isAdmin(session.email);
  const studentMode = trueAdmin && !!profile?.studentMode;
  // `isAdminUser` is the EFFECTIVE admin: a true admin loses admin testing
  // privileges while Student Mode is on (#studentmode), so every downstream
  // gate — catalog see-all, the response's `isAdmin` flag, the
  // currentlyReading track-lock bypass — treats them as an ordinary kid.
  const isAdminUser = isEffectiveAdmin(session.email, profile);
  // #redo / #T41 — the set of FULLY-DONE books, the source of truth for "done"
  // so a finished book can't be redone for 0 XP after a localStorage reset /
  // new device / deploy. "Fully done" = the retell finalized (quiz books) OR a
  // non-quiz manual read. A quiz book in the read-set whose retell NEVER
  // finalized (pre-#9 quiz-pass) is NOT done — it still owes a retell.
  const [readSet, retellDoneIds] = await Promise.all([
    getReadBookIds(session.email).catch(() => []),
    getRetellDoneIds(session.email).catch(() => []),
  ]);
  // #T41 — use the FULL quiz-gated set (QUIZ_BOOKS), not just books with a
  // shipped bank, as the "is this a quiz book" oracle. Otherwise a quiz-gated
  // book without a bank would be treated as a non-quiz manual read and shown
  // Done with no retell owed.
  const quizBookSet = new Set(Object.keys(QUIZ_BOOKS));
  const retellDoneSet = new Set(retellDoneIds);
  const doneBookIds = Array.from(new Set([
    ...retellDoneIds,
    ...readSet.filter((id) => !quizBookSet.has(id)),
  ]));
  const visibleTracks = isAdminUser
    ? [...TRACK_ORDER]
    : resolveVisibleTracks(grade, trackOverrides);
  let currentlyReading = await getCurrentlyReading(session.email);
  // Backfill any achievements the user has earned but never had recorded —
  // covers two cases: users who read books before the achievement system
  // shipped, and tier targets that move (e.g., dropping the threshold).
  // The evaluator is idempotent: it only writes for badges not already in
  // the hash, and per-event ones (Beginner's Mind, Reaching Higher) are
  // skipped here since we don't pass justRead.
  try { await evaluateAchievementsForUser(session.email, profile, {}); } catch {}
  const unlockedAchievements = await getAchievements(session.email);
  // Send the full catalog of achievement definitions + the user's unlocked
  // timestamps. Lets the client render the achievements modal without a
  // second round-trip.
  // Include progress targets so the client doesn't have to mirror them
  // in a hardcoded const. Optional — boolean / event-style achievements
  // (Tour Guide, Beginner's Mind, the stretch ladder) omit them and the
  // client renders no progress bar for those.
  const achievementCatalog = ACHIEVEMENTS.map((a) => {
    const entry = {
      id: a.id,
      name: a.name,
      icon: a.icon,
      desc: a.desc,
      hidden: !!a.hidden,
    };
    if (a.progressTarget != null) entry.progressTarget = a.progressTarget;
    if (a.progressStat) entry.progressStat = a.progressStat;
    return entry;
  });
  // Enrich with the alarm threshold + expected minutes so the client can
  // render the stall warning without needing the book wordCount on the
  // client side. Server is the single source of truth for these numbers.
  //
  // Track-lock leak fix (Agent 7 #3): if the kid's currentlyReading
  // points at a book whose track has been admin-locked AFTER they
  // started reading, clear it from the response. Otherwise the home
  // page shows "Now reading: X" but the Quiz button 403s — confusing
  // dead-end with no recovery path for a K-2 reader. Admins keep
  // seeing the book (they bypass track-locks).
  if (currentlyReading?.bookId) {
    const book = getBook(currentlyReading.bookId);
    if (book) {
      const t = trackForBook(book);
      // #91 follow-up — treat a book with NO shipped question bank exactly
      // like a track-locked one. A kid whose active read predates the
      // bookHasQuiz filter (or whose book's bank failed validation on a
      // later deploy) would otherwise be steered by "CONTINUE READING"
      // into a book whose Quiz button 503s — no XP path at all, since
      // manual reads are quiz_required and the retell needs quiz attempts.
      const noBank =
        !isAdminUser &&
        !getAvailableQuestionBookIds().includes(
          String(currentlyReading.bookId).toLowerCase()
        );
      const isHiddenForUser =
        (!isAdminUser && t && !visibleTracks.includes(t)) || noBank;
      if (isHiddenForUser) {
        // #E — don't just MASK it in the response: clear the server row too,
        // else the stale reading:{email} keeps 409-blocking "I'm reading this"
        // on every OTHER book (already_reading) — a permanent lockout.
        try { await clearCurrentlyReading(session.email); } catch {}
        currentlyReading = null;
      } else {
        const opts = {
          includeQuizTime: true,
          emergent: book.quizStyle === "emergent",
        };
        currentlyReading.alarmDays = stallAlarmDays(book.wordCount, grade, opts);
        currentlyReading.expectedMinutes = estimatedMinutes(book.wordCount, grade);
        currentlyReading.title = book.title;
        // #return — surface in-progress quiz/retell state so the client can
        // route a returning student to the correct next step instead of
        // dead-ending after they exit. The reading session only exists
        // pre-finalize (finalizeAndGrade clears it), so a present quizOutcome
        // means the retell hasn't been completed yet. The attempt counter has
        // a 365-day TTL, so it survives the reading-session window and lets us
        // tell "failed once, take attempt 2" apart from "failed both → retell".
        try {
          const rs = await getReadingSession(session.email, currentlyReading.bookId);
          const attemptsUsed =
            Number(await getQuizAttemptCount(session.email, currentlyReading.bookId)) || 0;
          // #T41 — use the DURABLE quiz outcome (365d) as well as the short-lived
          // reading session, so a pass still routes to the retell (never a
          // re-quiz) long after the session expires.
          const durableOutcome = await getQuizOutcomeDurable(session.email, currentlyReading.bookId).catch(() => null);
          const quizOutcome = rs?.quizOutcome || durableOutcome || null;
          const quizPassed = quizOutcome === "p1" || quizOutcome === "p2";
          const retellDone = retellDoneSet.has(currentlyReading.bookId);
          currentlyReading.progress = {
            quizOutcome,
            quizPassed,
            attemptsUsed,
            // The quiz is "settled" once the student passed OR used both attempts
            // — a settled quiz can never be retaken (#T41).
            quizSettled: quizPassed || attemptsUsed >= QUIZ_DAILY_ATTEMPT_LIMIT,
            // The retell is the next step when the quiz is settled AND the retell
            // isn't done yet. Once the retell finalizes the book is fully done.
            retellPending: !retellDone && (quizPassed || attemptsUsed >= QUIZ_DAILY_ATTEMPT_LIMIT),
          };
        } catch {}
      }
    }
  }

  // Age grade is separate from working grade. Working grade drives
  // catalog visibility + XP math; age grade drives question MATURITY
  // (task #30). When TimeBack hasn't given us an age grade, fall
  // through to the working grade so quiz prompts have something
  // sensible to anchor on.
  const ageGrade = profile?.ageGrade
    ? normalizeGrade(profile.ageGrade)
    : grade;

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      authenticated: true,
      email: session.email,
      name: session.name,
      picture: session.picture || null,
      ageGrade,
      isAdmin: isAdminUser,
      // #studentmode — the TRUE admin bit (drives the Student Mode toggle's
      // visibility + the persistent banner) and whether Student Mode is on.
      // `isAdmin` above is the EFFECTIVE value (false while in Student Mode),
      // so every existing client `isAdmin` branch auto-flips with no per-check
      // client edit; `trueAdmin` is the escape hatch that always shows the
      // toggle so the operator can switch back.
      trueAdmin,
      studentMode,
      // #redo / #T41 — books the kid has FULLY FINISHED (retell done, or a
      // non-quiz read). Client marks these Done so they can't be redone for 0
      // XP. A quiz-passed-but-retell-pending book is intentionally NOT here.
      doneBookIds,
      grade,
      visibleTracks,
      currentlyReading,
      // #71 — deployment environment. "production" | "preview" | "development".
      // Client renders a PREVIEW banner when this isn't "production" so an
      // admin testing on a preview URL never confuses it for the live site.
      env: (process.env.VERCEL_ENV || "production").toLowerCase(),
      // Server-derived constants exposed so the client doesn't have to
      // mirror them in hardcoded constants (low-tier drift risk).
      // The pre-quiz "Slow down a sec" warning fires under the same
      // window the server uses to auto-hold quizzes submitted too soon
      // after "I'm reading this" — kid never gets surprised by a held
      // submission.
      //
      // startedRecentlyHoldMs: legacy single-value default (1 hour),
      //   kept so older client revisions still get a sensible value
      //   before they pick up the per-grade rules.
      // startedRecentlyHoldMsRules: per-book-grade overrides. Client
      //   picks rules[book.grade] ?? rules.default. PK/K → 15 min,
      //   G1 → 30 min, G2+ → 60 min (default).
      startedRecentlyHoldMs: STARTED_RECENTLY_HOLD_MS,
      startedRecentlyHoldMsRules: STARTED_RECENTLY_HOLD_MS_RULES,
      // Current quiz schema version — client stamps this onto saved
      // localStorage quiz progress so a server-side SCHEMA_VERSION
      // bump (which busts the Redis pool cache) ALSO auto-invalidates
      // every kid's mid-quiz resume blob. Without this the kid keeps
      // seeing the old (buggy) questions baked into localStorage even
      // though the server has fresh, corrected ones ready to ship.
      quizSchemaVersion: QUIZ_SCHEMA_VERSION,
      // List of bookIds that have a shipped question bank under
      // docs/book-questions/*.json. Non-admin catalog renders filter
      // out books not in this set so a kid never opens a modal whose
      // "Take quiz" button would 503 with no_quiz_questions. Admins
      // see everything regardless (so they can author/test).
      availableQuizBookIds: getAvailableQuestionBookIds(),
      // #97 — per-user bypass of the started-recently timer + WCPM
      // speed check. Reopen-pattern check still applies. Client uses
      // this to skip the "Slow down a sec" overlay. Granted via the
      // admin panel toggle; NOT the same as admin permission.
      // Bypass holds true if EITHER the admin-set profile flag is
      // active (set AND not expired — #27) OR the email is in the
      // hard-coded VIP list (Andy Montgomery for the COO demo, which
      // is permanent + reviewed in git). Hard-coded list bypasses the
      // first-login requirement — no need to seed the Redis profile.
      bypassQuizHolds:
        isBypassQuizHoldsActive(profile) ||
        isHardcodedBypassQuizHolds(session.email) ||
        // Student Mode keeps the time-holds bypassed so the operator can run
        // the full kid flow fast — caps/gating are what Student Mode restores,
        // not the 15-min/WCPM waits. #studentmode
        studentMode,
      // Onboarding state (#17) — client uses these to decide whether to
      // show the first-run voice picker + spotlight tour. tourCompleted=true
      // suppresses it forever (admin can reset via the admin endpoint).
      preferredVoiceId: profile?.preferredVoiceId || null,
      tourCompleted: !!profile?.tourCompleted,
      // Achievements (#24) — full catalog + the user's unlock map.
      achievementCatalog,
      unlockedAchievements,
    })
  );
}
