/**
 * Catalog enrichment — fetches grounded book data from multiple public
 * sources and synthesizes a structured, source-cited record per book.
 * The records replace the hand-written summaries in api/quiz.js as the
 * ground truth for quiz generation.
 *
 * Pipeline:
 *   1. For each book in api/quiz.js (QUIZ_BOOKS):
 *      a. Pull ISBN from index.html catalog data.
 *      b. Fetch in parallel:
 *         • Wikipedia REST API (page summary + full HTML for plot/chars)
 *         • Open Library (ISBN → work → description + subjects)
 *         • Google Books volumes API (description + categories)
 *      c. Run Claude synthesis with a strict citation-contract prompt
 *         (every fact in the output must carry a source_id).
 *      d. Write the structured record to lib/book-records.json.
 *   2. Print a coverage report: high / medium / low / no-source per book.
 *
 * Idempotent — re-running skips books already cached unless `--force`
 * or `--book=<id>` is passed. Per-book records carry a `cachedAt`
 * timestamp; records older than 30 days are auto-refetched.
 *
 * USAGE
 *   node scripts/enrich-catalog.js                  # all stale/missing
 *   node scripts/enrich-catalog.js --book=e07       # single book
 *   node scripts/enrich-catalog.js --force          # ignore cache
 *   node scripts/enrich-catalog.js --report         # cache report only
 *
 * ENV
 *   ANTHROPIC_API_KEY (required) — synthesis model
 *   GOOGLE_BOOKS_API_KEY (optional) — higher quota; works without
 *
 * COSTS
 *   ~$0.02-0.10 per book (Claude Opus 4.5 synthesis). Full 56-book
 *   catalog run = ~$2-5. Free for everything else (Wikipedia +
 *   Open Library are no-auth; Google Books has 1k/day free).
 */

import "node:process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { QUIZ_BOOKS } from "../api/quiz.js";

// ============================================================
// Config
// ============================================================

const SYNTHESIS_MODEL = "claude-opus-4-5";
const RECORDS_PATH = path.join(process.cwd(), "lib", "book-records.json");
const INDEX_HTML_PATH = path.join(process.cwd(), "index.html");
const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REQUEST_TIMEOUT_MS = 15_000;

// Politeness — Wikipedia and Open Library both have soft caps around
// 200 req/s but we're sequential anyway. Add small inter-book pause.
const INTER_BOOK_DELAY_MS = 250;

// ============================================================
// CLI args
// ============================================================

const args = process.argv.slice(2);
const argBook = args.find((a) => a.startsWith("--book="))?.slice(7) || null;
const argForce = args.includes("--force");
const argReportOnly = args.includes("--report");

// ============================================================
// ISBN extraction from index.html catalog
// ============================================================

function loadIsbnsFromCatalog() {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf-8");
  // Catalog entries look like: { id: "e07", isbn: "9780394800134", title: "..."
  // Match a permissive shape so future formatting changes don't break this.
  const re = /id:\s*"([a-z0-9]+)"\s*,\s*isbn:\s*"(\d{13})"/g;
  const map = {};
  let m;
  while ((m = re.exec(html))) {
    map[m[1]] = m[2];
  }
  return map;
}

// ============================================================
// Cache (lib/book-records.json)
// ============================================================

function loadRecords() {
  if (!fs.existsSync(RECORDS_PATH)) {
    return { schema: 1, generatedAt: null, records: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(RECORDS_PATH, "utf-8"));
  } catch (err) {
    console.warn("[enrich] couldn't parse existing records, starting fresh:", err.message);
    return { schema: 1, generatedAt: null, records: {} };
  }
}

function saveRecords(records) {
  fs.mkdirSync(path.dirname(RECORDS_PATH), { recursive: true });
  fs.writeFileSync(RECORDS_PATH, JSON.stringify(records, null, 2));
}

function isStale(record) {
  if (!record || !record.cachedAt) return true;
  return Date.now() - record.cachedAt > STALE_MS;
}

// ============================================================
// Source fetchers
// ============================================================

