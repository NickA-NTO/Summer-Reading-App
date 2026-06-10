#!/usr/bin/env node
// CI gate (#30) — run the DETERMINISTIC QC checks over every shipped
// question bank and fail the build if any bank fails. This is the
// automated replacement for the human "eyeball every quiz" gate (#84):
// no bank reaches production without passing the same checks the
// offline authoring pipeline runs.
//
// Deterministic only — no --llm, so CI needs no ANTHROPIC_API_KEY and
// runs in seconds. The LLM second-opinion pass stays a local authoring
// step. Exits 0 only if ALL banks pass.
//
// Usage: node scripts/qc-all.js   (or: npm run qc)

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.join(process.cwd(), "docs", "book-questions");
if (!fs.existsSync(DIR)) {
  console.error(`[qc-all] no ${DIR} — nothing to check.`);
  process.exit(0);
}
const ids = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

if (ids.length === 0) {
  console.error("[qc-all] no question banks found.");
  process.exit(0);
}

console.log(`[qc-all] validating ${ids.length} bank(s) (deterministic checks)…\n`);
const failed = [];
for (const id of ids) {
  const r = spawnSync("node", ["scripts/qc-quiz.js", "--book", id], {
    encoding: "utf-8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  // qc-quiz exits non-zero on failure; double-check the FAILED marker
  // in case of an unexpected exit code.
  const ok = r.status === 0 && !/\bFAILED\b/.test(out);
  if (ok) {
    console.log(`  ✓ ${id}`);
  } else {
    failed.push(id);
    console.log(`  ✗ ${id}`);
    // Surface the per-question issue lines for the CI log.
    out
      .split(/\r?\n/)
      .filter((l) => /^\s*(✗|→)/.test(l))
      .forEach((l) => console.log(`      ${l.trim()}`));
  }
}

console.log("");
if (failed.length > 0) {
  console.error(`[qc-all] FAILED — ${failed.length} bank(s) need fixes: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`[qc-all] PASS — all ${ids.length} banks clean.`);
process.exit(0);
