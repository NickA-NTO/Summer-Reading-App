// Returns the current session as JSON. Called by the client on page load to
// populate the user's name / email / avatar / working grade / visible tracks.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import {
  guessGradeFromEmail,
  redis,
  getCurrentlyReading,
  getAchievements,
  evaluateAchievementsForUser,
} from "../../lib/store.js";
import { normalizeGrade, stallAlarmDays, estimatedMinutes } from "../../lib/xp.js";
import { resolveVisibleTracks, TRACK_ORDER } from "../../lib/tracks.js";
import { getBook } from "../../lib/books.js";
import { ACHIEVEMENTS } from "../../lib/achievements.js";

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
    return res.end(JSON.stringify({ authenticated: false }));
  }

  const profile = await loadProfile(session.email);
  const grade = resolveGrade(profile, session.email);
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
  const achievementCatalog = ACHIEVEMENTS.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    desc: a.desc,
    hidden: !!a.hidden,
  }));
  // Enrich with the alarm threshold + expected minutes so the client can
  // render the stall warning without needing the book wordCount on the
  // client side. Server is the single source of truth for these numbers.
  if (currentlyReading?.bookId) {
    const book = getBook(currentlyReading.bookId);
    if (book) {
      const opts = {
        includeQuizTime: true,
        emergent: book.quizStyle === "emergent",
      };
      currentlyReading.alarmDays = stallAlarmDays(book.wordCount, grade, opts);
      currentlyReading.expectedMinutes = estimatedMinutes(book.wordCount, grade);
      currentlyReading.title = book.title;
    }
  }

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      authenticated: true,
      email: session.email,
      name: session.name,
      picture: session.picture || null,
      isAdmin: isAdminUser,
      grade,
      visibleTracks,
      currentlyReading,
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
