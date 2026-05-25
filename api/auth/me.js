// Returns the current session as JSON. Called by the client on page load to
// populate the user's name / email / avatar / working grade / visible tracks.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import {
  guessGradeFromEmail,
  redis,
  getCurrentlyReading,
} from "../../lib/store.js";
import { normalizeGrade, stallAlarmDays, estimatedMinutes } from "../../lib/xp.js";
import { resolveVisibleTracks } from "../../lib/tracks.js";
import { getBook } from "../../lib/books.js";

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
  const visibleTracks = resolveVisibleTracks(grade, trackOverrides);
  let currentlyReading = await getCurrentlyReading(session.email);
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
      isAdmin: isAdmin(session.email),
      grade,
      visibleTracks,
      currentlyReading,
    })
  );
}
