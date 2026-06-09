# Book Summary Ruleset

Rules for producing book summaries that the quiz generator can safely use to write at least 12 fair, answerable questions per book. Follow this for every book.

The reference example of a summary built to this standard is **`e07-one-fish-two-fish-red-fish-blue-fish-v2.md`** in this folder. When in doubt, match its shape and depth.

---

## 1. The one rule that overrides everything

**Every fact in the summary must appear in the book itself.**

A child reading the book must be able to answer every question the summary could generate. If a detail is not on the page, it does not go in the summary — no matter how often the internet repeats it.

This means:
- Character names: only if the book names them on the page.
- Relationships ("brother and sister", "best friends"): only if the book states or directly shows them.
- Numbers, colours, sounds: only if the book gives the specific value.
- Order of events: only what the book actually shows.

---

## 2. Sources

### Banned (do not read, do not cite, do not "lean on")

- **`lib/book-records.json`** — the project's auto-enriched JSON is unreliable for this purpose. It contains fan-wiki content. Treat as non-existent when writing summaries.
- **Fan wikis** (e.g. `*.fandom.com`, character wikis).
- **Study guides** (GradeSaver, SparkNotes, CliffsNotes, LitCharts, eNotes, Shmoop).
- **TVTropes**, **Wikipedia plot sections**, generic encyclopedia plot recaps.
- **Quiz / trivia sites** that derive their facts from the above.
- **AI-generated review or summary sites.**

### Preferred (in order of trust)

1. **Pages carrying the actual book text** — verbatim passages, "look inside" excerpts, read-aloud transcripts that quote the book directly.
2. **Scans / Internet Archive** copies of the book.
3. **Publisher's own page** for short, structural metadata (title, year, page count) — not for plot.
4. **Your own model knowledge of the actual book text**, used as a cross-check against the above. Never as the sole source for a specific claim.

Always verify each specific fact against at least one primary-text source. Cross-checking a second primary-text source is strongly preferred for anything quotable (named characters, exact numbers, signature lines).

---

## 3. Workflow

For every book:

1. **Do not read** `lib/book-records.json`. Pretend it isn't there.
2. **WebSearch** for primary text. Useful query shapes:
   - `"<exact title>" <author> full text`
   - `"<exact title>" "<a memorable line you already know>"`
   - `"<exact title>" excerpt read aloud transcript`
3. **WebFetch** the most primary-text-looking 1–2 results.
4. Ask the fetched page **targeted factual questions**, not "summarize this." Use this exact instruction shape in the WebFetch prompt:

   > Looking ONLY at the verbatim book text on this page (ignore commentary), answer the following. If the page text does not contain the answer, say "not stated on this page". Do not bring in outside knowledge.

   Then list 10–20 numbered, specific questions: named characters, named places, numbers, colours, key objects, the opening line, the closing line, the order of events, etc.
5. If WebFetch refuses to reproduce text on copyright grounds, that's fine — keep the targeted-question format. The fetched model will still answer factual questions without reproducing the text.
6. **Cross-check anything important** against a second source before writing it down.
7. **Discard anything that isn't on a primary-text page.** It does not go in the summary, even if you "remember" it.
8. Write the summary using the structure in §4.
9. Before saving, run the verification checklist in §5.
10. **Save the file**; do not write a "Sources" section into the MD itself. Sources stay in chat / logs only.

---

## 4. File structure

### File location & naming

- Location: `docs/book-summaries/`
- Filename: `<catalog-id>-<kebab-title>.md` (e.g. `e07-one-fish-two-fish-red-fish-blue-fish.md`).
- Catalog id comes from `docs/catalog.json` / `lib/books.js`.

### Required sections (in this order)