const USER_AGENT =
  "ReadingSpineEnrichment/1.0 (https://github.com/NickA-NTO/Summer-Reading-App)";

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Wikipedia: try the most likely article title first, fall back to
 * search if 404. Pulls the page HTML and extracts plot/synopsis/
 * characters sections. Returns "" if we can't find the article.
 */
async function fetchWikipedia(title, author) {
  // Try a few common title variants Wikipedia might use.
  const variants = [
    title,
    `${title} (book)`,
    `${title} (novel)`,
    `${title} (picture book)`,
    `The ${title}`,
  ];
  // Also try a search fallback.
  for (const variant of variants) {
    const slug = encodeURIComponent(variant.replace(/ /g, "_"));
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
    try {
      const r = await fetchWithTimeout(summaryUrl);
      if (r.ok) {
        const data = await r.json();
        if (data.type !== "disambiguation" && (data.extract || "").length > 100) {
          // Got a real page. Now pull the section text for plot/chars.
          const sections = await fetchWikipediaSections(variant);
          return {
            title: data.title,
            extract: data.extract || "",
            sections,
            sourceUrl: data.content_urls?.desktop?.page || summaryUrl,
          };
        }
      }
    } catch {
      // try next variant
    }
  }
  // Search fallback
  try {
    const q = encodeURIComponent(`${title} ${author}`);
    const r = await fetchWithTimeout(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${q}&limit=1&format=json`
    );
    if (r.ok) {
      const data = await r.json();
      const foundTitle = data?.[1]?.[0];
      if (foundTitle) {
        const slug = encodeURIComponent(foundTitle.replace(/ /g, "_"));
        const s = await fetchWithTimeout(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`
        );
        if (s.ok) {
          const data2 = await s.json();
          const sections = await fetchWikipediaSections(foundTitle);
          return {
            title: data2.title,
            extract: data2.extract || "",
            sections,
            sourceUrl: data2.content_urls?.desktop?.page || "",
          };
        }
      }
    }
  } catch {}
  return null;
}

