// Multi-pass cross-validation for AI-generated quiz questions (TODO 1g).
//
// Idea: a single LLM generation pass can hallucinate plausible-but-wrong
// details. If we generate the SAME quiz pool 3 times with different
// temperatures, the *correct* questions tend to recur across runs (the
// model arrives at them from any starting point) while hallucinations
// tend to be one-offs. We keep only the questions that show up in at
// least 2 of 3 runs — the consensus pool.
//
// Algorithm:
//   1. Caller runs generation N times (typically 3) at different temps.
//   2. clusterAndExtractConsensus(generations, opts) calls Claude with
//      ALL candidate questions and asks it to group semantically
//      equivalent ones across runs (same plot point, paraphrased).
//   3. Each cluster has a `runs` count (how many distinct runs contributed
//      to it). Clusters with runs >= consensusThreshold survive.
//   4. From each surviving cluster we keep the BEST-WORDED representative
//      (Claude picks it as part of the same call).
//   5. The caller then puts the consensus pool through the existing
//      QC reviewer, so we get cross-validation AND per-question accuracy
//      scoring.
//
// Cost: ~$0.02 per book for the clustering call (Opus 4.5, ~3-5k tokens
// in, ~1-2k out). 3x generation cost is ~$0.09. Total per-book first-time
// generation: ~$0.11. Negligible at catalog scale.

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const CLUSTERING_MODEL = "claude-opus-4-5";

// Schema for the clustering call. Claude returns groups of semantically
// equivalent questions across the runs, identifying which run each came
// from so we can count consensus.
const ClusterSchema = z.object({
  clusters: z.array(
    z.object({
      // The plot beat this cluster is about, in 1-line summary form.
      // For debugging/logging only — not shipped to the client.
      topic: z
        .string()
        .describe(
          "1-line description of what plot beat or comprehension skill this question cluster tests."
        ),
      // Indexes (into the flat candidate list passed in) of the questions
      // that belong to this cluster. Same plot beat = same cluster, even
      // if worded differently.
      memberIndexes: z
        .array(z.number().int().min(0))
        .min(1)
        .describe(
          "Indexes of every candidate question that asks about the same plot beat."
        ),
      // Distinct runs (0..N-1) that contributed at least one question to
      // this cluster. consensus = runs.length.
      runs: z
        .array(z.number().int().min(0))
        .min(1)
        .describe(
          "Which generation runs contributed to this cluster (deduped). Length is the consensus count."
        ),
      // Which member is the best-worded version. Claude picks one.
      bestMemberIndex: z
        .number()
        .int()
        .min(0)
        .describe(
          "Index (from memberIndexes) of the clearest, most accurate version to ship."
        ),
    })
  ),
});

/**
 * Given multiple independent generation passes for the same book,
 * identify questions that appear across runs (consensus) and return
 * a single deduplicated, best-worded pool.
 *
 * @param {Array<Array<{q: string, options: string[], answer: number}>>} generations
 *        Outer array = one entry per run. Inner array = the questions
 *        produced by that run.
 * @param {Object} opts
 * @param {string} opts.bookTitle      — for the prompt
 * @param {string} opts.bookSummary    — canonical plot summary (the source
 *                                       of truth Claude should reason against)
 * @param {number} [opts.consensusThreshold=2]
 *        Min number of distinct runs a cluster must appear in to survive.
 * @param {number} [opts.targetPoolSize=12]
 *        Cap on how many consensus questions to keep, picked by cluster
 *        tightness (most-agreed-upon first).
 * @returns {Promise<{
 *    questions: Array<{q,options,answer}>,
 *    stats: {
 *       totalCandidates: number,
 *       clusterCount: number,
 *       survivingClusters: number,
 *       droppedAsOneOff: number,
 *    }
 * }>}
 */
