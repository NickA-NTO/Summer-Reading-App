// TimeBack working-grade sync (task #11 — moves us from Option B "manual
// paste" to Option A "automated cron").
//
// Pulls the persisted `alpha-summer-reading-working-grade-sync` reporting
// query and bulk-applies the working_grade_level to user profiles. Only
// students who already have a Redis profile get updated; the bulk helper
// in lib/store.js skips students who haven't signed in so we don't fill
// Redis with TimeBack-only roster data.
//
// Schedule: hit via Vercel cron at /api/admin?action=timeback-sync.
// Manual trigger: admin panel button (same endpoint, admin-session auth).

import { bulkSetWorkingGrades } from "./store.js";
import { trackError, trackEvent } from "./observability.js";

// Persisted reporting endpoint — created via MCP persistQueryToAPI.
// Returns one row per enrolled Reading student across every domain.
// The downstream bulk-apply filters to students with a profile.
const TIMEBACK_REPORTING_URL =
  process.env.TIMEBACK_REPORTING_URL ||
  "https://api.alpha-1edtech.ai/reporting/saved-queries/971e9db1-70ad-493c-b41f-f23c75acf022";

/** Convert TimeBack's numeric `working_grade_level` to our string grade. */
function levelToGrade(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v <= -1) return "PK";
  if (v === 0) return "K";
  if (v >= 1 && v <= 12) return String(v);
  // Above-12 ("13" in the dataset) caps at "12" for our purposes — the
  // catalog tops out at Grade 3 today anyway.
  return "12";
}

/**
 * Fetch the persisted snapshot and bulk-apply working grades.
 * Returns:
 *   { ok, fetched, applied, skippedAdmin, skippedSame, skippedNotUser, errors }
 */
export async function syncWorkingGradesFromTimeBack(opts = {}) {
  const token = process.env.TIMEBACK_REPORTING_TOKEN;
  if (!token) {
    return { ok: false, reason: "no_token",
      message: "TIMEBACK_REPORTING_TOKEN env var is not set on Vercel." };
  }
  let rows;
  try {
    const r = await fetch(TIMEBACK_REPORTING_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      await trackError("timeback_sync_http_error", new Error(`HTTP ${r.status}`), {
        status: r.status, body: body.slice(0, 200),
      });
      return { ok: false, reason: "http_error", status: r.status,
        message: body.slice(0, 300) };
    }
    const payload = await r.json();
    // Persisted endpoints return { data: [...rows] } per the MCP shape.
    rows = Array.isArray(payload?.data) ? payload.data
         : Array.isArray(payload)        ? payload
         : [];
  } catch (err) {
    await trackError("timeback_sync_fetch_failed", err);
    return { ok: false, reason: "fetch_failed",
      error: String(err?.message || err) };
  }

  // Translate TimeBack rows → bulkSetWorkingGrades shape.
  const updates = [];
  for (const row of rows) {
    const email = String(row.email || "").trim().toLowerCase();
    const grade = levelToGrade(row.working_grade_level);
    if (!email || !grade) continue;
    updates.push({ email, grade });
  }

  const result = await bulkSetWorkingGrades(updates, { force: !!opts.force });
  await trackEvent("timeback_sync_completed", {
    fetched: rows.length,
    applied: result.applied || 0,
    skippedAdmin: result.skippedAdmin || 0,
    skippedNotUser: result.skippedNotUser || 0,
  });
  return {
    ok: true,
    fetched: rows.length,
    ...result,
  };
}

export const TIMEBACK_SYNC_ENDPOINT = TIMEBACK_REPORTING_URL;
