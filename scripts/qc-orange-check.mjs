// Precise duration (VBR-safe frame walk) + Whisper transcription for the
// previously-clipped "Orange." clips, all 4 voices.
import { readFileSync } from "node:fs";
import { head } from "@vercel/blob";
import OpenAI from "openai";

const envOf = (f) => Object.fromEntries(
  readFileSync(f, "utf8").split(/\r?\n/).filter(l => l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; })
);
const local = envOf(".env.local"), repair = envOf(".env.repair");
process.env.BLOB_READ_WRITE_TOKEN = local.BLOB_READ_WRITE_TOKEN;
const openai = new OpenAI({ apiKey: repair.OPENAI_API_KEY });

async function cacheKey(voice, text) {
  const enc = new TextEncoder().encode(`v6|${voice}|${text}`);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3Duration(buf) {
  let off = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    off = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  let frames = 0, seconds = 0;
  while (off < buf.length - 4) {
    if (!(buf[off] === 0xff && (buf[off + 1] & 0xe0) === 0xe0)) { off++; continue; }
    const verBits = (buf[off + 1] >> 3) & 3;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (buf[off + 1] >> 1) & 3;    // 1 = Layer III
    if (layerBits !== 1 || !(verBits in RATES)) { off++; continue; }
    const brIdx = (buf[off + 2] >> 4) & 0x0f;
    const srIdx = (buf[off + 2] >> 2) & 0x03;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { off++; continue; }
    const kbps = (verBits === 3 ? BITRATES_V1L3 : BITRATES_V2L3)[brIdx];
    const rate = RATES[verBits][srIdx];
    const pad = (buf[off + 2] >> 1) & 1;
    const samplesPerFrame = verBits === 3 ? 1152 : 576;
    const frameLen = Math.floor((samplesPerFrame / 8) * (kbps * 1000) / rate) + pad;
    if (frameLen < 4) { off++; continue; }
    frames++; seconds += samplesPerFrame / rate; off += frameLen;
  }
  return { frames, seconds: +seconds.toFixed(2) };
}

for (const v of ["nova", "shimmer", "ash", "fable"]) {
  const meta = await head(`tts/${await cacheKey(v, "Orange.")}.mp3`).catch(() => null);
  if (!meta?.url) { console.log(`${v}: MISSING`); continue; }
  const r = await fetch(meta.url);
  const buf = new Uint8Array(await r.arrayBuffer());
  const d = mp3Duration(buf);
  const file = new File([buf], "orange.mp3", { type: "audio/mpeg" });
  let heard = "?";
  try {
    const tr = await openai.audio.transcriptions.create({ model: "whisper-1", file });
    heard = tr.text;
  } catch (e) { heard = "whisper_error: " + e.message; }
  console.log(`${v}: ${buf.length}B, ${d.seconds}s (${d.frames} frames), whisper heard: "${heard}"`);
}
