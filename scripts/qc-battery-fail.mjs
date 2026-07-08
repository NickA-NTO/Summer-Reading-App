// Live battery: terminal-fail path on one book.
// start -> fail quiz x2 -> retell with weak spoken answers (real audio turns,
// synthesized) -> expect 0 XP terminal -> verify durable done + 409 guard.
import { readFileSync } from "node:fs";

const BOOK = process.argv[2] || "k07";
const token = readFileSync(".qc-cookie", "utf8").trim();
const env = Object.fromEntries(readFileSync(".env.repair", "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const BASE = "https://reading-spine.vercel.app";
const H = { cookie: `rs_session=${token}`, "content-type": "application/json" };
const jj = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t.slice(0, 300); } };
const get = async (p) => { const r = await fetch(BASE + p, { headers: H }); return { s: r.status, b: await jj(r) }; };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) }); return { s: r.status, b: await jj(r) }; };

const bank = JSON.parse(readFileSync(`docs/book-questions/${BOOK}.json`, "utf8"));
const wrongByQ = new Map(bank.questions.map((q) => [q.q, (q.answer + 1) % 4]));

// weak-but-heard retell lines (rubric should land ~1-3/12: mentions the book
// vaguely, recalls nothing concrete -> genuine attempt, fails the bar)
const JUNK_LINES = [
  "Um, it was about a mouse, I think. I don't really remember what happened.",
  "I don't know. Maybe he ate something? I forgot the rest of the story.",
  "I just remember the mouse. That's all I can tell you about it.",
  "I'm not sure. I don't remember anything else.",
];
async function synthJunk(text) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "nova", input: text, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error("synth failed " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// 1. start + fail twice
console.log("start →", JSON.stringify((await post("/api/activity", { kind: "start", bookId: BOOK })).b).slice(0, 120));
const quiz = await get(`/api/quiz?bookId=${BOOK}`);
if (!quiz.b.questions) { console.log("ABORT quiz fetch", JSON.stringify(quiz.b).slice(0, 200)); process.exit(1); }
const mkSlate = (qs) => qs.slice(0, 5).map((q, i) => ({ idx: i, chosen: wrongByQ.get(q.q), qText: q.q, answerToken: q.answerToken }));
const f1 = await post("/api/activity", { kind: "quiz_submit", bookId: BOOK, attemptNum: 1, submissionId: "qcf1_" + Date.now(), answers: mkSlate(quiz.b.questions), streakDays: 0 });
console.log("fail1 →", f1.s, JSON.stringify({ passed: f1.b.passed, score: f1.b.score, outcome: f1.b.quizOutcome, attempt: f1.b.attemptNum }));
const quiz2 = await get(`/api/quiz?bookId=${BOOK}`);
const f2 = await post("/api/activity", { kind: "quiz_submit", bookId: BOOK, attemptNum: 2, submissionId: "qcf2_" + Date.now(), answers: mkSlate(quiz2.b.questions), streakDays: 0 });
console.log("fail2 →", f2.s, JSON.stringify({ passed: f2.b.passed, score: f2.b.score, outcome: f2.b.quizOutcome, retellRequired: f2.b.retellRequired }));

// 2. retell with weak audio turns
const st = await post("/api/tutor?action=start", { bookId: BOOK });
console.log("tutorStart →", st.s, JSON.stringify({ sid: !!st.b.sessionId, q: st.b.questionCount, msg: (st.b.tutorMessage || "").slice(0, 60) }));
if (!st.b.sessionId) process.exit(1);
const sid = encodeURIComponent(st.b.sessionId);
let done = false;
for (let i = 0; i < 8 && !done; i++) {
  const audio = await synthJunk(JUNK_LINES[i % JUNK_LINES.length]);
  const r = await fetch(`${BASE}/api/tutor?action=turn&sessionId=${sid}`, {
    method: "POST", headers: { cookie: H.cookie, "content-type": "audio/mpeg" }, body: audio,
  });
  const b = await jj(r);
  done = !!b.done || !!b.readyToGrade;
  console.log(`turn${i + 1} →`, r.status, JSON.stringify({ heard: (b.transcript || "").slice(0, 50), done: b.done, ready: b.readyToGrade, msg: (b.tutorMessage || "").slice(0, 50), err: b.error }));
  if (r.status >= 400) break;
}

// 3. grade
const fin = await post(`/api/tutor?action=grade&sessionId=${sid}`, {});
console.log("grade →", fin.s, JSON.stringify({ passed: fin.b.passed, points: fin.b.points, recorded: fin.b.recorded, retryable: fin.b.retryable, rubric: fin.b.gradeResult, held: fin.b.held }).slice(0, 400));

// 4. durability + guard
const me = await get("/api/auth/me");
console.log("doneState →", JSON.stringify({ done: (me.b.doneBookIds || []).includes(BOOK), cr: me.b.currentlyReading?.bookId || null }));
await post("/api/activity", { kind: "start", bookId: BOOK });
const again = await post("/api/tutor?action=start", { bookId: BOOK });
console.log("retellDoneGuard →", again.s, JSON.stringify(again.b).slice(0, 150));
