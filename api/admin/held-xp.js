// Admin: list and resolve held-XP entries (1d.3 fraud detection).
//
//   GET                       → list pending held-XP entries
//   POST { id, action }       → action = "approve" | "reject" | "reset_flags"
//      approve: awards the withheld points to the student and deletes the entry.
//      reject:  discards the entry without awarding points.
//      reset_flags: clears the student's fraud flag count + cooldown (no entry needed).

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import {
  listHeldXp,
  resolveHeldXp,
  resetFraudFlags,
} from "../../lib/store.js";

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

  if (req.method === "GET") {
    const { entries, hasRedis, error } = await listHeldXp({ limit: 200 });
    res.statusCode = 200;
    return res.end(
      JSON.stringify({ hasRedis, error: error || null, entries })
    );
  }

  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid_json" }));
    }

    const action = String(body.action || "").toLowerCase();

    // Reset flags: clear fraud count + cooldown for a student.
    if (action === "reset_flags") {
      const email = String(body.email || "").toLowerCase();
      if (!email) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "email_required" }));
      }
      const result = await resetFraudFlags(email);
      res.statusCode = result.ok ? 200 : 500;
      return res.end(
        JSON.stringify(result.ok ? { ok: true, email } : { error: result.reason })
      );
    }

    // Approve / reject a specific held entry.
    const id = String(body.id || "");
    if (!id || !["approve", "reject"].includes(action)) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error: "invalid_request",
          allowed_actions: ["approve", "reject", "reset_flags"],
        })
      );
    }

    const result = await resolveHeldXp(id, action);
    if (!result.ok) {
      res.statusCode = result.reason === "not_found" ? 404 : 500;
      return res.end(
        JSON.stringify({ error: result.reason || "resolve_failed" })
      );
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, action, entry: result.entry }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}
