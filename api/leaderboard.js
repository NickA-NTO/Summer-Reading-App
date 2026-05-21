// Returns the top readers (by unique books read) for the requested window
// (all-time or this ISO week). Privacy: only the masked display name
// (first + last initial) and grade are exposed — never raw emails.

import { verifySession, parseCookies } from "../lib/session.js";
import { getLeaderboard } from "../lib/store.js";

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

  const result = await getLeaderboard({
    window: windowParam,
    limit,
    viewerEmail: session.email,
  });

  res.statusCode = 200;
  return res.end(
    JSON.stringify({
      window: windowParam,
      entries: result.entries,
      me: result.me,
      hasRedis: result.hasRedis,
    })
  );
}
