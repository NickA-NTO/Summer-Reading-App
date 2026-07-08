// Live battery: happy path on one book.
// start -> quiz fetch -> malformed slate (expect 400, no attempt burn)
// -> passing submit (expect p1) -> retell finalize (noDevice) -> XP/done
// -> tutor start again (expect 409 retell_already_done)
import { readFileSync } from "node:fs";

const BOOK = process.argv[2] || "k03";
const token = readFileSync(".qc-cookie", "utf8").trim();
const BASE = "https://reading-spine.vercel.app";
const H = { cookie: `rs_session=${token}`, "content-type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t.slice(0, 300); } };
const get = async (p) => { const r = await fetch(BASE + p, { headers: H }); return { s: r.status, b: await j(r) }; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) }); return { s: r.status, b: await j(r) }; };
const bank = JSON.parse(readFileSync(`docs/book-questions/${BOOK}.json`, "utf8"));
const correctByQ = new Map(bank.questions.map((q) => [q.q, q.answer]));
const out = [];
const step = (name, v) => { out.push([name, v]); console.log(name, "→", JSON.stringify(v).slice(0, 300)); };

// 1. start reading
step("start", await post("/api/activity", { kind: "start", bookId: BOOK }));

// 2. fetch quiz
const quiz = await get(`/api/quiz?bookId=${BOOK}`);
step("quizfetch", {
  s: quiz.s, poolSize: quiz.b.poolSize, bankVersion: quiz.b.bankVersion,
  rawAnswerLeak: (quiz.b.questions || []).some((x) => "answer" in x),
  allTokens: (quiz.b.questions || []).every((x) => (x.answerToken || "").length > 10),
});
if (!quiz.b.questions) { console.log("ABORT — no questions"); process.exit(1); }
const qs = quiz.b.questions;

const slate = qs.slice(0, 5).map((q, i) => ({
  idx: i, chosen: correctByQ.get(q.q), qText: q.q, answerToken: q.answerToken,
}));
if (slate.some((a) => !Number.isInteger(a.chosen))) { console.log("ABORT — bank/server text mismatch"); process.exit(1); }
const subId = "qc_" + Date.now().toString(36);

// 3. malformed slate: only 3 answers — expect 400 invalid_answers, pre-INCR
step("malformed", await post("/api/activity", {
  kind: "quiz_submit", bookId: BOOK, attemptNum: 1,
  submissionId: subId + "_bad", answers: slate.slice(0, 3), streakDays: 0,
}));

// 3b. malformed entry: chosen out of range — expect 400 invalid_answer_entry
step("badEntry", await post("/api/activity", {
  kind: "quiz_submit", bookId: BOOK, attemptNum: 1,
  submissionId: subId + "_bad2",
  answers: slate.map((a) => ({ ...a, chosen: 7 })), streakDays: 0,
}));

// 4. real passing submit — expect passed:true, quizOutcome p1
//    (p1 proves the two 400s above did NOT burn attempts)
step("pass", await post("/api/activity", {
  kind: "quiz_submit", bookId: BOOK, attemptNum: 1,
  submissionId: subId, answers: slate, streakDays: 0,
}));

// 5. retell finalize via the no-device path (banks quiz-tier XP)
const tStart = await post("/api/tutor", { action: "start", bookId: BOOK });
step("tutorStart", { s: tStart.s, keys: Object.keys(tStart.b || {}).join(","), err: tStart.b?.error });
const fin = await post("/api/tutor", { action: "finalize", bookId: BOOK, sessionId: tStart.b?.sessionId, noDevice: 1 });
step("finalizeNoDevice", { s: fin.s, passed: fin.b?.passed, points: fin.b?.points, recorded: fin.b?.recorded, held: fin.b?.held, err: fin.b?.error, keys: Object.keys(fin.b || {}).join(",") });

// 6. done-state + guard
const me = await get("/api/auth/me");
step("doneState", { done: (me.b.doneBookIds || []).includes(BOOK), currentlyReading: me.b.currentlyReading });
const again = await post("/api/tutor", { action: "start", bookId: BOOK });
step("retellDoneGuard", { s: again.s, err: again.b?.error, msg: again.b?.message });
