// Live TTS blob QC probe. Read-only: HEAD/GET against the public blob CDN.
// Verifies (1) fixed-question clips exist in all 4 voices and are valid MP3s,
// (2) "Orange." clip-length regression, (3) full nova-voice coverage of every
// quiz question + option string a student can tap.
import { readFileSync, readdirSync } from "node:fs";
import { head } from "@vercel/blob";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split(/\r?\n/).filter(l => l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; })
);
process.env.BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN;

const VOICES = ["nova", "shimmer", "ash", "fable"];
async function cacheKey(voice, text) {
  const enc = new TextEncoder().encode(`v6|${voice}|${text}`);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function blobUrl(voice, text) {
  try { const m = await head(`tts/${await cacheKey(voice, text)}.mp3`); return m?.url || null; }
  catch { return null; }
}

// Parse first MPEG frame header for bitrate → duration estimate.
const BITRATES = { 1: 32, 2: 40, 3: 48, 4: 56, 5: 64, 6: 80, 7: 96, 8: 112, 9: 128, 10: 160, 11: 192, 12: 224, 13: 256, 14: 320 };
function mp3Info(buf) {
  let off = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }
  while (off < buf.length - 4 && !(buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0)) off++;
  if (off >= buf.length - 4) return { valid: false };
  const brIdx = (buf[off + 2] >> 4) & 0x0f;
  const kbps = BITRATES[brIdx] || null;
  const durSec = kbps ? ((buf.length - off) * 8) / (kbps * 1000) : null;
  return { valid: true, kbps, durSec: durSec ? +durSec.toFixed(2) : null };
}
async function fetchClip(url) {
  const r = await fetch(url);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { httpStatus: r.status, bytes: buf.length, contentType: r.headers.get("content-type"), ...mp3Info(buf) };
}

// ---- 1. Fixed questions, all 4 voices ----
const FIXED = [
  "What does Baby Bear say when he finds Goldilocks in his bed?",
  "Is the ice cream all gone by the time he decides to share?",
];
// pull actual e05 fixed text from the bank to avoid guessing
const e05 = JSON.parse(readFileSync("docs/book-questions/e05.json", "utf8"));
const e05fixed = e05.questions.map(q => q.q).find(t => /decides to share/i.test(t));
if (e05fixed) FIXED[1] = e05fixed;

console.log("== Fixed-question clips ==");
for (const text of FIXED) {
  for (const v of VOICES) {
    const url = await blobUrl(v, text);
    if (!url) { console.log(`MISSING  ${v}  "${text}"`); continue; }
    const c = await fetchClip(url);
    console.log(`${c.httpStatus === 200 && c.valid ? "OK " : "BAD"}  ${v}  ${c.bytes}B  ~${c.durSec}s  ${c.contentType}  "${text.slice(0, 50)}..."`);
  }
}

// ---- 2. Orange regression ----
console.log("\n== 'Orange.' clip-length regression ==");
for (const v of VOICES) {
  const url = await blobUrl(v, "Orange.");
  if (!url) { console.log(`MISSING  ${v}`); continue; }
  const c = await fetchClip(url);
  console.log(`${c.durSec >= 1.0 ? "OK " : "SHORT"}  ${v}  ~${c.durSec}s  ${c.bytes}B`);
}

// ---- 3. Full nova coverage of every student-tappable quiz string ----
console.log("\n== Nova coverage sweep (all banks: question + options) ==");
const texts = new Set();
for (const f of readdirSync("docs/book-questions").filter(f => f.endsWith(".json"))) {
  const bank = JSON.parse(readFileSync(`docs/book-questions/${f}`, "utf8"));
  for (const q of bank.questions) {
    texts.add(q.q);
    for (const o of q.options) texts.add(o + ".");
  }
}
const all = [...texts];
console.log(`strings to check: ${all.length}`);
const missing = [];
let done = 0;
const CONC = 25;
async function worker() {
  while (all.length) {
    const t = all.pop();
    const url = await blobUrl("nova", t);
    if (!url) missing.push(t);
    if (++done % 500 === 0) console.log(`  ...${done} checked, ${missing.length} missing`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`checked ${done}; MISSING nova clips: ${missing.length}`);
for (const m of missing.slice(0, 40)) console.log(`  MISSING: "${m}"`);

// ---- 4. Random validity sample: 12 random strings × random voice, full GET ----
console.log("\n== Random clip validity sample ==");
const sample = [...texts].sort(() => 0.5 - Math.random()).slice(0, 12);
for (const t of sample) {
  const v = VOICES[Math.floor(Math.random() * 4)];
  const url = await blobUrl(v, t);
  if (!url) { console.log(`MISSING  ${v}  "${t.slice(0, 40)}"`); continue; }
  const c = await fetchClip(url);
  const perChar = c.durSec && t.length ? (c.durSec / t.length) : 0;
  const flag = c.httpStatus === 200 && c.valid && c.durSec > 0.5 ? "OK " : "BAD";
  console.log(`${flag}  ${v}  ~${c.durSec}s (${t.length} chars, ${perChar.toFixed(3)}s/ch)  "${t.slice(0, 45)}"`);
}
