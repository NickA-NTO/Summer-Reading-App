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
//
// #44 — expanded for V1 launch. Categories covered:
//   • Profanity baseline + common variants
//   • Racial / ethnic slurs (top-tier conservative list)
//   • Homophobic / transphobic slurs
//   • Ableist / mental-health slurs
//   • Explicit sexual content + body-part vocabulary used as insults
//   • Self-harm + violence prompts
//   • Drug slang
//   • Hate / extremism rhetoric
//   • K-8 bullying terms ("kill yourself", "kys", "nobody likes you")
//
// Stored as two base64 chunks (legacy + extension) decoded and merged
// into the same Set at module load. Splitting keeps the diff readable
// and makes future expansions an append-only operation.
const BLOCKED_B64_LEGACY =
  "ZnVjayxmdWssZmNrLGZrLGZ1cSxzaGl0LHNodCxhc3Nob2xlLGJpdGNoLGJ0Y2gsZGFtbixiYXN0YXJkLGRpY2sscHVzc3ksY29jayxwb3JuLHBybixzZXgsbmFrZWQsYm9vYnMsa2lsbCB5b3Vyc2VsZixreXMsc3VpY2lkZSxyZXRhcmQ=";
const BLOCKED_B64_EXTENSION =
  "ZnVja2VyLGZ1Y2tpbmcsZnVja2VkLG1vdGhlcmZ1Y2tlcixtZix3dGYsc3RmdSxidWxsc2hpdCxicyxjcmFwLGdvZGRhbW4sZ29kZGFtbWl0LGplZXosamVya29mZixqYWNrb2ZmLG5pZ2dlcixuaWdnYSxuZWdybyxuaWcsY2hpbmssZ29vayxzcGljLHdldGJhY2ssa2lrZSxiZWFuZXIscmFnaGVhZCxzYW5kbmlnZ2VyLGphcCx3b3AsZGFnbyxmYWdnb3QsZmFnZ2l0LGZhZyxkeWtlLHRyYW5ueSxob21vLHF1ZWVyLHNpc3N5LGZhaXJ5LHJldGFyZGVkLHRhcmQsc3BheixzcGFzdGljLGNyYXp5IHBlcnNvbixwc3ljaG8sc2NoaXpvLHBlbmlzLHZhZ2luYSxhbnVzLGJ1dHRob2xlLHRpdHMsdGl0dGllcyxuaXBwbGUsbmlwcGxlcyxob3JueSxtYXN0dXJiYXRlLGplcmsgb2ZmLGJsb3dqb2IsaGFuZGpvYixyYXBlLHJhcGVkLHJhcGlzdCxtb2xlc3QsbW9sZXN0ZXIscGVkbyxwZWRvcGhpbGUsaW5jZXN0LGN1dCB5b3Vyc2VsZixjdXR0aW5nIHlvdXJzZWxmLGhhbmcgeW91cnNlbGYsc2hvb3QgeW91cnNlbGYsaSB3YW50IHRvIGRpZSxpIHdhbm5hIGRpZSxub29zZSxvdmVyZG9zZSxjb2NhaW5lLGhlcm9pbixtZXRoLGNyYWNrLHdlZWQsbWFyaWp1YW5hLGJsdW50LG5hemksaGVpbCBoaXRsZXIsc2llZyBoZWlsLHdoaXRlIHBvd2VyLGtpbGwgeW91cnNlbGYsa3lzLGdvIGRpZSxub2JvZHkgbGlrZXMgeW91LHVnbHkgYml0Y2gsZmF0IGJpdGNo";

