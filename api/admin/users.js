// Admin-only: returns every user who has logged in, with last-active
// timestamps and books-read counts. Gated by the ADMIN_EMAILS env var.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import { listAllUsers } from "../../lib/store.js";

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
  if (!isAdmin(session.email)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: "forbidden" }));
  }

  const { users, hasRedis, error } = await listAllUsers();
  res.statusCode = 200;
  return res.end(
    JSON.stringify({
      hasRedis,
      error: error || null,
      count: users.length,
      users,
    })
  );
}
