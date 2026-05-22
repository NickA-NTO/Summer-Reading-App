// AWS Polly TTS with two-layer budget protection:
//   1. App-level cap (this file): hard 281,250-char ceiling ≈ $4.50 of usage
//      at Polly Neural pricing. Refuses new synth above the cap, falls back
//      to browser TTS on the client.
//   2. AWS-level budget action (configured in the AWS console): attaches
//      AWSDenyAll to the IAM user when $5 of Polly spend is reached.
//
// Audio is cached in Vercel Blob keyed by sha256(voice + text). Each unique
// (text, voice) pair costs one Polly synth ever; subsequent requests get
// the CDN-cached MP3 URL for free.

import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { put, head } from "@vercel/blob";

// Polly Neural pricing: $16 per 1,000,000 chars = $0.000016 per char.
// We cap the APP at $4.50 worth = 281,250 chars. The AWS Budget Action
// kicks in at $5.00 ≈ 312,500 chars as a hard safety net.
export const COST_PER_CHAR = 16 / 1_000_000; // USD
export const APP_CAP_CHARS = Number(process.env.TTS_CAP_CHARS) || 281_250;
export const APP_CAP_USD = APP_CAP_CHARS * COST_PER_CHAR;

// Polly neural voices we expose. All 4 support the neural engine — Justin
// was removed because it's standard-engine only and was silently failing
// the synth call.
//   Female Child → Ivy
//   Male Child   → Kevin
//   Female Adult → Joanna
//   Male Adult   → Matthew
export const VOICES = {
  Ivy:     { gender: "female", age: "child", label: "Female Child" },
  Kevin:   { gender: "male",   age: "child", label: "Male Child" },
  Joanna:  { gender: "female", age: "adult", label: "Female Adult" },
  Matthew: { gender: "male",   age: "adult", label: "Male Adult" },
};
export const DEFAULT_VOICE = "Ivy";

let _polly = null;
function pollyClient() {
  if (_polly) return _polly;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  _polly = new PollyClient({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
  });
  return _polly;
}

export function hasPolly() {
  return !!pollyClient();
}

// SHA-256 of "v2|" + voice + "|" + text → stable cache key. The "v2" prefix
// is a schema version so we can invalidate the cache if we change voices,
// engine, sample rate, or anything else that changes the audio output for
// the same input.
const CACHE_PREFIX = "v2";
export async function cacheKey(voice, text) {
  const enc = new TextEncoder().encode(`${CACHE_PREFIX}|${voice}|${text}`);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Convert Polly's response stream to a Buffer (Node) or Uint8Array.
async function streamToBytes(stream) {
  if (!stream) return new Uint8Array();
  const chunks = [];
  // SDK v3 returns a Node Readable in Node and a Web ReadableStream elsewhere
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } else {
    for await (const chunk of stream) chunks.push(chunk);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c), off);
    off += c.length;
  }
  return out;
}

// Synthesizes `text` with `voice`, uploads MP3 to Vercel Blob at the
// deterministic cache key, and returns { url, chars, cached }.
// Throws if Polly or Blob isn't configured.
export async function synthAndStore(text, voice) {
  const polly = pollyClient();
  if (!polly) throw new Error("aws_polly_not_configured");
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("vercel_blob_not_configured");
  }
  if (!VOICES[voice]) voice = DEFAULT_VOICE;

  const cmd = new SynthesizeSpeechCommand({
    Text: text,
    OutputFormat: "mp3",
    VoiceId: voice,
    Engine: "neural",
    SampleRate: "24000",
    TextType: "text",
  });
  const resp = await polly.send(cmd);
  const audio = await streamToBytes(resp.AudioStream);

  const key = await cacheKey(voice, text);
  const blob = await put(`tts/${key}.mp3`, audio, {
    access: "public",
    contentType: "audio/mpeg",
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return { url: blob.url, chars: text.length, cached: false };
}

// Cheap existence check against Blob (avoids hitting Polly if a prior
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
