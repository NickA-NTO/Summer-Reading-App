// Achievement collection — Steam-style for K-8 readers (#24).
//
// Each achievement is a small declarative entry: id, name, description,
// icon (emoji), optional `hidden: true` to keep it as "???" until earned,
// optional `progress: ctx => ({current, target})` for incremental ones,
// and `check(ctx)` returning true when the kid has earned it.
//
// `ctx` is built once per evaluation by lib/store.js and passed in:
//   {
//     booksReadCount,        // distinct books in their lb:reads:all entry
//     xpTotal,               // current lb:points:all score
//     streakDays,            // current consecutive-day count (client-derived)
//     genresRead,            // Set<string> of tag ids across all read books
//     maxWordCount,          // largest wordCount of any read book
//     tourCompleted,         // boolean from user profile
//     readBookIds,           // array of all bookIds the kid has read
//     workingGrade,          // "PK" | "K" | "1" .. "12"
//     justRead: {            // (only present after a recordRead call)
//       bookId, grade, wordCount, isEmergent
//     } | null
//   }
//
// New achievements: add an entry to ACHIEVEMENTS below. Existing user
// progress isn't lost — they just earn the new one the next time their
// stats meet the criteria.

const tier = (id, name, icon, target, statKey, descTpl) => ({
  id, name, icon,
  desc: descTpl.replace("{N}", target.toLocaleString()),
  // Static target + statKey so /api/auth/me can serialize them. Client
  // reads these from the catalog payload instead of mirroring them in
  // a hardcoded ACH_PROGRESS_TARGETS const (which used to drift on
  // every achievement change).
  progressTarget: target,
  progressStat: statKey,
  progress: (ctx) => ({ current: Math.min(ctx[statKey] || 0, target), target }),
  check: (ctx) => (ctx[statKey] || 0) >= target,
});

