// Internal "points" calculation for the in-app leaderboard.
//
// Points = floor(bookWordCount / WCPM_for_student_grade)
//
// This is approximately the number of minutes a student at that grade is
// expected to take to read the book. We use it as a fairness metric for
// the in-app leaderboard so that:
//   - Easy books read by older kids award few points
//   - Long books read by any kid award many points
//   - The same book is worth MORE to a younger reader (lower WCPM)
//
// NOTE: These points are INTERNAL ONLY. The official XP credit on a
// student's record is awarded by TimeBack based on the Caliper events
// we emit (see section 1e in TODO.md). The two systems are intentionally
// decoupled.

// Hasbrouck-Tindal 2017 end-of-year norms, 50th percentile (oral reading rate).
// Extended beyond G5 by extrapolation — readers don't really speed up much
// past G5, so points awarded for G6-G12 readers should be a bit higher
// (proportionally fewer points per word vs. younger readers, which is the
// right gradient if older kids ever read K-2 books).
// PK is below standard tables; we use ~15 wpm as a stand-in for pre-readers.
// https://www.readingrockets.org/article/oral-reading-fluency-norms-valuable-assessment-tool-reading-teachers
export const WCPM_BY_GRADE = {
  PK:  15,
  K:   30,
  "1": 60,
  "2": 100,
  "3": 110,
  "4": 130,
  "5": 140,
  "6": 150,
  "7": 150,
  "8": 150,
  "9": 155,
  "10": 155,
  "11": 160,
  "12": 160,
};

export const DEFAULT_GRADE = "K";

// Accept "PK", "K", "k", "1", 1, "Grade 2", "G12", "-1" (TimeBack PK), etc.
// Returns "PK" | "K" | "1"…"12".
//
// Previous implementation used `\b(1[0-2]|[1-9])\b` which silently
// failed on inputs like "G3", "g4", "G12", "Grade5", "5th" — the
// letter↔digit junction is NOT a word boundary in regex (both are
// word characters), so the `\b` requirement was never satisfied.
// Anyone pasting natural shorthand into the admin grade override
// would think they'd set Grade 3 but get K. Agent 7 caught this.
export function normalizeGrade(g) {
  if (g == null) return DEFAULT_GRADE;
  const s = String(g).trim().toUpperCase();
  if (s === "PK" || s === "-1" || /pre.?k/i.test(s)) return "PK";
  if (s === "K" || s === "0" || /kinder/i.test(s)) return "K";
  // Pull out a 1- or 2-digit grade. Lookarounds replace word
  // boundaries: "not preceded by a digit, not followed by a digit"
  // permits letter-adjacent digits ("G3", "Grade5") while still
  // refusing to chop "12" out of "120" or "1" out of "13".
  const m = s.match(/(?<![0-9])(1[0-2]|[1-9])(?![0-9])/);
  if (m) return m[1];
  return DEFAULT_GRADE;
}

// Expected wall-clock time the student spends on the quiz, on top of
// reading. 1 minute per question (TTS read-aloud + thinking + tap).
//
// #29 fix: ALL quizzes now serve 5 questions per attempt — the client's
// questionsPerAttempt() returns 5 regardless of tier (the emergent tier
// kept a smaller question POOL, 6 vs 12, but still draws 5 per attempt).
// The old 3-question emergent quiz time was stale and underpaid the
// youngest readers ~2 XP per book. At the app's ~1-XP-per-active-minute
// target, the fair quiz time is 5 Q × 1 min = 5 min for every tier.
// QUIZ_TIME_EMERGENT_MIN is retained as an alias for call-site
// compatibility but now equals the full time.
export const QUIZ_MIN_PER_QUESTION = 1;
export const QUIZ_QUESTIONS_FULL = 5;
export const QUIZ_QUESTIONS_EMERGENT = 5; // unified — all tiers draw 5/attempt
export const QUIZ_TIME_FULL_MIN     = QUIZ_QUESTIONS_FULL     * QUIZ_MIN_PER_QUESTION;  // 5
export const QUIZ_TIME_EMERGENT_MIN = QUIZ_QUESTIONS_EMERGENT * QUIZ_MIN_PER_QUESTION;  // 5 (was 3)