1. **Title** — `# <Book Title>` (use the canonical title from `docs/catalog.json`).
2. **Metadata block** — author, first published year, grade band, format. Three to five lines, no source URLs.
3. **Premise** — 1–2 paragraphs in plain prose. What the book is about, no spoilers withheld.
4. **Setting** — where and when. Be specific if the book is specific; be vague if the book is vague.
5. **Characters** — only those named in the text. One bullet per character, role + a defining trait. If the narrator is unnamed, say so explicitly so the quiz generator doesn't invent a name.
6. **Plot in order** *(narrative books)* OR **What happens in the book** *(vignette / rhyming books)* — numbered or bulleted beats, in the order the book presents them. Cover the whole book — beginning, middle, end. Don't withhold the ending.
7. **Key objects and props** — items that drive the plot or that a reader would notice (a specific tool, a piece of clothing, a vehicle, a colour-coded object).
8. **Themes and ideas** — bulleted, short. Themes the book actually develops, not generic ones.
9. **Tone and style** — one short paragraph. Vocabulary level, illustration style, rhythm, anything that defines reading experience.
10. **Quick fact bank** — the most important section for the quiz generator. See §4.1.

### 4.1 The Quick fact bank

This is what the quiz generator should rely on most. Build it well.

- **Minimum 15 single-fact bullets**, targeting ~20+ for an average book.
- Every bullet is a **single, verifiable, paraphrased fact** from the book.
- One specific noun, number, name, colour, or quoted short phrase per bullet — not a sentence summarising a scene.
- Use **bold** for the answer-worthy word(s) in each bullet so a quiz writer can scan it quickly.
- Spread coverage across: who, where, when (in book), what, how, how many, in what order, opposites, colours, sounds, named objects, signature lines.

Examples of good fact-bank bullets (from the v2 reference summary):
- The narrator's Wump has **one hump**; **Mr. Gump's** Wump has **seven humps**.
- A **mouse** cuts the **phone wire** when someone is trying to call **Joe**.
- The bedtime pet at the end is **Zeep**.

Examples of bad fact-bank bullets:
- "The narrator goes on an adventure." *(too vague — not quizzable)*
- "Peter and his sisters love each other." *(not stated as a fact in the book)*
- "Set in 19th-century England." *(meta / not in the book itself)*

---

## 5. Verification checklist (before saving)

For each summary, confirm:

- [ ] No content sourced from `lib/book-records.json`.
- [ ] No content sourced from fan wikis, study guides, TVTropes, or quiz sites.
- [ ] At least one primary-text source was checked; ideally two.
- [ ] Every named character is named on the page in the book.
- [ ] Every number (humps, fingers, ages, days) is verified against a primary-text source.
- [ ] Every colour and named object is verified.
- [ ] The opening and closing of the book are described accurately.
- [ ] The ending is not withheld.
- [ ] Quick fact bank has **at least 15 quizzable single-fact bullets**.
- [ ] No direct quotations longer than ~25 words (copyright caution).
- [ ] No URLs, "sources", or citations inside the MD.
- [ ] No emojis.
- [ ] No mention of Claude, AI, or the writing process.
- [ ] No inferred relationships ("brother and sister", "best friends") unless the book states them.

If any box is unchecked, fix before saving.

---

## 6. Anti-patterns (do not do these)

These are the specific mistakes the v1 of the reference summary made:

- **Importing names from JSON enrichment without primary-text verification.** "Jay and Kay" were in the JSON but not in the book.
- **Inferring family structure** from secondary sources. The book doesn't say the narrators are brother and sister.
- **Inventing visual detail** that "feels right." v1 wrote "the old fish wears glasses" — the book has no such line.
- **Using vague descriptors when the book is specific.** v1 said "a hat"; the book says "a yellow hat." Specifics drive better quiz questions.
- **Skipping cross-checks** on quotable signature lines (opening line, closing line, rhyming pairs). These are exactly the lines a quiz will draw from.

---

## 7. Output format reminders

- File extension: `.md`.
- No frontmatter (no YAML block).
- One H1, then H2/H3 as needed.
- Bullets are `-`, not `*`.
- Bold the answer-worthy parts of each fact-bank bullet.
- Keep the whole file under ~5–8 KB. Quality of facts beats volume of prose.

---

## 8. When you're done

- Save the file to `docs/book-summaries/`.
- In chat, briefly report: (1) which primary-text source(s) you used, (2) any facts you removed because you could not verify them, (3) any facts the book deliberately leaves unanswered (so the quiz generator avoids questions about them).
- Then prompt for the next book.
