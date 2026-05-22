// Admin: set a student's working grade. Persists to the user's Redis
// profile so /api/auth/me reflects the change on their next page load.
//
// POST { email, grade }   where grade is one of: "PK", "K", "1"..."12"

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import { setUserWorkingGrade } from "../../lib/store.js";
import { normalizeGrade } from "../../lib/xp.js";

const ALLOWED_GRADES = new Set([
  "PK",
  "K",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
]);

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "method_not_allowed" }));
  }

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

  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_json" }));
  }

  const email = String(body.email || "").trim().toLowerCase();
  // Accept PK explicitly (TimeBack uses WG=-1 for PK); store as "PK" string.
  // K-12 normalize via xp.js (K, 1-12).
  let grade = String(body.grade || "").trim().toUpperCase();
  if (grade === "PK" || grade === "-1") {
    grade = "PK";
  } else {
    grade = normalizeGrade(grade);
  }

  if (!email || !ALLOWED_GRADES.has(grade)) {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({ error: "invalid_request", allowed: [...ALLOWED_GRADES] })
    );
  }

  const result = await setUserWorkingGrade(email, grade);
  if (!result.ok) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: result.reason || "save_failed" }));
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, email, grade }));
}
