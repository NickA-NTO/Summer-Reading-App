// Live QC driver. Usage: node scripts/qc-live.mjs <step> [args...]
// Cookie read from .qc-cookie (gitignored file, single line).
import { readFileSync } from "node:fs";

const token = readFileSync(".qc-cookie", "utf8").trim();
const BASE = "https://reading-spine.vercel.app";
const H = { cookie: `rs_session=${token}` };

export async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text.slice(0, 400); }
  return { status: r.status, body: j };
}
export async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text.slice(0, 400); }
  return { status: r.status, body: j };
}

const [step, ...args] = process.argv.slice(2);

if (step === "me") {
  const me = await get("/api/auth/me");
  const b = me.body || {};
  console.log(JSON.stringify({
    status: me.status,
    email: b.email || b.session?.email,
    isAdmin: b.isAdmin,
    studentMode: b.studentMode,
    grade: b.grade,
    ageGrade: b.ageGrade,
    visibleTracks: b.visibleTracks,
    currentlyReading: b.currentlyReading,
    doneBookIds: b.doneBookIds,
    xp: b.xp ?? b.points ?? b.totalPoints,
  }, null, 2));
  // show remaining top-level keys so we know the shape
  console.log("keys:", Object.keys(b).join(","));
} else if (step === "start") {
  console.log(JSON.stringify(await post("/api/activity", { action: "reading_start", bookId: args[0] }), null, 2));
} else if (step === "quizfetch") {
  const q = await get(`/api/quiz?bookId=${args[0]}`);
  if (q.body?.questions) {
    console.log(JSON.stringify({
      status: q.status, poolSize: q.body.poolSize, bankVersion: q.body.bankVersion,
      source: q.body.source, adminMode: q.body.adminMode,
      rawAnswerLeak: q.body.questions.some((x) => "answer" in x),
      allTokens: q.body.questions.every((x) => x.answerToken?.length > 10),
      firstQ: q.body.questions[0].q,
    }, null, 2));
  } else console.log(JSON.stringify(q, null, 2));
} else if (step === "raw") {
  // raw GET/POST passthrough for ad-hoc probes
  if (args[0] === "POST") console.log(JSON.stringify(await post(args[1], JSON.parse(args[2] || "{}")), null, 2));
  else console.log(JSON.stringify(await get(args[0]), null, 2));
} else {
  console.log("steps: me | start <bookId> | quizfetch <bookId> | raw <path>|raw POST <path> <json>");
}
