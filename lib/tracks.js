// Track visibility — which catalog rows (CATEGORIES) a student can see.
//
// Default rule: a student sees tracks within ±1 of their working grade.
// Avoids two opposite failure modes:
//   - A G3 reader scrolling past 5 rows of "baby" content before
//     reaching their own grade (Agent 2 complaint — felt babyish).
//   - A K reader being overwhelmed by 3rd-grade chapter books they
//     can't decode (the original "at or below" rule was a defense
//     against this).
//
// Window cap: ±1 around the kid's level (PK=-1, K=0, 1..12=N). For
// any grade higher than the highest-shipping track, the window is
// clipped to whatever's available so the kid still sees content.
//
//   PK  → Beginning + Grade K          (PK has no -1)
//   K   → Beginning + Grade K + Grade 1
//   1   → Grade K + Grade 1 + Grade 2
//   2   → Grade 1 + Grade 2 + Grade 3
//   3   → Grade 2 + Grade 3            (no Grade 4 catalog yet)
//   4+  → Grade 3 only (until G4+ catalog ships — task #18)
//
// Admin override: per-student `trackOverrides` on the user profile lets
// an admin force-show or force-hide a specific track regardless of
// working grade. Three states per track:
//   "auto"     — follow the default rule (same as omitted)
//   "unlocked" — force-show even if working grade wouldn't normally
//   "locked"   — force-hide even if working grade would normally show it
//
// Example: a G3 student whose admin wants to unlock the Beginning
// Readers tier (for a slow-down day) sets { e: "unlocked" } — the
// rest stays "auto" so the ±1 window continues to apply.

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

// Map working-grade → which tracks the default rule allows. Built from
// the GRADE_TO_TRACK map so additional grades (when G4+ catalog ships)
// just extend GRADE_TO_TRACK and this function picks them up.
//
// Rule: visible = any track whose level is within [myLevel-1, myLevel+1].
// Levels: PK = -1, K = 0, Grade N = N. If the window contains no
// shipping tracks (kid working above the top of the catalog), fall back
// to the highest available track so they still see content.
function defaultVisibleSet(workingGrade) {
  const TRACK_TO_LEVEL = { e: -1, k: 0, a: 1, b: 2, c: 3 };
  const g = String(workingGrade || "K").toUpperCase();
  const myLevel =
    g === "PK" ? -1 :
    g === "K"  ? 0  :
    Number(g) || 0;
  const lo = myLevel - 1;
  const hi = myLevel + 1;
  const visible = new Set();
  for (const t of TRACK_ORDER) {
    const lvl = TRACK_TO_LEVEL[t];
    if (lvl == null) continue;
    if (lvl >= lo && lvl <= hi) visible.add(t);
  }
  // Fallback — kid is working above the top of the available catalog
  // (e.g., G4+ with no Grade 4 row yet). Show the highest available
  // track so they have at least something. Without this, a G5 reader
  // would see an empty home page.
  if (visible.size === 0) {
    const highest = TRACK_ORDER.slice().reverse()
      .find((t) => TRACK_TO_LEVEL[t] != null);
    if (highest) visible.add(highest);
  }
  return visible;
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