// Cross-runtime base64 decode (Node has Buffer; the browser has atob).
function _b64decode(s) {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
  if (typeof atob === "function") return atob(s);
  return "";
}
const BLOCKED = new Set(
  [BLOCKED_B64_LEGACY, BLOCKED_B64_EXTENSION]
    .map((chunk) => _b64decode(chunk))
    .join(",")
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

// #child-safety — a FOCUSED crisis list used only to CATEGORIZE an already-
// flagged input as self-harm so it can be ESCALATED (proactive alert) rather
// than merely logged. These also live in the BLOCKED set above (so
// containsProfanity already catches them); this exists only to tell self-harm
// apart from ordinary profanity. Plaintext (not slurs) for auditability.
// Single-word entries match whole words (so "kys" doesn't fire on
// "skyscraper"); multi-word entries match as normalized substrings.
const SELF_HARM_PHRASES = [
  "kill myself", "killing myself", "kill yourself", "kys",
  "want to die", "wanna die", "hurt myself", "cut myself", "cutting myself",
  "end my life", "suicide", "suicidal", "hang myself",
  "no reason to live", "better off dead", "dont want to live", "don't want to live",
];
export function containsSelfHarm(text) {
  const norm = _baseNormalize(text);
  const words = new Set(norm.split(/\s+/));
  for (const p of SELF_HARM_PHRASES) {
    if (p.includes(" ")) { if (norm.includes(p)) return true; }
    else if (words.has(p)) return true;
  }
  return false;
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
 * Three-tier classification (task #31). Returns one of:
 *   { verdict: "block",  reason, message }   ← deterministic-bad → reject
 *   { verdict: "review", reason, message }   ← borderline → held for admin
 *   { verdict: "allow" }                     ← clean → publish immediately
 *
 * Block is the same surface as moderateText (profanity, PII, length).
 * Review captures patterns that aren't obviously bad but warrant a
 * human glance:
 *   - All-caps "yelling" (≥6 chars, ≥80% uppercase letters)
 *   - 3+ exclamation marks
 *   - Long comments (>120 chars — more surface for hidden content)
 *   - Borderline-word list (separate from the hard block list)
 *
 * Callers (api/activity.js kind:"comment") forward each verdict:
 *   block  → return 400 with the friendly message
 *   review → enqueue in admin queue, return 202 with "Thanks, being checked"
 *   allow  → publish to the comments store, return 200
 */
const BORDERLINE_B64 =
  // Mild insults and tonally aggressive words. Same encoding pattern
  // as the hard list — base64 for git-grep hygiene. Expand from a
  // school-appropriate vetted source.
  "c3R1cGlkLGR1bWIsbG9zZXIsaWRpb3QsbW9yb24sd2VpcmRvLHV5bHksaGF0ZSx0cmFzaCxzdWNrcw==";
const BORDERLINE = new Set(
  _b64decode(BORDERLINE_B64)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
function _containsBorderline(text) {
  const normal = _stripNonLetters(_leetA(_baseNormalize(text)))
    .replace(/(.)\1{2,}/g, "$1$1").trim();
  for (const w of normal.split(/\s+/)) if (BORDERLINE.has(w)) return true;
  return false;
}
function _isAllCapsYelling(text) {
  const letters = String(text).replace(/[^A-Za-z]/g, "");
  if (letters.length < 6) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.8;
}
export function classifyComment(text, opts = {}) {
  const minLen = opts.minLen ?? 3;
  const maxLen = opts.maxLen ?? 200;
  const trimmed = String(text || "").trim();
  // Tier 1 — hard block (always reject; never reaches admin queue)
  if (trimmed.length < minLen) {
    return { verdict: "block", reason: "too_short",
      message: "Try writing a bit more — what did you think of the book?" };
  }
  if (trimmed.length > maxLen) {
    return { verdict: "block", reason: "too_long",
      message: "Reviews are 200 characters max. Try shorter!" };
  }
  if (containsProfanity(trimmed)) {
    return { verdict: "block", reason: "profanity",
      message: "Let's keep reviews school-appropriate. Try again!" };
  }
  if (containsPII(trimmed)) {
    return { verdict: "block", reason: "pii",
      message: "No phone numbers, emails, or web links — keep your review about the book." };
  }
  // Tier 2 — held for admin review (looks suspicious but not certain-bad)
  if (_isAllCapsYelling(trimmed)) {
    return { verdict: "review", reason: "all_caps",
      message: "Thanks! Your review is being checked and will appear shortly." };
  }
  if ((trimmed.match(/!/g) || []).length >= 3) {
    return { verdict: "review", reason: "many_exclamations",
      message: "Thanks! Your review is being checked and will appear shortly." };
  }
  if (_containsBorderline(trimmed)) {
    return { verdict: "review", reason: "borderline_word",
      message: "Thanks! Your review is being checked and will appear shortly." };
  }
  if (trimmed.length > 120) {
    return { verdict: "review", reason: "long_comment",
      message: "Thanks! Your review is being checked and will appear shortly." };
  }
  // Tier 3 — clean
  return { verdict: "allow" };
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