// Expected wall-clock time the student spends in the conversational
// retell (#9). One full retell session — intro retell + 2 follow-up
// questions + closing — averages 1.5–3 min in practice. Flat regardless
// of attempt count, same logic as quiz time.
export const RETELL_TIME_MIN = 3;

// ---------- XP ratio model for combined quiz + retell sessions (#9) ----------
//
// XP = floor(ratio × totalSessionMin), where:
//   totalSessionMin = readingMin + quizMin + retellMin
//   ratio is looked up below based on (quizOutcome, retellOutcome)
//
// Outcomes are encoded as 2-letter codes for compactness in the lookup:
//   quiz / retell outcome:
//     "p1" — passed on attempt 1
//     "p2" — passed on attempt 2
//     "fF" — failed (both attempts used)
//
// Notes on the chosen ratios:
//   - 1.30 (both clean) = 30% bonus over baseline. Caps the upside.
//   - 1.15 (one retake)  = 15% bonus. Still rewarded for completing both.
//   - 1.00 (one section clean, other failed) = baseXP exactly. Honest pay
//     for finishing one half right.
//   - 0.70 (one section needed retake, other failed) = real penalty.
//   - 0.55 (both retakes) = "you tried but didn't know it" — less than
//     pass-1-clean (1.00), preserving the incentive to read carefully.
//   - 0.00 (both fail) = no XP.
//
// Pre-launch: no real users yet, so this replaces the old retake
// multiplier wholesale. The old POINTS_RETAKE_MULTIPLIER env var is
// no longer read — the ratio table is the single source of truth.
export const OUTCOME_RATIOS = {
  p1_p1: 1.30, p1_p2: 1.15, p2_p1: 1.15, p2_p2: 0.55,
  p1_fF: 1.00, p2_fF: 0.70,
  fF_p1: 1.00, fF_p2: 0.70,
  fF_fF: 0.00,
};

/** Compute XP for a combined quiz+retell session.
 *
 *  @param {object} args
 *    args.wordCount    — book word count
 *    args.workingGrade — student working grade (drives WCPM → reading time)
 *    args.quizOutcome  — "p1" | "p2" | "fF"
 *    args.retellOutcome — "p1" | "p2" | "fF"
 *    args.emergent     — true for 3-question emergent quizzes
 *  @returns {object} { xp, ratio, readingMin, quizMin, retellMin, totalMin, outcomeKey }
 */
export function xpForReadingSession({
  wordCount,
  workingGrade,
  quizOutcome = "fF",
  retellOutcome = "fF",
  emergent = false,
}) {
  const wcpm = WCPM_BY_GRADE[normalizeGrade(workingGrade)] || WCPM_BY_GRADE[DEFAULT_GRADE];
  const wc = Number(wordCount) || 0;
  const readingMin = wc > 0 ? wc / wcpm : 0;
  const quizMin   = emergent ? QUIZ_TIME_EMERGENT_MIN : QUIZ_TIME_FULL_MIN;
  const retellMin = RETELL_TIME_MIN;
  const totalMin  = readingMin + quizMin + retellMin;

  const outcomeKey = `${quizOutcome}_${retellOutcome}`;
  const ratio = OUTCOME_RATIOS[outcomeKey] ?? 0;
  const xp = Math.max(0, Math.floor(ratio * totalMin));
  return { xp, ratio, readingMin, quizMin, retellMin, totalMin, outcomeKey };
}

/** Convenience: derive outcome code from (passed, attempt).
 *  passed=false → "fF" regardless of attempt count
 *  passed=true + attempt=1 → "p1"
 *  passed=true + attempt=2 → "p2"
 *
 *  This is the QUIZ outcome helper. For retells, use
 *  retellOutcomeFromRubric — attempts are meaningless for retell
 *  (one-shot per session), but rubric quality matters.
 */
export function outcomeCode(passed, attempt) {
  if (!passed) return "fF";
  return attempt === 2 ? "p2" : "p1";
}

