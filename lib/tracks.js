// Track visibility — which catalog rows (CATEGORIES) a student can see.
//
// Default rule: a student sees tracks at OR BELOW their working grade.
// This prevents discouragement from showing books a kid can't read yet,
// AND prevents above-grade XP grinding by students whose working grade is
// honest.
//
//   PK  → Beginning Readers only
//   K   → Beginning + Grade K
//   1   → Beginning + Grade K + Grade 1
//   2   → Beginning + Grade K + Grade 1 + Grade 2
//   3+  → everything we ship at K-2 (until G3+ catalog ships)
//
// Admin override: per-student `trackOverrides` on the user profile lets an
// admin force-show or force-hide a specific track regardless of working
// grade. Three states per track:
//   "auto"     — follow the default rule (same as omitted)
//   "unlocked" — force-show even if working grade wouldn't normally
//   "locked"   — force-hide even if working grade would normally show it
//
// Example: a G2 student whose admin wants to lock the Beginning Readers
// tier (so they don't drop down for easy XP) sets
// { e: "locked" } — the rest stays "auto".

// Ordered earliest-to-most-advanced. New tracks (Grade 4+) get appended.
export const TRACK_ORDER = ["e", "k", "a", "b", "c"];

// Human labels for admin UI display.
export const TRACK_LABELS = {
  e: "Beginning",
  k: "Grade K",
  a: "Grade 1",
  b: "Grade 2",
  c: "Grade 3",
};

// Map a book's authored grade level to the track it lives on. Books in
// lib/books.js and api/quiz.js carry a `grade` field like "PK", "K", "1"…"3".
const GRADE_TO_TRACK = {
  PK: "e",
  K: "k",
  "1": "a",
  "2": "b",
  "3": "c",
};
export function trackForBook(book) {
  if (!book) return null;
  return GRADE_TO_TRACK[String(book.grade)] || null;
}

// Map working-grade → which tracks the default rule allows.
// Anything beyond G2 currently sees the full K-2 catalog; when G3+ tracks
// ship, extend this list.
function defaultVisibleSet(workingGrade) {
  const g = String(workingGrade || "K").toUpperCase();
  if (g === "PK") return new Set(["e"]);
  if (g === "K") return new Set(["e", "k"]);
  if (g === "1") return new Set(["e", "k", "a"]);
  if (g === "2") return new Set(["e", "k", "a", "b"]);
  // G3 and above: everything we currently ship (Beginning → Grade 3).
  return new Set(TRACK_ORDER);
}

/**
 * Resolve which track IDs are visible for this student, applying overrides
 * on top of the default rule.
 *
 * @param {string} workingGrade   "PK" | "K" | "1" | ... | "12"
 * @param {Object} [overrides]    per-track override map, e.g. { e: "locked" }
 * @returns {string[]}            ordered subset of TRACK_ORDER
 */
export function resolveVisibleTracks(workingGrade, overrides = {}) {
  const defaults = defaultVisibleSet(workingGrade);
  const result = [];
  for (const t of TRACK_ORDER) {
    const o = overrides?.[t];
    if (o === "unlocked") {
      result.push(t);
    } else if (o === "locked") {
      // hidden
    } else if (defaults.has(t)) {
      result.push(t);
    }
  }
  return result;
}

/** True if this student should be able to see/access this track. */
export function canSeeTrack(workingGrade, overrides, trackId) {
  return resolveVisibleTracks(workingGrade, overrides).includes(trackId);
}

const ALLOWED_OVERRIDE_VALUES = new Set(["auto", "unlocked", "locked"]);

/**
 * Validate and clean an overrides payload from the admin UI. Only known
 * track IDs survive; only known states survive; "auto" is implicit so we
 * drop it from storage to keep the profile small.
 */
export function sanitizeTrackOverrides(input) {
  if (!input || typeof input !== "object") return {};
  const cleaned = {};
  for (const t of TRACK_ORDER) {
    const v = input[t];
    if (typeof v !== "string") continue;
    if (!ALLOWED_OVERRIDE_VALUES.has(v)) continue;
    if (v === "auto") continue; // implicit default
    cleaned[t] = v;
  }
  return cleaned;
}
