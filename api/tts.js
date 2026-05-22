// Text-to-speech endpoint. Layered cost protection:
//   1. Redis-cached URL → return immediately, zero AWS call.
//   2. Blob existence check → if file exists for this hash, reuse, zero AWS.
//   3. Usage cap check → refuse with 429 if we're at the app-level budget.
//   4. Otherwise: synthesize with Polly Neural, upload to Blob, cache URL.
//
// The endpoint always returns JSON `{url, voice, cached, usage}`. The client
// then uses an <audio src=url> element to play the MP3 directly from Blob's
// CDN (no proxying through our server, no double-bandwidth cost).

import { verifySession, parseCookies } from "../lib/session.js";
import {
  getCachedTtsUrl,
  setCachedTtsUrl,
  addTtsUsage,
  getTtsUsage,
} from "../lib/store.js";
import {
  synthAndStore,
  checkBlobExists,
  cacheKey,
  VOICES,
  DEFAULT_VOICE,
  APP_CAP_CHARS,
  APP_CAP_USD,
  COST_PER_CHAR,
  hasPolly,
} from "../lib/tts.js";

// Hard caps on user input — defense in depth against a buggy/malicious
// client trying to drain the budget in one call.
const MAX_TEXT_LEN = 1000; // chars per single TTS request

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

  if (!hasPolly()) {
    res.statusCode = 503;
    return res.end(
      JSON.stringify({
        error: "tts_not_configured",
        message: "AWS Polly credentials are not set.",
      })
    );
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const text = (url.searchParams.get("text") || "").trim();
  let voice = url.searchParams.get("voice") || DEFAULT_VOICE;
  if (!VOICES[voice]) voice = DEFAULT_VOICE;

  if (!text) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "missing_text" }));
  }
  if (text.length > MAX_TEXT_LEN) {
    res.statusCode = 413;
    return res.end(
      JSON.stringify({
        error: "text_too_long",
        max: MAX_TEXT_LEN,
        got: text.length,
      })
    );
  }

  const key = await cacheKey(voice, text);

  // 1. Hot path: Redis-cached URL
  const cachedUrl = await getCachedTtsUrl(key);
  if (cachedUrl) {
    res.statusCode = 200;
    return res.end(
      JSON.stringify({ url: cachedUrl, voice, cached: "redis" })
    );
  }

  // 2. Slightly colder path: Blob exists but Redis index lost it
  const blobUrl = await checkBlobExists(voice, text);
  if (blobUrl) {
    await setCachedTtsUrl(key, blobUrl);
    res.statusCode = 200;
    return res.end(JSON.stringify({ url: blobUrl, voice, cached: "blob" }));
  }

  // 3. App-level budget check — refuse before calling AWS if over cap
  const { chars: currentChars } = await getTtsUsage();
  if (currentChars + text.length > APP_CAP_CHARS) {
    res.statusCode = 429;
    return res.end(
      JSON.stringify({
        error: "tts_budget_reached",
        message:
          "TTS budget cap hit. The site will fall back to the browser's built-in voice until the cap resets.",
        usage: {
          chars: currentChars,
          dollars: +(currentChars * COST_PER_CHAR).toFixed(4),
          capChars: APP_CAP_CHARS,
          capDollars: APP_CAP_USD,
        },
      })
    );
  }

  // 4. Synthesize, store in Blob, cache URL in Redis, record usage
  try {
    const { url: storedUrl, chars } = await synthAndStore(text, voice);
    await setCachedTtsUrl(key, storedUrl);
    const newTotal = await addTtsUsage(chars);
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        url: storedUrl,
        voice,
        cached: false,
        usage: {
          chars: newTotal,
          dollars: +(newTotal * COST_PER_CHAR).toFixed(4),
          capChars: APP_CAP_CHARS,
          capDollars: APP_CAP_USD,
        },
      })
    );
  } catch (err) {
    console.error("tts_synth_failed", err);
    const msg = String(err?.message || err);
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: "tts_synth_failed",
        message:
          msg.includes("vercel_blob_not_configured")
            ? "Vercel Blob isn't enabled yet. Install it from the Vercel project's Storage tab."
            : msg.includes("AccessDenied") || msg.includes("not authorized")
              ? "AWS budget hard-stop has fired (or the IAM user lost Polly access). Browser TTS will be used until the budget resets."
              : msg,
      })
    );
  }
}
