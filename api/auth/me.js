// Returns the current session as JSON. Called by the client on page load to
// populate the user's name / email / avatar / working grade / visible tracks.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import {
  guessGradeFromEmail,
  redis,
  getCurrentlyReading,
  getAchievements,
  evaluateAchievementsForUser,
  setInitialGradeIfMissing,
  STARTED_RECENTLY_HOLD_MS,
  STARTED_RECENTLY_HOLD_MS_RULES,
  createDataRequest,
} from "../../lib/store.js";
import { normalizeGrade, stallAlarmDays, estimatedMinutes } from "../../lib/xp.js";
import { resolveVisibleTracks, TRACK_ORDER, trackForBook } from "../../lib/tracks.js";
import { getBook } from "../../lib/books.js";
import { ACHIEVEMENTS } from "../../lib/achievements.js";
import { QUIZ_SCHEMA_VERSION } from "../quiz.js";

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
  const isAdminUser = isAdmin(session.email);
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
      const isHiddenForUser =
        !isAdminUser && t && !visibleTracks.includes(t);
      if (isHiddenForUser) {
        currentlyReading = null;
      } else {
        const opts = {
          includeQuizTime: true,
          emergent: book.quizStyle === "emergent",
        };
        currentlyReading.alarmDays = stallAlarmDays(book.wordCount, grade, opts);
        currentlyReading.expectedMinutes = estimatedMinutes(book.wordCount, grade);
        currentlyReading.title = book.title;
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
