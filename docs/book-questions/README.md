# Book question banks

This directory holds **pre-authored quiz questions** for each book. The
app reads from here at startup and serves these questions verbatim — no
LLM runs at quiz time. One JSON file per book.

## Why static?

After many rounds of LLM-generated questions producing hallucinations
(invented characters, ungrounded premises, distractors that gave away
the answer by grammar), we moved authoring entirely **out of the
production pipeline**. The external authoring tool produces a JSON file,
a human reviews it, and it lands in this directory. The runtime app
never invents anything.

## File format

Filename: `<bookId>.json` (matches the `.md` summary's bookId prefix,
e.g. `e07.json` for One Fish Two Fish Red Fish Blue Fish).

```json
{
  "bookId": "e07",
  "version": 1,
  "questions": [
    {
      "q": "What does the Yink drink?",
      "options": ["Pink ink", "Pink milk", "Pink juice", "Pink water"],
      "answer": 0
    },
    {
      "q": "Who has a hook on his head?",
      "options": ["The Wump", "The Yink", "The Nook", "The Zans"],
      "answer": 2
    }
  ]
}
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `bookId` | yes | Two-three letter prefix matching the catalog id (e.g. `e07`, `a01`, `k02`). |
| `version` | yes | Integer. Increment when the bank changes; the app invalidates the cached pool on version change. |
| `questions` | yes | Array. Minimum 6 to serve a quiz (5/attempt + 1 spare); 12 is the recommended pool size. |
| `questions[].q` | yes | The question text. Under 18 words. Use vocabulary the AGE grade understands (no "narrator" / "protagonist" / "theme" for PK–G1 — say "the person telling the story" instead). |
| `questions[].options` | yes | Exactly 4 strings. All four must share the same grammatical form (same article / determiner / number). Distractors must come from content actually in the book's summary. |
| `questions[].answer` | yes | Integer 0–3 indexing into `options`. |

## Rules every question must follow

These are enforced by the app at load time. A file that fails any rule
is rejected at startup with a logged error, and the book becomes
unavailable until the file is fixed:

1. **Exactly 4 options** per question.
2. **`answer` is in [0, 3]**.
3. **All four options share the same leading word form** (no 3-vs-1
   determiner mismatch like "A wagon / A scooter / A car / His bike").
4. **No exclusionary phrasing** in the question — no "besides",
   "except", "not", "never", "doesn't", etc. K–2 readers can't reliably
   parse negation.
5. **No self-referential distractors** — if the question asks about a
   "fish", the distractors cannot include "fish" as their main noun.
6. **Minimum 6 questions per book**, ideally 12.

## Authoring workflow

1. External authoring agent reads `docs/book-summaries/<bookId>-*.md`.
2. Generates `docs/book-questions/<bookId>.json` following this format.
3. Human reviews the file (open it, read every question, verify each
   answer is correct + each distractor is plausible).
4. Commit + push. The app picks up the new file on next deploy.
5. To revise: edit the file, bump `version`, commit, push. Pool cache
   in Redis invalidates because the version is part of the cache key.

## Why JSON not Markdown

- Programmatic to write (the external agent emits structured data).
- Easy to validate at load time.
- Doesn't pollute the human-readable summary files.
- Trivial to diff in PRs.

## What the app does NOT do

- It does NOT call an LLM at quiz time.
- It does NOT cross-validate against the summary at quiz time (the
  external agent is responsible for that during authoring).
- It does NOT shuffle questions on the server — every kid sees the
  same pool. The client picks 5 of 12 randomly per attempt and
  shuffles the option order per question.
