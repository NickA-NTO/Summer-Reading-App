// Public health endpoint — no auth, JSON status of every external
// dependency. Designed for synthetic monitors (UptimeRobot, Better Stack,
// Pingdom, etc.) to hit on a cron and alert on non-200. Cheap: one
// Redis PING + four env-var checks.
//
// Returns:
//   200 ok          — every required dependency answered
//   503 degraded    — auth or Redis is broken (the app cannot function)
//   206 partial     — non-critical deps missing (Polly off, TimeBack off);
//                     app still serves traffic with degraded features
//
// Response shape (stable — synthetic monitors parse this):
//   {
//     ok: bool,
//     status: "healthy" | "degraded" | "partial",
//     timestamp: ISO string,
//     latencyMs: number,
//     checks: { redis, anthropic, polly, auth, allowedDomains },
//     schemaVersions: { quiz },
//     build: { commit, region }
//   }
//
// The middleware skips /api/* paths, so this endpoint is reachable
// without a session cookie — synthetic monitors don't have one.

import { redis } from "../lib/store.js";

export default async function handler(req, res) {
  const start = Date.now();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  // CORS-open so dashboards on other origins can poll us.
  res.setHeader("Access-Control-Allow-Origin", "*");

  const checks = {};

  // Redis — the leaderboard, fraud state, profile, quiz cache, and held-XP
  // queue all live here. Without it the app is read-only-ish.
  try {
    const r = redis();
    if (!r) {
      checks.redis = { ok: false, reason: "not_configured" };
    } else {
      const pStart = Date.now();
      // Upstash REST client doesn't expose ping; do a cheap read instead.
      await r.get("__health_probe__").catch(() => null);
      checks.redis = { ok: true, latencyMs: Date.now() - pStart };
    }
  } catch (e) {
    checks.redis = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  // Anthropic — required for quiz generation cold path. Cache hits work
  // without it, but a fresh book + grade combo would fail.
  checks.anthropic = { ok: !!process.env.ANTHROPIC_API_KEY };

  // OpenAI TTS (#32 — was Polly). Optional; falls back to browser SpeechSynthesis.
  // Hash field name kept as `polly` for backcompat with synthetic monitors
  // that have already been configured to parse this key. Add an alias.
  checks.polly = { ok: !!process.env.OPENAI_API_KEY };
  checks.tts   = { ok: !!process.env.OPENAI_API_KEY };

  // Auth — without these the app cannot serve a single page.
  checks.auth = {
    ok:
      !!process.env.AUTH_SECRET &&
      !!process.env.GOOGLE_CLIENT_ID &&
      !!process.env.GOOGLE_CLIENT_SECRET,
  };

  // ALLOWED_DOMAIN parsed list (so a synthetic monitor catches "the
  // env var got wiped" before a real user does).
  checks.allowedDomains = {
    count: (process.env.ALLOWED_DOMAIN || "")
      .split(",").map((s) => s.trim()).filter(Boolean).length,
  };

  // Roll-up. Auth + Redis are hard requirements; missing Polly only
  // degrades TTS quality (browser fallback exists).
  const hardOK = checks.auth.ok && checks.redis.ok;
  const softOK = checks.anthropic.ok && checks.polly.ok;
  const status = !hardOK ? "degraded" : !softOK ? "partial" : "healthy";

  // Commit SHA is gated behind HEALTH_TOKEN — synthetic monitors set
  // the bearer to detect partial deploys; drive-by attackers see only
  // ok/status/region. (Agent 8 recon: public commit SHA + open repo =
  // every internal threshold + security comment becomes readable.)
  // Schema versions + region stay public — useful for ops, no leak.
  const wantCommit =
    !!process.env.HEALTH_TOKEN &&
    String(req.headers.authorization || "") === `Bearer ${process.env.HEALTH_TOKEN}`;

  res.statusCode = !hardOK ? 503 : !softOK ? 206 : 200;
  res.end(
    JSON.stringify({
      ok: hardOK,
      status,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - start,
      checks,
      schemaVersions: { quiz: 11 },
      build: {
        commit: wantCommit ? (process.env.VERCEL_GIT_COMMIT_SHA || null) : null,
        region: process.env.VERCEL_REGION || null,
      },
    })
  );
}
