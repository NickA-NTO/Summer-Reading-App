# scripts/ — local authoring tools

These scripts run OUTSIDE the deployed app. Vercel doesn't execute
them. They're for the local quiz-bank authoring workflow.

## Prerequisites

```bash
npm install @anthropic-ai/sdk    # if not already in node_modules
```

Set your Anthropic API key in the environment before running anything
that hits Claude:

```bash
# Mac/Linux
export ANTHROPIC_API_KEY="sk-ant-..."

# Windows PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

## author-quiz.js — generate a draft bank

Reads `docs/book-summaries/<id>-*.md` and writes
`docs/book-questions/<id>.json`.

```bash
node scripts/author-quiz.js --book e07
node scripts/author-quiz.js --book a01 --overwrite   # replace existing
```

The script enforces the full QC checklist in its system prompt. The
output is still a DRAFT — always run qc-quiz.js next.

Cost: ~$0.20–0.50 per book in Anthropic credits. Single call to
claude-opus-4-5.

## qc-quiz.js — validate a bank

Runs deterministic checks (parallelism, telegraphing, source
grounding, self-referential distractors, age-vocab, exclusionary
phrasing, length). Optionally runs an LLM second-opinion pass.

```bash
# Deterministic only (free, fast)
node scripts/qc-quiz.js --book e07

# Deterministic + LLM review (costs ~$0.10, ~30s)
node scripts/qc-quiz.js --book e07 --llm
```

Exit code 0 = pass. Non-zero = fail with per-question issues
printed. Don't commit a bank that doesn't pass.

## Recommended workflow per book

```bash
# 1. Write the summary by hand
$EDITOR docs/book-summaries/e07-one-fish-two-fish-red-fish-blue-fish.md

# 2. Generate draft questions
node scripts/author-quiz.js --book e07

# 3. Validate
node scripts/qc-quiz.js --book e07 --llm

# 4. If validation fails, either fix manually or regenerate:
node scripts/author-quiz.js --book e07 --overwrite
node scripts/qc-quiz.js --book e07 --llm

# 5. Open the .json, read every question one final time
$EDITOR docs/book-questions/e07.json

# 6. Bump version field if editing existing content

# 7. Commit + push
git add docs/book-questions/e07.json
git commit -m "feat: e07 question bank v2"
git push
```

## Why two separate scripts?

- author-quiz.js is the GENERATOR. It produces content.
- qc-quiz.js is the JUDGE. It validates content against the rules.
- Keeping them separate means the QC agent doesn't trust the
  generator's claim that the output is rule-compliant. The QC
  agent reads the output cold and runs the checks again.
- The deterministic checks in qc-quiz.js are the same ones that
  run in api/quiz.js at server module-init. If qc-quiz.js passes,
  the runtime won't reject the bank.