/** Map a retell rubric total (0..12) to the outcome code used in
 *  OUTCOME_RATIOS. NO HOLDS — every retell resolves to a tier here:
 *    ≥ 9 / 12 → "p1" — rich retell, full bonus (1.30× when quiz p1)
 *    5-8 / 12 → "p2" — genuine retell, partial bonus (1.15× when quiz p1)
 *     < 5 / 12 → "fF" — weak/vague, no bonus (1.00× = base when quiz p1)
 *
 *  The bonus bar (5/12) is intentionally LOW and the grader is
 *  grade-calibrated (a real PK-G1 retell — main character + 1-2 events,
 *  on topic — scores well), so genuine retells earn the bonus and only
 *  vague/off-topic ones drop to base. A passed quiz always pays at least
 *  base XP (p1_fF = 1.00×), so the retell is pure upside — never a hold,
 *  never a zero from grading (silence is gated upstream in api/tutor.js,
 *  not failed here). The p1 cutoff (9) matches TUTOR_CLEAR_PASS_SCORE so a
 *  turn-1 clear-pass and a full-conversation finalize both land in p1.
 */
export function retellOutcomeFromRubric(rubricTotal) {
  const t = Number(rubricTotal);
  if (!Number.isFinite(t) || t < 5) return "fF";
  if (t < 9) return "p2";
  return "p1";
}

// How many internal points this book is worth for a student at this grade.
// XP = floor(reading_minutes + quiz_minutes), with a minimum of 1 so very
// short books still award something.
//
// opts.includeQuizTime: include the quiz in the expected-time calculation.
//   True for quiz-driven reads (attemptNum present in /api/activity).
//   False for manual "I read this" reads (no quiz taken).
// opts.emergent: use the shorter emergent-tier quiz time (3 questions vs 5).
export function pointsForBook(wordCount, grade, opts = {}) {
  const wcpm = WCPM_BY_GRADE[normalizeGrade(grade)] || WCPM_BY_GRADE[DEFAULT_GRADE];
  const wc = Number(wordCount) || 0;
  if (wc < 1) return 0;
  const quizMin = opts.includeQuizTime
    ? (opts.emergent ? QUIZ_TIME_EMERGENT_MIN : QUIZ_TIME_FULL_MIN)
    : 0;
  return Math.max(1, Math.floor(wc / wcpm + quizMin));
}

// Estimated minutes for the UI ("~13 min read"). Same calculation but
// expressed as a float for display.
export function estimatedMinutes(wordCount, grade) {
  const wcpm = WCPM_BY_GRADE[normalizeGrade(grade)] || WCPM_BY_GRADE[DEFAULT_GRADE];
  const wc = Number(wordCount) || 0;
  if (wc < 1) return 0;
  return +(wc / wcpm).toFixed(1);
}

// Stall-alarm threshold in days for a "currently reading" book (#16).
//
// We expect a student to read ~20 min/day, so a book's natural pace is
// ceil(expected_minutes / 20) days. We give twice that before alarming,
// with a 14-day floor so very short books don't ping immediately even if
// a kid takes a couple of weeks to come back to them.
//
//   Caterpillar (10 min total)        → max(14, 2×1)  = 14 days
//   Cat in the Hat (57 min total)     → max(14, 2×3)  = 14 days
//   Fantastic Mr. Fox (108 min total) → max(14, 2×6)  = 14 days
//   Magic Faraway Tree (463 min)      → max(14, 2×24) = 48 days
//
// Same opts shape as pointsForBook so callers don't have to compute it
// twice — pass { includeQuizTime: true, emergent: <bool> } for an
// active quiz-driven read.
export function stallAlarmDays(wordCount, grade, opts = {}) {
  const wcpm = WCPM_BY_GRADE[normalizeGrade(grade)] || WCPM_BY_GRADE[DEFAULT_GRADE];
  const wc = Number(wordCount) || 0;
  if (wc < 1) return 14;
  const quizMin = opts.includeQuizTime ? QUIZ_TIME_FULL_MIN : 0;
  const totalMin = wc / wcpm + quizMin;
  const expectedDays = Math.ceil(totalMin / 20);
  return Math.max(14, 2 * expectedDays);
}
