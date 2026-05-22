# 1h Archive.org RAG experiment — findings

**Question:** Would feeding Claude the actual public-domain text of a book
produce better/cleaner comprehension questions than our hand-written summary?

**Method:** Generated a 12-question pool for *The Tale of Peter Rabbit*
(Beatrix Potter, 1902 — public domain, Project Gutenberg #14838) twice at the
same temperature (0.4) with Opus 4.5: once from our 808-character hand-written
summary, once from the cleaned 5,548-character full text.

Raw output: `scripts/rag-experiment-output.txt` (side-by-side question pools).

---

## Verdict: full-text generation is meaningfully better. Ship it for PD books.

Neither pool hallucinated — both stayed grounded. The difference is **depth of
reading test**.

### Where full text wins
- **Sand-bank under a fir-tree** (Q1) — distinctive setting detail completely
  absent from the summary. Kids who only skim won't catch this.
- **Lost shoes among the cabbages / among the potatoes** (Q5) — specific
  location detail; summary just says "lost his blue jacket and shoes."
- **Gooseberry net + large buttons** (Q7) — the *mechanism* of how Peter got
  caught. Summary omits the netting entirely.
- **Sneezing → Mr. McGregor catching him** (Q9) — explicit cause-and-effect
  chain from the text.
- **Benjamin Bunny** (Q10) — full text introduces Peter's cousin by name;
  summary skips him entirely.
- Distractors are story-grounded ("nest in the woods", "burrow by a pond")
  rather than generic ("It was too far away") — they read like other things
  *from this kind of book*.

### Where the summary pool was weaker
- **Q1 "How many bunny children?"** is a counting question solvable from a
  one-sentence list of names. Doesn't test reading at all.
- Several questions felt like Wikipedia-compression recall ("what did Peter
  eat? lettuces, beans, and radishes") — true, but shallow.
- No question touched McGregor's tool-shed scene, the mouse with the pea, the
  white cat, or any of the second-half adventure beats — because the summary
  smooths over them.

### Net effect on proof-of-reading
Summary pool tests *"did the kid see a synopsis?"*
Full-text pool tests *"did the kid actually read the book?"*

For Reading Spine that distinction is the whole point.

---

## Cost / latency check

| | Summary pool | Full-text pool |
|---|---|---|
| Source size | 808 chars | 5,548 chars |
| Token cost | ~2k in / 1k out | ~6k in / 1k out |
| Wall time | ~6s | ~9s |
| $ per generation pass (Opus 4.5) | ~$0.025 | ~$0.04 |

Full-text is ~60% more expensive per call but still trivially cheap at catalog
scale. Multi-pass cross-validation (1g) costs 3× the generation pass + 1×
clustering, so the catalog-wide regeneration bill goes from ~$0.12/book to
~$0.20/book. Across all eligible PD books (~10 of our 37), that's $2 in
one-off costs, then cached.

---

## What "PD book" means in our catalog

From the TODO §1h source-mapping pass, the PD-confirmed books in our catalog:

| Book ID | Title | Status |
|---|---|---|
| a01 | The Tale of Peter Rabbit (1902)      | ✅ verified — used in this test |
| a11 | The Ugly Duckling (1843)             | PD, fetchable from Gutenberg |
| b03 | The Velveteen Rabbit (1922)          | PD, fetchable |
| k04 | Goldilocks (folk tale)               | PD; multiple editions |
| k05 | Mother Goose's Nursery Rhymes        | PD; collection text varies |
| u01-u09 | Usborne classics (folk-tale retellings) | Source stories are PD; we use Usborne summaries today, could swap to PD-text versions |

Roughly **a third of our catalog** could swap from hand-written summary to
real book text. The rest stay summary-based until we have a fair-use
position on copyrighted text.

---

## Next steps if we want to ship this

Out of scope for this prototype — explicit TODO before any rollout:

1. `lib/book-text.js` — exports `{ [bookId]: fullText }` for PD books. Pre-
   fetched at build time and committed (small, ~5kB each), so production
   never hits Project Gutenberg live.
2. `api/quiz.js` — if `getBookText(bookId)` returns text, pass it as the
   source-of-truth instead of `QUIZ_BOOKS[bookId].summary`. Bump
   `SCHEMA_VERSION` to invalidate old caches.
3. Keep multi-pass cross-validation (1g) on for full-text generations too —
   the consensus filter is independent of source type.
4. Fair-use review with Alpha admin / counsel before fetching anything
   beyond Gutenberg (no Archive.org borrow APIs, no in-copyright scraping).

No production code changed in this experiment. We've answered the question
"would it improve quality?" — yes, materially. Decision to ship is yours.