async function fetchWikipediaSections(title) {
  // Pull section text. First try to isolate plot-ish sections by header
  // name (Plot, Synopsis, Characters, Story, Summary, Content,
  // Description, Storyline). If NONE match (common for vignette
  // picture books that don't have a plot section at all), fall back to
  // the first ~5000 chars of body text from non-meta sections (skipping
  // Reception, Publication, Adaptations, References, etc.).
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  try {
    const r = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/mobile-sections/${slug}`
    );
    if (!r.ok) return "";
    const data = await r.json();
    const all = data.remaining?.sections || [];
    const want = /plot|synopsis|characters|story|summary|content|description|storyline/i;
    const reject = /reception|publication|adapt|legacy|reference|external|further|award|sequel|see also/i;

    // Pass 1: explicit plot/content matches.
    const plotMatches = all
      .filter((s) => want.test(s.line || ""))
      .map((s) => stripHtml(s.text || ""))
      .join("\n\n");
    if (plotMatches.length > 200) return plotMatches.slice(0, 5000);

    // Pass 2: anything that isn't obviously meta-about-the-book.
    const bodyText = all
      .filter((s) => !reject.test(s.line || ""))
      .map((s) => stripHtml(s.text || ""))
      .join("\n\n");
    return bodyText.slice(0, 5000);
  } catch {
    return "";
  }
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "") // footnote markers
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Open Library: ISBN → book → work. Returns description + subjects.
 */
async function fetchOpenLibrary(isbn) {
  if (!isbn) return null;
  try {
    const r = await fetchWithTimeout(`https://openlibrary.org/isbn/${isbn}.json`);
    if (!r.ok) return null;
    const book = await r.json();
    const result = {
      title: book.title,
      description: typeof book.description === "string"
        ? book.description
        : (book.description?.value || ""),
      subjects: book.subjects || [],
      sourceUrl: `https://openlibrary.org/isbn/${isbn}`,
    };
    // Pull the work entry too for richer description.
    const workKey = Array.isArray(book.works) && book.works[0]?.key;
    if (workKey) {
      try {
        const w = await fetchWithTimeout(`https://openlibrary.org${workKey}.json`);
        if (w.ok) {
          const work = await w.json();
          const desc = typeof work.description === "string"
            ? work.description
            : (work.description?.value || "");
          if (desc && desc.length > (result.description || "").length) {
            result.description = desc;
          }
          if (Array.isArray(work.subjects)) {
            result.subjects = [...new Set([...result.subjects, ...work.subjects])];
          }
          if (Array.isArray(work.subject_people)) {
            result.subject_people = work.subject_people;
          }
        }
      } catch {}
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Google Books: volumes search by ISBN. Returns description + categories.
 */
async function fetchGoogleBooks(isbn) {
  if (!isbn) return null;
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const keyParam = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
  try {
    const r = await fetchWithTimeout(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}${keyParam}`
    );
    if (!r.ok) return null;
    const data = await r.json();
    const item = data.items?.[0];
    if (!item) return null;
    const info = item.volumeInfo || {};
    return {
      title: info.title,
      authors: info.authors || [],
      description: info.description || "",
      categories: info.categories || [],
      pageCount: info.pageCount,
      sourceUrl: info.canonicalVolumeLink ||
        `https://books.google.com/books?vid=ISBN${isbn}`,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Synthesis (Claude with citation contract)
// ============================================================

const RecordSchema = z.object({
  premise: z.string().min(20),
  characters: z.array(z.object({
    name: z.string(),
    role: z.string(),
    source_ids: z.array(z.number().int()),
  })),
  key_objects: z.array(z.object({
    item: z.string(),
    detail: z.string().optional().describe(
      "Specific detail like color, count, size — only if explicitly in a source."
    ),
    source_ids: z.array(z.number().int()),
  })),
  plot_beats: z.array(z.object({
    beat: z.string(),
    source_ids: z.array(z.number().int()),
  })),
  setting: z.string(),
  themes: z.array(z.string()),
  specific_facts: z.array(z.object({
    fact: z.string(),
    source_ids: z.array(z.number().int()),
  })).describe(
    "Verifiable specifics (counts, colors, names, locations) that MUST be cited."
  ),
  confidence: z.enum(["high", "medium", "low"]),
  unknown_fields: z.array(z.string()).describe(
    "Fields the sources don't establish — quiz generator must avoid these."
  ),
});

async function synthesize(book, sources) {
  // Number the source feeds so the model can cite them.
  const numbered = [];
  let id = 1;
  if (sources.wikipedia) {
    numbered.push({
      id: id++,
      name: "Wikipedia",
      text: `Title: ${sources.wikipedia.title}\nExtract: ${sources.wikipedia.extract}\nSections: ${sources.wikipedia.sections}`,
    });
  }
  if (sources.openLibrary) {
    numbered.push({
      id: id++,
      name: "Open Library",
      text: `Title: ${sources.openLibrary.title}\nDescription: ${sources.openLibrary.description}\nSubjects: ${(sources.openLibrary.subjects || []).join(", ")}${sources.openLibrary.subject_people ? "\nPeople: " + sources.openLibrary.subject_people.join(", ") : ""}`,
    });
  }
  if (sources.googleBooks) {
    numbered.push({
      id: id++,
      name: "Google Books",
      text: `Title: ${sources.googleBooks.title}\nAuthors: ${(sources.googleBooks.authors || []).join(", ")}\nDescription: ${sources.googleBooks.description}\nCategories: ${(sources.googleBooks.categories || []).join(", ")}`,
    });
  }
  // App's existing editorial summary (api/quiz.js QUIZ_BOOKS[id].summary).
  // Hand-written by the app team and includes plot detail the public
  // sources may miss — especially valuable for vignette picture books
  // where Wikipedia has no plot section. The synthesizer is instructed
  // to TREAT THIS LIKE THE OTHER SOURCES: cross-validate against the
  // others, drop or mark `unknown` any fact this source asserts that no
  // other source confirms. So a wrong claim in our summary (e.g. "fight
  // with Ned" in One Fish Two Fish) gets filtered out because no public
  // source confirms it. A correct claim (e.g. characters Mike, Yink)
  // gets included because Wikipedia/OL list them too.
  if (sources.editorialSummary) {
    numbered.push({
      id: id++,
      name: "App editorial summary (cross-validate against the others)",
      text: sources.editorialSummary,
    });
  }

  if (numbered.length === 0) {
    return { error: "no_sources" };
  }

  const sourceBlock = numbered
    .map((s) => `[${s.id}] ${s.name}:\n${s.text}`)
    .join("\n\n");

  const system = `You extract verifiable facts from provided sources about a
children's book. Your output grounds a quiz generator that builds
reading-COMPREHENSION questions for kids in kindergarten through
grade 3. The kid has just read the book — your record tells the
generator what they should be able to answer.

CRITICAL RULES:
1. Use ONLY the sources provided. If a fact is not in the sources, list
   it under "unknown_fields" — do NOT use your own knowledge.
2. Every array item MUST cite at least one source_id.
3. For specific_facts: include CONCRETE counts, colors, names, locations,
   relationships, and similar specifics IF a source explicitly states
   the value. "many" or "several" is NOT a specific count — don't
   convert it.
4. CRITICAL: focus on CONTENT-of-the-book facts, NOT facts ABOUT the
   book (publication metadata). Examples:
     GOOD specific_facts:
       - "Jack is eight years old"
       - "The wolf eats the grandmother"
       - "Peter wears a blue jacket"
       - "The caterpillar eats five oranges on Friday"
     BAD specific_facts (do NOT include unless absolutely nothing else):
       - "Published in 1960"
       - "Won the Caldecott Medal"
       - "Sold six million copies"
       - "Illustrated by X until 2016"
   Publication metadata is useless for a kid quiz. Filter it out and
   focus on plot/character/setting specifics.
5. characters: include EVERY character the sources mention, including
   minor ones (a quiz generator needs distractor names). If the
   sources name an unusual creature ("Yink", "Wump", "Gruffalo"), that
   counts as a character.
6. plot_beats: capture the ordered events that happen IN the book, not
   the book's reception. Aim for 5-10 beats for a story; fewer for
   vignette/rhyming books that don't have a plot.
7. If two sources contradict, list both with both source_ids and set
   confidence to "medium" or "low".
8. confidence:
   - "high": multiple sources agree on plot content; specific_facts has
     5+ verifiable CONTENT items (not metadata).
   - "medium": one source dominates, plot is sparse but characters and
     setting are established.
   - "low": sources are thin (mostly bibliographic), almost no CONTENT
     specifics. The generator will fall back to prose summary in this
     case, so prefer setting confidence: low over inventing facts.
9. unknown_fields: list any common quiz topics the sources don't cover.
   The quiz generator will refuse to ask about anything in this list.
   Examples: "main_character_age" (if no source gives an age),
   "number_of_siblings", "color_of_house". Be GENEROUS with this list —
   "I think but am not sure" goes here.`;

  const prompt = `Book: "${book.title}" by ${book.author}
Grade level: ${book.grade}

Sources:

${sourceBlock}

Build a structured record per the schema. Every entry must have source_ids.`;

  try {
    const { object } = await generateObject({
      model: anthropic(SYNTHESIS_MODEL),
      schema: RecordSchema,
      system,
      prompt,
      temperature: 0.2, // low — we want fidelity, not creativity
    });
    return { record: object };
  } catch (err) {
    return { error: "synthesis_failed", message: String(err?.message || err) };
  }
}

// ============================================================
// Main loop
// ============================================================

async function enrichOne(bookId, book, isbn) {
  console.log(`\n[${bookId}] ${book.title} by ${book.author}`);
  if (!isbn) console.log(`   ⚠ no ISBN found in catalog`);

  const [wikipedia, openLibrary, googleBooks] = await Promise.all([
    fetchWikipedia(book.title, book.author).catch(() => null),
    fetchOpenLibrary(isbn).catch(() => null),
    fetchGoogleBooks(isbn).catch(() => null),
  ]);

  // The app's existing hand-written summary in api/quiz.js QUIZ_BOOKS.
  // Passed as a 4th source for cross-validation, especially valuable
  // for vignette picture books where Wikipedia has no plot section.
  const editorialSummary = book.summary || null;
  const editorialAvailable = !!(editorialSummary && editorialSummary.length > 50);

  console.log(`   wiki:${wikipedia ? "✓" : "✗"} OL:${openLibrary ? "✓" : "✗"} GB:${googleBooks ? "✓" : "✗"} editorial:${editorialAvailable ? "✓" : "✗"}`);

  const result = await synthesize(book, {
    wikipedia, openLibrary, googleBooks,
    editorialSummary: editorialAvailable ? editorialSummary : null,
  });
  if (result.error) {
    console.log(`   ✗ ${result.error}: ${result.message || ""}`);
    return {
      bookId,
      error: result.error,
      message: result.message,
      cachedAt: Date.now(),
      sources_found: {
        wikipedia: !!wikipedia, openLibrary: !!openLibrary, googleBooks: !!googleBooks,
      },
    };
  }

  console.log(`   ✓ confidence:${result.record.confidence} chars:${result.record.characters.length} facts:${result.record.specific_facts.length} unknowns:${result.record.unknown_fields.length}`);
  return {
    bookId,
    cachedAt: Date.now(),
    sources_found: {
      wikipedia: !!wikipedia, openLibrary: !!openLibrary, googleBooks: !!googleBooks,
    },
    source_urls: {
      wikipedia: wikipedia?.sourceUrl,
      openLibrary: openLibrary?.sourceUrl,
      googleBooks: googleBooks?.sourceUrl,
    },
    record: result.record,
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY env var required.");
    process.exit(1);
  }

  const isbns = loadIsbnsFromCatalog();
  const all = loadRecords();
  console.log(`[enrich] catalog: ${Object.keys(QUIZ_BOOKS).length} books, ISBN map: ${Object.keys(isbns).length} ids, cache: ${Object.keys(all.records).length} records`);

  if (argReportOnly) {
    printReport(all, isbns);
    return;
  }

  let toEnrich;
  if (argBook) {
    if (!QUIZ_BOOKS[argBook]) {
      console.error(`Book id "${argBook}" not in QUIZ_BOOKS.`);
      process.exit(1);
    }
    toEnrich = [argBook];
  } else {
    toEnrich = Object.keys(QUIZ_BOOKS).filter((id) =>
      argForce || isStale(all.records[id])
    );
  }
  console.log(`[enrich] enriching ${toEnrich.length} books...`);

  let i = 0;
  for (const bookId of toEnrich) {
    i++;
    const book = QUIZ_BOOKS[bookId];
    const isbn = isbns[bookId];
    console.log(`\n--- ${i}/${toEnrich.length} ---`);
    const result = await enrichOne(bookId, book, isbn);
    all.records[bookId] = result;
    all.generatedAt = new Date().toISOString();
    // Persist after every book so a crash doesn't lose work.
    saveRecords(all);
    if (i < toEnrich.length) {
      await new Promise((r) => setTimeout(r, INTER_BOOK_DELAY_MS));
    }
  }
  console.log("\n[enrich] done.");
  printReport(all, isbns);
}

function printReport(all, isbns) {
  const counts = { high: 0, medium: 0, low: 0, error: 0, missing: 0 };
  const lowOrFail = [];
  for (const id of Object.keys(QUIZ_BOOKS)) {
    const rec = all.records[id];
    if (!rec) {
      counts.missing++;
      continue;
    }
    if (rec.error) {
      counts.error++;
      lowOrFail.push({ id, status: rec.error });
      continue;
    }
    const conf = rec.record?.confidence || "low";
    counts[conf]++;
    if (conf === "low") lowOrFail.push({ id, status: "low" });
  }
  console.log("\n--- COVERAGE REPORT ---");
  console.log(`high:   ${counts.high}`);
  console.log(`medium: ${counts.medium}`);
  console.log(`low:    ${counts.low}`);
  console.log(`error:  ${counts.error}`);
  console.log(`missing:${counts.missing}`);
  if (lowOrFail.length) {
    console.log("\nLow-confidence or failed (review for V1 removal):");
    for (const { id, status } of lowOrFail) {
      const book = QUIZ_BOOKS[id];
      console.log(`  ${id} [${status}] ${book?.title} — ISBN ${isbns[id] || "none"}`);
    }
  }
}

main().catch((err) => {
  console.error("[enrich] fatal:", err);
  process.exit(1);
});
