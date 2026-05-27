// Shared text moderation — used both server-side (api/quiz.js, to filter
// AI-generated quiz questions before they're cached and served) and
// mirrors the client-side logic in index.html (postComment guardrail).
//
// Phase 1 is deterministic: profanity block list + PII regex + length.
// Phase 2 (separate task) will layer an LLM safety pass for nuance —
// sarcasm, age-inappropriate themes, etc. The deterministic check
// stays as the fast first filter so we don't spend Claude tokens on
// obvious junk.
//
// The blocked-word list is base64 encoded so slurs don't appear in
// plaintext in source / `git grep`. Decoded once at module load.
// To expand: decode in Node (`Buffer.from(b64,'base64').toString()`),
// append words, re-encode, replace.
const BLOCKED_B64 =
  "ZnVjayxmdWssZmNrLGZrLGZ1cSxzaGl0LHNodCxhc3Nob2xlLGJpdGNoLGJ0Y2gsZGFtbixiYXN0YXJkLGRpY2sscHVzc3ksY29jayxwb3JuLHBybixzZXgsbmFrZWQsYm9vYnMsa2lsbCB5b3Vyc2VsZixreXMsc3VpY2lkZSxyZXRhcmQ=";

// Cross-runtime base64 decode (Node has Buffer; the browser has atob).
function _b64decode(s) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
  if (typeof atob === "function") return atob(s);
  return "";
}
const BLOCKED = new Set(
  _b64decode(BLOCKED_B64)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
// Pre-compute compact forms of every blocked word once.
const BLOCKED_COMPACT = new Set(
  Array.from(BLOCKED)
    .map((w) => w.replace(/\s+/g, "").replace(/(.)\1+/g, "$1"))
    .filter((w) => w.length >= 3)
);

function _baseNormalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
function _leetA(s) {
  return s
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[+]/g, "t");
}
function _leetB(s) {
  return s
    .replace(/1/g, "l")
    .replace(/!/g, "i")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[+]/g, "t");
}
function _stripNonLetters(s) {
  return s.replace(/[^a-z\s]/g, "");
}
function _toCompact(s) {
  return s
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b((?:[a-z]\s+){2,}[a-z])\b/g, (m) => m.replace(/\s+/g, ""))
    .replace(/(.)\1+/g, "$1");
}
function _buildNormalForm(base, substituter) {
  return _stripNonLetters(substituter(base))
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}
function _candidateForms(text) {
  const base = _baseNormalize(text);
  return [
    _toCompact(_leetA(base)),
    _toCompact(_leetB(base)),
    _toCompact(_stripNonLetters(base)),
  ];
}

export function containsProfanity(text) {
  const base = _baseNormalize(text);
  const forms = [
    _buildNormalForm(base, _leetA),
    _buildNormalForm(base, _leetB),
    _buildNormalForm(base, (s) => s),
  ];
  for (const form of forms) {
    for (const w of form.split(/\s+/)) if (BLOCKED.has(w)) return true;
    for (const blocked of BLOCKED) {
      if (blocked.includes(" ") && form.includes(blocked)) return true;
    }
  }
  const compacts = _candidateForms(text);
  for (const blocked of BLOCKED_COMPACT) {
    for (const c of compacts) {
      if (c.includes(blocked)) return true;
    }
  }
  return false;
}

const PHONE_RE = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const URL_RE   = /\b(?:https?:\/\/|www\.)\S+/i;
export function containsPII(text) {
  const t = String(text || "");
  return PHONE_RE.test(t) || EMAIL_RE.test(t) || URL_RE.test(t);
}

/**
 * Moderate a single string. Returns { ok, reason, message? } where ok=true
 * means clean, ok=false means blocked with a reason in
 * { "profanity", "pii", "too_short", "too_long" }. Used for student
 * comments client-side; api/quiz.js calls containsProfanity / containsPII
 * directly to filter generated questions.
 */
export function moderateText(text, opts = {}) {
  const minLen = opts.minLen ?? 3;
  const maxLen = opts.maxLen ?? 200;
  const trimmed = String(text || "").trim();
  if (trimmed.length < minLen) {
    return { ok: false, reason: "too_short" };
  }
  if (trimmed.length > maxLen) {
    return { ok: false, reason: "too_long" };
  }
  if (containsProfanity(trimmed)) {
    return { ok: false, reason: "profanity" };
  }
  if (containsPII(trimmed)) {
    return { ok: false, reason: "pii" };
  }
  return { ok: true };
}

/**
 * Filter a quiz question pool, dropping any where the question text or
 * any option text trips the deterministic moderation. Returns
 * { kept, dropped } so the caller can log + decide whether to regen.
 *
 * Bounds the false-positive risk on innocent school book content by:
 *   - Skipping length checks (questions are short by design; options
 *     can legitimately be 1-2 words)
 *   - Only running containsProfanity + containsPII
 *
 * Used by api/quiz.js after the QC reviewer pass.
 */
export function moderateQuizQuestions(questions) {
  const kept = [];
  const dropped = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const fields = [q.q, ...(Array.isArray(q.options) ? q.options : [])];
    let fail = null;
    for (const f of fields) {
      if (containsProfanity(f)) { fail = "profanity"; break; }
      if (containsPII(f))       { fail = "pii"; break; }
    }
    if (fail) dropped.push({ idx: i, reason: fail, question: q.q });
    else kept.push(q);
  }
  return { kept, dropped };
}
