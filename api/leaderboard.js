// Returns the top readers (by unique books read) for the requested window
// (all-time or this ISO week). Privacy: only the masked display name
// (first + last initial) and grade are exposed — never raw emails.

import { verifySession, parseCookies } from "../lib/session.js";
import { getLeaderboard } from "../lib/store.js";
import { normalizeGrade } from "../lib/xp.js";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthenticated" }));
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const windowParam =
    url.searchParams.get("window") === "week" ? "week" : "all";
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "25", 10) || 25, 1),
    100
  );
  // Optional ?grade=K|1..|12 — filters to the per-grade cohort ZSET.
  // When set, window is ignored (the per-grade index is all-time).
  // Always normalized server-side so "G3"/"g3"/"3" all map to "3".
  const rawGrade = url.searchParams.get("grade");
  const gradeParam = rawGrade ? normalizeGrade(rawGrade) : null;

  const result = await getLeaderboard({
    window: windowParam,
    limit,
    viewerEmail: session.email,
    grade: gradeParam,
  });

  res.statusCode = 200;
  return res.end(
    JSON.stringify({
      window: windowParam,
      grade: gradeParam,
      entries: result.entries,
      me: result.me,
      hasRedis: result.hasRedis,
    })
  );
}