export async function clusterAndExtractConsensus(generations, opts) {
  const {
    bookTitle,
    bookSummary,
    consensusThreshold = 2,
    targetPoolSize = 12,
  } = opts;

  // Flatten all candidates into a single indexed list, remembering which
  // run each came from. Claude sees them all at once and clusters across.
  const flat = [];
  for (let runIdx = 0; runIdx < generations.length; runIdx++) {
    const run = generations[runIdx] || [];
    for (const q of run) {
      flat.push({ runIdx, q });
    }
  }

  if (flat.length === 0) {
    return {
      questions: [],
      stats: {
        totalCandidates: 0,
        clusterCount: 0,
        survivingClusters: 0,
        droppedAsOneOff: 0,
      },
    };
  }

  // If we only got one run back (the others failed), there's nothing to
  // cluster against. Return that run as-is — better than failing.
  const distinctRuns = new Set(flat.map((f) => f.runIdx));
  if (distinctRuns.size < 2) {
    return {
      questions: flat.map((f) => f.q),
      stats: {
        totalCandidates: flat.length,
        clusterCount: flat.length,
        survivingClusters: flat.length,
        droppedAsOneOff: 0,
      },
    };
  }

  const formatted = flat
    .map(
      (f, i) =>
        `${i}. [run ${f.runIdx}] ${f.q.q}\n   correct: ${f.q.options[f.q.answer]}`
    )
    .join("\n\n");

  let clusters;
  try {
    const { object } = await generateObject({
      model: anthropic(CLUSTERING_MODEL),
      schema: ClusterSchema,
      system:
        "You are clustering AI-generated reading-comprehension questions. " +
        "Multiple independent runs produced questions about the same book. " +
        "Your job: group questions that test the SAME plot beat (even if " +
        "worded differently), so we can keep only the questions that " +
        "multiple runs independently arrived at.\n\n" +
        "Two questions belong in the same cluster if:\n" +
        "  - They test the same plot moment, character, or comprehension skill\n" +
        "  - A correct answer to one would imply a correct answer to the other\n" +
        "Different surface wording is OK — focus on what's being tested.\n\n" +
        "For each cluster, pick the SINGLE best-worded version to keep. " +
        "Prefer versions that:\n" +
        "  - Are clearly answerable from the canonical summary\n" +
        "  - Use simple, age-appropriate words\n" +
        "  - Have well-differentiated answer options\n\n" +
        "Every candidate index MUST belong to exactly one cluster. Do not " +
        "skip any candidates. Single-question clusters (one-offs that no " +
        "other run produced) are allowed — caller will filter them.",
      prompt:
        `Book: "${bookTitle}"\n\n` +
        `Canonical plot summary (source of truth):\n${bookSummary}\n\n` +
        `Candidate questions across ${distinctRuns.size} generation runs ` +
        `(${flat.length} total):\n\n${formatted}\n\n` +
        `Cluster these into groups by what plot beat / skill they test. ` +
        `Return one entry per cluster. Include "runs" = the deduped list of ` +
        `run indexes that contributed (this is what tells us the consensus ` +
        `count). Pick a bestMemberIndex from each cluster's memberIndexes.`,
    });
    clusters = object.clusters || [];
  } catch (err) {
    // Clustering failed — degrade gracefully. Return the union of all runs
    // (let QC pass downstream filter accuracy). Better than failing the
    // whole quiz generation.
    console.warn(
      "[quiz_clustering_failed]",
      bookTitle,
      String(err?.message || err)
    );
    return {
      questions: flat.map((f) => f.q),
      stats: {
        totalCandidates: flat.length,
        clusterCount: 0,
        survivingClusters: 0,
        droppedAsOneOff: 0,
      },
    };
  }

  // Filter clusters by consensus threshold, then sort by tightness
  // (most-agreed-upon first → biggest member count and most runs first).
  const survived = clusters
    .filter((c) => (c.runs?.length || 0) >= consensusThreshold)
    .sort((a, b) => {
      // Primary: number of distinct runs (consensus strength).
      const runDiff = (b.runs?.length || 0) - (a.runs?.length || 0);
      if (runDiff !== 0) return runDiff;
      // Tiebreak: total members (how many candidates agreed).
      return (b.memberIndexes?.length || 0) - (a.memberIndexes?.length || 0);
    })
    .slice(0, targetPoolSize);

  // Pull the best-worded representative from each surviving cluster.
  const consensusQuestions = [];
  for (const c of survived) {
    const idx = Number(c.bestMemberIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= flat.length) continue;
    consensusQuestions.push(flat[idx].q);
  }

  return {
    questions: consensusQuestions,
    stats: {
      totalCandidates: flat.length,
      clusterCount: clusters.length,
      survivingClusters: survived.length,
      droppedAsOneOff: clusters.length - survived.length,
    },
  };
}
