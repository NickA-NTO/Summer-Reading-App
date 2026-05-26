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
    progress: (ctx) => ({ current: Math.min(ctx.xpTotal || 0, 1200), target: 1200 }),
    check: (ctx) => (ctx.xpTotal || 0) >= 1200,
  },
  tier("xp_2500",      "Super Reader",          "🚀", 2500, "xpTotal", "Earn {N} XP."),
  tier("xp_5k",        "Reading Champion",      "🏆", 5000, "xpTotal", "Earn {N} XP."),

  // ── Streaks ──────────────────────────────────────────────────────────
  tier("streak_3",     "On a Roll",             "🔥", 3,  "streakDays", "Read on {N} days in a row."),
  tier("streak_7",     "Week Warrior",          "🔥", 7,  "streakDays", "Read on {N} days in a row."),
  tier("streak_14",    "Diamond Streak",        "💎", 14, "streakDays", "Read on {N} days in a row."),
  tier("streak_30",    "Month Master",          "👑", 30, "streakDays", "Read on {N} days in a row."),

  // ── Genre explorer ───────────────────────────────────────────────────
  {
    id: "explorer_3", name: "Explorer", icon: "🗺️",
    desc: "Read books from 3 different topics.",
    progress: (ctx) => ({ current: Math.min(ctx.genresRead?.size || 0, 3), target: 3 }),
    check: (ctx) => (ctx.genresRead?.size || 0) >= 3,
  },
  {
    id: "curious_reader", name: "Curious Reader", icon: "🌈",
    desc: "Read a book from every topic.",
    progress: (ctx) => ({ current: Math.min(ctx.genresRead?.size || 0, 5), target: 5 }),
    check: (ctx) => (ctx.genresRead?.size || 0) >= 5,
  },

  // ── Long-book conquests ──────────────────────────────────────────────
  {
    id: "tome_tackler", name: "Tome Tackler", icon: "📜",
    desc: "Finish a book with 25,000+ words.",
    check: (ctx) => (ctx.maxWordCount || 0) >= 25000,
  },
  {
    id: "dragon_slayer", name: "Dragon Slayer", icon: "🐉",
    desc: "Finish a book with 40,000+ words.",
    check: (ctx) => (ctx.maxWordCount || 0) >= 40000,
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
  {
    id: "reaching_higher", name: "Reaching Higher", icon: "🚀", hidden: true,
    desc: "Pass a quiz on a book above your working grade.",
    // Compare book grade vs working grade. Higher book = stretch reading.
    check: (ctx) => {
      if (!ctx.justRead || !ctx.workingGrade) return false;
      const gToN = (g) => {
        const s = String(g).toUpperCase();
        if (s === "PK") return -1;
        if (s === "K") return 0;
        const m = s.match(/[0-9]+/);
        return m ? Number(m[0]) : 0;
      };
      return gToN(ctx.justRead.grade) > gToN(ctx.workingGrade);
    },
  },
];

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
