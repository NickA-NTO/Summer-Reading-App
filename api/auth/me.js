// Returns the current session as JSON. Called by the client on page load to
// populate the user's name / email / avatar / working grade.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import { guessGradeFromEmail, redis } from "../../lib/store.js";
import { normalizeGrade } from "../../lib/xp.js";

// Resolve the student's working grade:
//   1. If the admin (or TimeBack sync) has explicitly set it in the user's
//      Redis profile, use that.
//   2. Otherwise infer from the email local-part (guessGradeFromEmail).
//   3. Default to "K" if neither yields anything.
async function resolveWorkingGrade(email) {
  const r = redis();
  if (r) {
    try {
      const raw = await r.hget("users", String(email).toLowerCase());
      if (raw) {
        const prof = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (prof && prof.grade) return normalizeGrade(prof.grade);
      }
    } catch {
      /* Redis hiccup — fall through to heuristic */
    }
  }
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

  const grade = await resolveWorkingGrade(session.email);

  res.statusCode = 200;
  res.end(
    JSON.stringify({
      authenticated: true,
      email: session.email,
      name: session.name,
      picture: session.picture || null,
      isAdmin: isAdmin(session.email),
      grade,
    })
  );
}
