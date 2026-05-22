// Admin: list pending quiz reports + act on them.
//   GET                       → list pending reports
//   POST { id, action }       → action = "confirm" | "dismiss"
//      confirm: drops the report and busts the v5 cache for this book
//               (all grade variants), so the next request regenerates a
//               fresh pool via Opus + QC.
//      dismiss: drops the report without changing anything.

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import {
  listQuizReports,
  deleteQuizReport,
  bustQuizCache,
  redis,
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
    const { reports, hasRedis, error } = await listQuizReports({ limit: 200 });
    res.statusCode = 200;
    return res.end(
      JSON.stringify({ hasRedis, error: error || null, reports })
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
    const id = String(body.id || "");
    const action = String(body.action || "").toLowerCase();

    if (!id || !["confirm", "dismiss"].includes(action)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid_request" }));
    }

    // For "confirm": look up the report first so we know which book to bust
    let bookIdToBust = null;
    if (action === "confirm") {
      const r = redis();
      if (r) {
        try {
          const raw = await r.hget("quiz:reports:pending", id);
          if (raw) {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            bookIdToBust = parsed?.bookId || null;
          }
        } catch {}
      }
    }

    const del = await deleteQuizReport(id);
    if (!del.ok) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: del.reason || "delete_failed" }));
    }

    let bustedKeys = 0;
    if (action === "confirm" && bookIdToBust) {
      bustedKeys = await bustQuizCache(bookIdToBust);
    }

    res.statusCode = 200;
    return res.end(
      JSON.stringify({ ok: true, action, bookIdToBust, bustedKeys })
    );
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}
