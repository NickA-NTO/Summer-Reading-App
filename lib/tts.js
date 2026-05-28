// OpenAI TTS (#32 — migrated from AWS Polly Neural).
//
// WHY THE SWITCH:
//   - Removes the personal AWS dependency + $4.50 budget cap that gated growth.
//   - Same per-character cost as Polly Neural (~$15/1M chars for the standard
//     gpt-4o-mini-tts model) but with higher voice quality and the `instructions`
//     parameter that lets us steer tone for K-2 readers ("speak slowly and
//     warmly, like reading to a young child").
//   - Required for #9 (conversational tutor) — the tutor + question TTS share
//     this code path, so landing #32 first makes #9 ~30-40% cheaper in build time.
//
// SHAPE PRESERVED:
//   - Public exports (synthAndStore, checkBlobExists, cacheKey, VOICES,
//     DEFAULT_VOICE, APP_CAP_CHARS, APP_CAP_USD, COST_PER_CHAR, hasPolly→hasTts)
//     match the Polly version's surface so callers don't need to change.
//   - Audio is still cached in Vercel Blob keyed by sha256(voice + text).
//     Each unique (text, voice) pair costs one OpenAI synth ever; subsequent
//     requests get the CDN-cached MP3 URL for free.
//   - hasPolly is kept as a deprecated alias of hasTts to avoid a coordinated
//     rename across call sites in this commit. Future cleanup can drop it.
//
// CACHE KEY VERSION:
//   - Bumped to v3 (was v2). OpenAI voices have different IDs than Polly
//     (nova vs Ivy, etc.) and the audio output is different, so existing
//     v2/Polly-cached MP3s would never collide anyway — but the prefix bump
//     makes the new entries visually distinguishable in the Blob bucket.

import OpenAI from "openai";
import { put, head } from "@vercel/blob";

// gpt-4o-mini-tts pricing: $15 per 1,000,000 input chars = $0.000015 per char.
// (Identical to Polly Neural's $16/M — slight savings from the older Polly rate
// rounding, but we keep the cap structure for budget-safety continuity.)
export const COST_PER_CHAR = 15 / 1_000_000; // USD
export const APP_CAP_CHARS = Number(process.env.TTS_CAP_CHARS) || 1_000_000;
export const APP_CAP_USD = APP_CAP_CHARS * COST_PER_CHAR;

// OpenAI TTS voices — full catalog as of late 2024.
//
//   nova       → default. Warm, energetic female. Best all-rounder for K-8.
//   shimmer    → gentler female, softer than nova.
//   coral      → newest voice (Oct 2024). Very warm + expressive.
//   ash        → warm male, friendly. Good male alternate.
//   fable      → British accent, slightly older-sounding. "Read-aloud" feel.
//
//   We surface 4-5 in the UI rather than the full catalog (alloy/echo/onyx/
//   sage/ballad/verse exist too) because more options confuses K-2 kids.
//
// Voice IDs are case-sensitive in the OpenAI API — keep the lowercase strings.
export const VOICES = {
  nova:    { gender: "female", age: "young-adult", label: "Nova"    },
  shimmer: { gender: "female", age: "young-adult", label: "Shimmer" },
  coral:   { gender: "female", age: "young-adult", label: "Coral"   },
  ash:     { gender: "male",   age: "young-adult", label: "Ash"     },
  fable:   { gender: "male",   age: "young-adult", label: "Fable"   },
};
export const DEFAULT_VOICE = "nova";

// MODEL SELECTION:
//   tts-1            — fastest, ~400 ms p50 latency. Voice quality is good.
//                      No `instructions` support but the voice character
//                      itself (nova/shimmer/coral/ash/fable) already
//                      conveys warmth.
//   tts-1-hd         — higher fidelity, ~2x cost, ~2x latency. Overkill
//                      for kid UI chrome.
//   gpt-4o-mini-tts  — newest, supports `instructions`, ~1.5-3 s p50
//                      latency. Magic but slow.
//
// We use tts-1 for the kid-facing app because cumulative latency on
// catalog browse (tap card → wait for title to read) directly affects
// how snappy the app feels. The cache means each (text, voice) pair
// only generates once — after warm-up, every replay is a CDN fetch.
const TTS_MODEL = "tts-1";
// Per-voice speed multiplier. 1.0 = natural. <1 = slower (better for K-2).
const TTS_SPEED = 0.95;

let _openai = null;
function openaiClient() {
  if (_openai) return _openai;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _openai = new OpenAI({ apiKey });
  return _openai;
}

export function hasTts() {
  return !!openaiClient();
}
// Backcompat alias — call sites still import { hasPolly } from this module.
// Safe to drop once api/tts.js and api/health.js are updated to hasTts().
export const hasPolly = hasTts;

// SHA-256 of "v4|" + voice + "|" + text → stable cache key. The "v4" prefix
// reflects the model swap from gpt-4o-mini-tts to tts-1 (different audio
// output for the same text+voice). Bump on any output-affecting change:
// voice catalog, model, sample rate, speed, instructions.
const CACHE_PREFIX = "v4";
export async function cacheKey(voice, text) {
  const enc = new TextEncoder().encode(`${CACHE_PREFIX}|${voice}|${text}`);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Synthesizes `text` with `voice`, uploads MP3 to Vercel Blob at the
// deterministic cache key, and returns { url, chars, cached }.
// Throws if OpenAI or Blob isn't configured.
export async function synthAndStore(text, voice) {
  const oai = openaiClient();
  if (!oai) throw new Error("openai_not_configured");
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("vercel_blob_not_configured");
  }
  if (!VOICES[voice]) voice = DEFAULT_VOICE;

  // tts-1 for lowest latency. See TTS_MODEL comment for tradeoffs.
  const response = await oai.audio.speech.create({
    model: TTS_MODEL,
    voice,
    input: text,
    response_format: "mp3",
    speed: TTS_SPEED,
  });
  // The SDK returns a Web Response — convert its body to a Uint8Array.
  const arrayBuf = await response.arrayBuffer();
  const audio = new Uint8Array(arrayBuf);

  const key = await cacheKey(voice, text);
  const blob = await put(`tts/${key}.mp3`, audio, {
    access: "public",
    contentType: "audio/mpeg",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return { url: blob.url, chars: text.length, cached: false };
}

// Cheap existence check against Blob (avoids hitting OpenAI if a prior
// invocation already stored this exact text/voice combo but our Redis
// cache index lost it for some reason — defensive).
export async function checkBlobExists(voice, text) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const key = await cacheKey(voice, text);
    const meta = await head(`tts/${key}.mp3`);
    return meta?.url || null;
  } catch {
    return null;
  }
}
