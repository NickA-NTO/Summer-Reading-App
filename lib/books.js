// Server-side book metadata. Mirrors the relevant fields from CATEGORIES
// in index.html — but the server can't see that constant, so we duplicate
// the data the server actually needs (title, grade, wordCount).
//
// Word counts are approximate published values. Used to compute internal
// points via lib/xp.js: pointsForBook(wordCount, studentGrade).
//
// KEEP THIS IN SYNC with index.html's CATEGORIES — if a new book is added
// or a wordCount changes, update both.

export const BOOKS = {
  /* ---------- Grade K ---------- */
  k01: { title: "The Very Hungry Caterpillar",          grade: "K", wordCount: 225 },
  k02: { title: "The Cat in the Hat",                   grade: "K", wordCount: 1629 },
  k03: { title: "We're Going on a Bear Hunt",           grade: "K", wordCount: 225 },
  k04: { title: "Goldilocks and the Three Bears",       grade: "K", wordCount: 600 },
  k05: { title: "Mother Goose's Nursery Rhymes",        grade: "K", wordCount: 2000 },
  k06: { title: "The Gruffalo",                         grade: "K", wordCount: 750 },
  k07: { title: "If You Give a Mouse a Cookie",         grade: "K", wordCount: 290 },
  k08: { title: "Green Eggs and Ham",                   grade: "K", wordCount: 750 },

  /* ---------- Grade 1 ---------- */
  a01: { title: "The Tale of Peter Rabbit",             grade: "1", wordCount: 900 },
  a02: { title: "Owl at Home",                          grade: "1", wordCount: 1800 },
  a03: { title: "Frog and Toad Are Friends",            grade: "1", wordCount: 1900 },
  a04: { title: "Nate the Great",                       grade: "1", wordCount: 1200 },
  a05: { title: "Henry and Mudge: The First Book",      grade: "1", wordCount: 1500 },
  a06: { title: "The Dot",                              grade: "1", wordCount: 600 },
  a07: { title: "Where the Wild Things Are",            grade: "1", wordCount: 340 },
  a08: { title: "The Story about Ping",                 grade: "1", wordCount: 1000 },
  a09: { title: "Corduroy",                             grade: "1", wordCount: 750 },
  a10: { title: "Knuffle Bunny",                        grade: "1", wordCount: 290 },
  a11: { title: "The Ugly Duckling",                    grade: "1", wordCount: 1500 },

  /* ---------- Grade 2 ---------- */
  b01: { title: "The True Story of the Three Little Pigs", grade: "2", wordCount: 700 },
  b02: { title: "Owl Moon",                                grade: "2", wordCount: 825 },
  b03: { title: "The Velveteen Rabbit",                    grade: "2", wordCount: 2800 },
  b04: { title: "The Lighthouse Family: The Storm",        grade: "2", wordCount: 5000 },
  b05: { title: "Flat Stanley: His Original Adventure",    grade: "2", wordCount: 6300 },
  b06: { title: "Mercy Watson to the Rescue",              grade: "2", wordCount: 1800 },
  b07: { title: "Fantastic Mr. Fox",                       grade: "2", wordCount: 10500 },
  b08: { title: "Geeger the Robot Goes to School",         grade: "2", wordCount: 3500 },
  b09: { title: "The Magic Faraway Tree",                  grade: "2", wordCount: 46000 },

  /* ---------- Usborne Grade K ---------- */
  u01: { title: "The Enormous Turnip",     grade: "K", wordCount: 350 },
  u02: { title: "The Gingerbread Man",     grade: "K", wordCount: 350 },
  u03: { title: "Chicken Licken",          grade: "K", wordCount: 400 },

  /* ---------- Usborne Grade 1 ---------- */
  u04: { title: "Jack and the Beanstalk",         grade: "1", wordCount: 700 },
  u05: { title: "The Princess and the Pea",       grade: "1", wordCount: 500 },
  u06: { title: "The Elves and the Shoemaker",    grade: "1", wordCount: 650 },

  /* ---------- Usborne Grade 2 ---------- */
  u07: { title: "The Wizard of Oz",  grade: "2", wordCount: 7000 },
  u08: { title: "Aladdin",           grade: "2", wordCount: 6000 },
  u09: { title: "Pinocchio",         grade: "2", wordCount: 5500 },
};

export function getBook(bookId) {
  return BOOKS[bookId] || null;
}
