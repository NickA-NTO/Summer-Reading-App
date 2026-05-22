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
export function normalizeGrade(g) {
  if (g == null) return DEFAULT_GRADE;
  const s = String(g).trim().toUpperCase();
  if (s === "PK" || s === "-1" || /pre.?k/i.test(s)) return "PK";
  if (s === "K" || s === "0" || /kinder/i.test(s)) return "K";
  // Match G12 / Grade 12 / 12 / 1-12
  const m = s.match(/\b(1[0-2]|[1-9])\b/);
  if (m) return m[1];
  return DEFAULT_GRADE;
}

// How many internal points this book is worth for a student at this grade.
// Floored, with a minimum of 1 point so very short books still award something.
export function pointsForBook(wordCount, grade) {
  const wcpm = WCPM_BY_GRADE[normalizeGrade(grade)] || WCPM_BY_GRADE[DEFAULT_GRADE];
  const wc = Number(wordCount) || 0;
  if (wc < 1) return 0;
  return Math.max(1, Math.floor(wc / wcpm));
}

// Estimated minutes for the UI ("~13 min read"). Same calculation but
// expressed as a float for display.
export function estimatedMinutes(wordCount, grade) {
  const wcpm = WCPM_BY_GRADE[normalizeGrade(grade)] || WCPM_BY_GRADE[DEFAULT_GRADE];
  const wc = Number(wordCount) || 0;
  if (wc < 1) return 0;
  return +(wc / wcpm).toFixed(1);
}