export const ACHIEVEMENTS = [
  // ── Volume — books read ──────────────────────────────────────────────
  tier("first_read",   "First Page Turn",       "📖", 1,  "booksReadCount", "Read your first book."),
  tier("bookworm_5",   "Bookworm",              "📚", 5,  "booksReadCount", "Read {N} books."),
  tier("caterpillar",  "Hungry Caterpillar",    "🐛", 10, "booksReadCount", "Read {N} books."),
  tier("wise_owl",     "Wise Owl",              "🦉", 25, "booksReadCount", "Read {N} books."),
  tier("library_champ","Library Champion",      "🏛️", 50, "booksReadCount", "Read {N} books."),

  // ── XP milestones ────────────────────────────────────────────────────
  tier("xp_100",       "Sparkle Starter",       "✨", 100,  "xpTotal", "Earn {N} XP."),
  tier("xp_500",       "Star Reader",           "⭐", 500,  "xpTotal", "Earn {N} XP."),
  tier("xp_1k",        "Reading Star",          "🌟", 1000, "xpTotal", "Earn {N} XP."),
  {
    id: "xp_summer", name: "Summer Target", icon: "🎯",
    desc: "Hit 1,200 XP — the research-backed summer reading dose.",
    progressTarget: 1200, progressStat: "xpTotal",
    progress: (ctx) => ({ current: Math.min(ctx.xpTotal || 0, 1200), target: 1200 }),
    check: (ctx) => (ctx.xpTotal || 0) >= 1200,
  },
  tier("xp_2500",      "Super Reader",          "🚀", 2500, "xpTotal", "Earn {N} XP."),
  tier("xp_5k",        "Reading Champion",      "🏆", 5000, "xpTotal", "Earn {N} XP."),

  // ── Words read — replaces the streak ladder ──────────────────────────
  // Streaks penalized kids reading long novels (one read per book), so
  // we measure total words across every finished book instead. Targets
  // are right-sized for a K-8 summer at ~15 min/day: first badge fires
  // quickly to hook them, top tier is a stretch but reachable.
  tier("words_500",   "Page Sprinter",  "📜", 500,   "totalWordsRead", "Read {N} words across all your books."),
  tier("words_2k",    "Word Weaver",    "🧵", 2000,  "totalWordsRead", "Read {N} words across all your books."),
  tier("words_5k",    "Story Sage",     "🪶", 5000,  "totalWordsRead", "Read {N} words across all your books."),
  tier("words_15k",   "Summer Champion","👑", 15000, "totalWordsRead", "Read {N} words across all your books."),

  // ── Genre explorer ───────────────────────────────────────────────────
  {
    id: "explorer_3", name: "Explorer", icon: "🗺️",
    desc: "Read books from 3 different topics.",
    progressTarget: 3, progressStat: "genresReadSize",
    progress: (ctx) => ({ current: Math.min(ctx.genresRead?.size || 0, 3), target: 3 }),
    check: (ctx) => (ctx.genresRead?.size || 0) >= 3,
  },
  {
    id: "curious_reader", name: "Curious Reader", icon: "🌈",
    desc: "Read a book from every topic.",
    progressTarget: 5, progressStat: "genresReadSize",
    progress: (ctx) => ({ current: Math.min(ctx.genresRead?.size || 0, 5), target: 5 }),
    check: (ctx) => (ctx.genresRead?.size || 0) >= 5,
  },

  // ── Long-book conquests ──────────────────────────────────────────────
  {
    id: "tome_tackler", name: "Tome Tackler", icon: "📜",
    desc: "Finish a book with 25,000+ words.",
    progressTarget: 25000, progressStat: "maxWordCount",
    check: (ctx) => (ctx.maxWordCount || 0) >= 25000,
  },
  {
    id: "dragon_slayer", name: "Dragon Slayer", icon: "🐉",
    desc: "Finish a book with 40,000+ words.",
    progressTarget: 40000, progressStat: "maxWordCount",
    check: (ctx) => (ctx.maxWordCount || 0) >= 40000,
  },

  // ── Series-completion ────────────────────────────────────────────────
  // Generic Series Reader fires when a kid finishes 3+ books from any
  // single series. Per-series badges below it celebrate specific
  // collections in the catalog. As BOOKS in lib/books.js gets more
  // series-tagged entries (task #18 catalog expansion), the generic
  // badge picks them up automatically; per-series badges need a
  // matching `series:` field on enough books to make sense.
  {
    id: "series_reader", name: "Series Reader", icon: "🧵",
    desc: "Finish 3 books from the same series.",
    progress: (ctx) => {
      const max = Math.max(0, ...Object.values(ctx.seriesCounts || {}));
      return { current: Math.min(max, 3), target: 3 };
    },
    check: (ctx) => {
      for (const n of Object.values(ctx.seriesCounts || {})) {
        if (n >= 3) return true;
      }
      return false;
    },
  },
  {
    id: "elephant_piggie_fan", name: "Elephant & Piggie Fan", icon: "🐘",
    desc: "Read every Elephant & Piggie book in the catalog.",
    progress: (ctx) => ({
      current: Math.min(ctx.seriesCounts?.elephant_piggie || 0, 5),
      target: 5,
    }),
    check: (ctx) => (ctx.seriesCounts?.elephant_piggie || 0) >= 5,
  },
  {
    id: "frog_toad_pair", name: "Frog & Toad", icon: "🐸",
    desc: "Read both Frog and Toad books.",
    progress: (ctx) => ({
      current: Math.min(ctx.seriesCounts?.frog_toad || 0, 2),
      target: 2,
    }),
    check: (ctx) => (ctx.seriesCounts?.frog_toad || 0) >= 2,
  },

  // ── Special / discovery ──────────────────────────────────────────────
  {
    id: "movie_star", name: "Tour Guide", icon: "🎬", hidden: true,
    desc: "Finish the intro tour.",
    check: (ctx) => !!ctx.tourCompleted,
  },
  {
    id: "beginners_mind", name: "Beginner's Mind", icon: "🌱", hidden: true,
    desc: "Pass a Beginning Readers quiz.",
    check: (ctx) => ctx.justRead?.isEmergent === true,
  },
  // ── Stretch ladder — anchored to the kid's INITIAL grade ─────────────
  // The kid's starting grade is locked the first time we see them in
  // /api/auth/me. We deliberately compare against that anchor (not the
  // current working grade) so growth never moves the goalposts: a kid
  // who joins at Grade 1 and reads a Grade 3 book always earns
  // "Climbing the Mountain", even if they later graduate to Grade 2 or
  // 3 themselves. Falls back to workingGrade for old accounts that
  // existed before the initialGrade field was introduced.
  {
    id: "stepping_up", name: "Stepping Up", icon: "🪜",
    desc: "Finish a book at your starting grade level.",
    check: (ctx) => {
      if (!ctx.justRead || !ctx.initialGrade) return false;
      return gradeToN(ctx.justRead.grade) === gradeToN(ctx.initialGrade);
    },
  },
  {
    id: "reaching_higher", name: "Reaching Higher", icon: "🚀", hidden: true,
    desc: "Pass a quiz on a book above your starting grade.",
    check: (ctx) => {
      if (!ctx.justRead || !ctx.initialGrade) return false;
      return gradeToN(ctx.justRead.grade) - gradeToN(ctx.initialGrade) >= 1;
    },
  },
  {
    id: "climbing_mountain", name: "Climbing the Mountain", icon: "🏔️", hidden: true,
    desc: "Finish a book two grade levels above where you started.",
    check: (ctx) => {
      if (!ctx.justRead || !ctx.initialGrade) return false;
      return gradeToN(ctx.justRead.grade) - gradeToN(ctx.initialGrade) >= 2;
    },
  },
];

// Shared grade→number helper for the stretch ladder. PK=-1, K=0, Grades
// 1-12 map to themselves. Used by Stepping Up / Reaching Higher /
// Climbing the Mountain to compute the delta from the kid's anchor.
function gradeToN(g) {
  const s = String(g || "").toUpperCase();
  if (s === "PK") return -1;
  if (s === "K") return 0;
  const m = s.match(/[0-9]+/);
  return m ? Number(m[0]) : 0;
}

// Quick lookup by id for the toast / detail modal.
export const ACHIEVEMENT_BY_ID = Object.fromEntries(
  ACHIEVEMENTS.map((a) => [a.id, a])
);

/**
 * Run every rule against ctx and return the ids that pass. Caller
 * compares against already-unlocked to find NEWLY unlocked ones.
 */
export function evaluateAll(ctx) {
  const earned = [];
  for (const a of ACHIEVEMENTS) {
    try { if (a.check(ctx)) earned.push(a.id); } catch {}
  }
  return earned;
}
