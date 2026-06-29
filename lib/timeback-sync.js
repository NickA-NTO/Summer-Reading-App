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

import { bulkSetWorkingGrades, redis } from "./store.js";
import { trackError, trackEvent } from "./observability.js";

// Persisted reporting endpoint — created via MCP persistQueryToAPI.
// Returns one row per enrolled Reading student across every domain.
// The downstream bulk-apply filters to students with a profile.
const TIMEBACK_REPORTING_URL =
  process.env.TIMEBACK_REPORTING_URL ||
  "https://api.alpha-1edtech.ai/reporting/saved-queries/971e9db1-70ad-493c-b41f-f23c75acf022";

// Cognito OAuth — public client (no client_secret). Auth flow: user
// runs `claude /mcp` locally → authorizes via Google SSO → Claude Code
// CLI saves the long-lived refresh_token to ~/.claude/.credentials.json.
// User pastes the refresh_token into Vercel as TIMEBACK_REFRESH_TOKEN.
// This function mints a fresh access_token on demand and caches it in
// Redis until shortly before expiry (typically 1h TTL on Cognito).
const COGNITO_TOKEN_URL =
  "https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/token";
const COGNITO_CLIENT_ID = "6dco4pjbnhkcgi3voivt2k972p";
const ACCESS_TOKEN_REDIS_KEY = "timeback:access_token";

/**
 * Get a valid TimeBack access token — cached in Redis until ~60s before
 * expiry. Mints a new one via the Cognito refresh_token grant when the
 * cache is empty / stale. Returns the bearer string.
 */
async function getAccessToken() {
  const r = redis();
  if (r) {
    try {
      const cached = await r.get(ACCESS_TOKEN_REDIS_KEY);
      if (cached) return cached;
    } catch {}
  }
  const refresh = process.env.TIMEBACK_REFRESH_TOKEN;
  if (!refresh) {
    throw new Error("TIMEBACK_REFRESH_TOKEN env var is not set on Vercel.");
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: COGNITO_CLIENT_ID,
    refresh_token: refresh,
  });
  const resp = await fetch(COGNITO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Cognito refresh failed: ${resp.status} ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  const accessToken = String(json.access_token || "");
  if (!accessToken) {
    throw new Error("Cognito returned no access_token");
  }
  // Cache for (expires_in - 60s) so we never serve a stale token. Default
  // to 55 min if expires_in is missing (Cognito default is 1h).
  const ttl = Math.max(60, Number(json.expires_in || 3600) - 60);
  if (r) {
    try { await r.set(ACCESS_TOKEN_REDIS_KEY, accessToken, { ex: ttl }); } catch {}
  }
  return accessToken;
}

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
  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    await trackError("timeback_auth_failed", err);
    const msg = String(err?.message || err);
    return {
      ok: false,
      reason: msg.includes("env var") ? "no_token" : "auth_failed",
      message: msg,
    };
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

  // Translate TimeBack rows → bulkSetWorkingGrades shape. Pass through
  // age_grade_level too so api/quiz.js can calibrate question maturity
  // (task #30 — difficulty by working grade, maturity by age grade).
  const updates = [];
  for (const row of rows) {
    const email = String(row.email || "").trim().toLowerCase();
    const grade = levelToGrade(row.working_grade_level);
    if (!email || !grade) continue;
    const ageGrade = levelToGrade(row.age_grade_level);
    // student_id IS the OneRoster sourcedId — backfill it onto the profile so
    // already-signed-in students get Caliper-attributable identity without
    // needing to re-login via SSO. Emit sites read profile.onerosterUserId.
    const onerosterUserId = String(row.student_id || "").trim() || null;
    updates.push({ email, grade, ageGrade, onerosterUserId });
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
