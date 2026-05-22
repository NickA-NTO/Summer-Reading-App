// Admin-only: shows current TTS usage (chars synthesized + dollars spent
// + percent of cap). Used by the admin modal in the UI.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import { getTtsUsage } from "../../lib/store.js";
import { APP_CAP_CHARS, APP_CAP_USD, COST_PER_CHAR, hasPolly } from "../../lib/tts.js";

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

  const { chars, hasRedis } = await getTtsUsage();
  res.statusCode = 200;
  return res.end(
    JSON.stringify({
      hasRedis,
      pollyConfigured: hasPolly(),
      chars,
      dollars: +(chars * COST_PER_CHAR).toFixed(4),
      capChars: APP_CAP_CHARS,
      capDollars: APP_CAP_USD,
      percentUsed: +(((chars / APP_CAP_CHARS) * 100) || 0).toFixed(1),
    })
  );
}
