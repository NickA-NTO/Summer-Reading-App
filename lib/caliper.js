// Caliper Analytics event builders for TimeBack integration (TODO 1e).
//
// TimeBack requires a single Caliper v1.2 **ActivityEvent** per completed
// activity, using the TimeBack profile types — NOT the generic
// AssessmentEvent + GradeEvent pair we emitted previously. The required
// shape (per TimeBack) is:
//
//   {
//     "@context": "http://purl.imsglobal.org/ctx/caliper/v1p2",
//     "id": "urn:uuid:<v5>",
//     "type": "ActivityEvent",
//     "profile": "TimebackProfile",
//     "action": "Completed",
//     "actor":  { id: <oneroster user URL>, type: "TimebackUser", email },
//     "object": { id, type: "TimebackActivityContext", subject: "Reading",
//                 app: { name }, activity: { name }, course: { id, name },
//                 process: true },
//     "eventTime": <iso>,
//     "generated": { id, type: "TimebackActivityMetricsCollection",
//                    items: [{type,value}...], attempt, extensions }
//   }
//
// IDENTITY (runtime data, NOT fabricated here):
//   - actor.id needs the student's OneRoster sourcedId →
//       <ONEROSTER_BASE>/users/<sourcedId>. Pass it as `onerosterUserId`.
//       Until we have it, we fall back to mailto:<email> so the event is
//       still resolvable by email — never a fake sourcedId.
//   - course.id needs the OneRoster course sourcedId for the student's grade.
//       Configure via env TIMEBACK_COURSE_MAP (JSON {grade: sourcedId}). The
//       course NAME ("Alpha Summer Reading K") is always emitted; course.id
//       is added only when a real sourcedId is configured.
//
// Idempotency: each event's `id` is a UUID v5 over (kind, email, bookId,
//   attemptNum) so retries don't double-credit.
//
// Inline UUID v5 (RFC 4122 §4.3) — pure-stdlib crypto, no new dependency.

import { createHash } from "node:crypto";

// Stable namespace for Reading Spine's deterministic UUIDs. Random v4 generated
// once, frozen here forever — DON'T change it without a migration plan, or
// every previous event's idempotency key shifts.
const RS_NAMESPACE = "f7f4e2d6-9c0a-4a32-b9a8-7f2c84e8c1ab";

function parseUuid(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
function formatUuid(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

/**
 * RFC 4122 UUID v5 (name-based, SHA-1). Deterministic — same (namespace, name)
 * always produces the same UUID. We use this for event idempotency.
 */
export function uuidv5(name, namespace = RS_NAMESPACE) {
  const ns = parseUuid(namespace);
  const h = createHash("sha1");
  h.update(ns);
  h.update(typeof name === "string" ? Buffer.from(name, "utf8") : name);
  const digest = h.digest();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = digest[i];
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}

const CALIPER_CONTEXT = "http://purl.imsglobal.org/ctx/caliper/v1p2";
const APP_NAME = "Alpha Summer Reading";
export const RETELL_MAX_SCORE = 12; // 4 rubric axes × 0-3

// The app's public base — also the Caliper `sensor` and the object/metrics id
// prefix. Override via env; defaults to our public deployment.
function edAppId() {
  return (
    process.env.TIMEBACK_EDAPP_ID ||
    process.env.PUBLIC_BASE_URL ||
    "https://reading-spine.vercel.app"
  ).replace(/\/+$/, "");
}

// OneRoster rostering base for actor.id + course.id URLs. TimeBack requires
// these to be full OneRoster URLs (not urn:uuid). Override via env.
function onerosterBase() {
  return (
    process.env.TIMEBACK_ONEROSTER_BASE ||
    "https://api.alpha-1edtech.ai/ims/oneroster/rostering/v1p2"
  ).replace(/\/+$/, "");
}

// Grade → OneRoster course sourcedId, configured via env JSON:
//   TIMEBACK_COURSE_MAP={"K":"<sourcedId>","1":"<sourcedId>",...}
// Parsed once. Until configured, course.id is omitted (we never fabricate a
// sourcedId); the course NAME is still emitted.
let _courseMap;
function courseMap() {
  if (_courseMap !== undefined) return _courseMap;
  try {
    _courseMap = JSON.parse(process.env.TIMEBACK_COURSE_MAP || "{}") || {};
  } catch {
    _courseMap = {};
  }
  return _courseMap;
}

// Default OneRoster course sourcedId. Every Reading Spine event is attributed
// to this course so course.id is ALWAYS present, unless overridden by an
// explicit courseId param or a per-grade TIMEBACK_COURSE_MAP entry. Env
// TIMEBACK_COURSE_ID can change it without a redeploy.
const DEFAULT_COURSE_SOURCED_ID =
  process.env.TIMEBACK_COURSE_ID || "9e1929be-a5bf-4681-a6a1-24e4c4a691cf";

function gradeLabel(grade) {
  const g = String(grade ?? "").trim();
  return g || "K";
}

/**
 * TimebackUser actor. `id` is the OneRoster user URL when we have the
 * student's sourcedId; otherwise a mailto: fallback so the event stays
 * resolvable by email. We NEVER fabricate a sourcedId.
 */
function timebackUser({ onerosterUserId, email }) {
  const mail = String(email || "").toLowerCase();
  let id;
  if (onerosterUserId) {
    id = `${onerosterBase()}/users/${encodeURIComponent(onerosterUserId)}`;
  } else if (mail) {
    id = `mailto:${mail}`;
  } else {
    id = `urn:uuid:${uuidv5(`anon|${email}`)}`;
  }
  const a = { id, type: "TimebackUser" };
  if (mail) a.email = mail;
  return a;
}

/**
 * Course context. Always carries the human-readable course name
 * ("Alpha Summer Reading <grade>"); adds the OneRoster course.id only when a
 * sourcedId is configured for the student's grade (env TIMEBACK_COURSE_MAP or
 * an explicit courseId param).
 */
function timebackCourse({ grade, courseId }) {
  const g = gradeLabel(grade);
  // Always resolves to a sourcedId now (defaults to DEFAULT_COURSE_SOURCED_ID),
  // so course.id is present on every event.
  const sourcedId = courseId || courseMap()[g] || DEFAULT_COURSE_SOURCED_ID;
  const course = { name: `${APP_NAME} ${g}` };
  if (sourcedId) {
    course.id = `${onerosterBase()}/courses/${encodeURIComponent(sourcedId)}`;
  }
  return course;
}

/**
 * Build a single TimebackProfile ActivityEvent (action "Completed") with a
 * TimebackActivityMetricsCollection. Shared by the retell + quiz envelopes.
 *
 * @param {Object} p
 * @param {"retell"|"quiz"} p.kind
 * @param {string}  p.email
 * @param {string}  [p.onerosterUserId]  — OneRoster student sourcedId (preferred)
 * @param {string}  p.bookId
 * @param {string}  p.bookTitle
 * @param {number}  [p.attemptNum=1]
 * @param {number}  [p.masteredUnits=0]
 * @param {number}  p.xpEarned
 * @param {number}  p.totalQuestions
 * @param {number}  p.correctQuestions
 * @param {Object}  [p.rubric]           — 4-axis retell rubric (retell only)
 * @param {string}  [p.tier]             — clear_pass | marginal | fail
 * @param {string}  [p.retellOutcome]    — p1 | p2 | fF → extensions.retellOutcomeCode
 * @param {string}  [p.outcomeKey]       — composite quiz_retell key
 * @param {string}  [p.bookGradeLevel]
 * @param {string}  [p.studentGrade]
 * @param {string}  [p.fraudFlag]
 * @param {boolean} [p.held]
 * @param {boolean} [p.retake]
 * @param {string}  [p.courseId]         — explicit OneRoster course sourcedId
 * @param {number}  [p.eventTimeMs]
 */
function buildActivityEvent(p) {
  const eventTime = new Date(p.eventTimeMs || Date.now()).toISOString();
  const kind = p.kind === "quiz" ? "quiz" : "retell";
  const activitySuffix = kind === "quiz" ? "comprehension quiz" : "oral retell";
  const objectId = `${edAppId()}/${kind}/${encodeURIComponent(p.bookId)}`;
  const attempt = p.attemptNum != null ? p.attemptNum : 1;
  // eventNonce discriminates DISTINCT completions of the same (kind, email,
  // book, attempt) — e.g. a legitimate re-read after an admin reset, or a
  // corrected event emitted on held-XP approval. Without it, the retell
  // attempt is always 1 so a re-completion produced a byte-identical id and
  // an idempotent TimeBack sink dropped the re-earned XP. (audit #4) Network
  // retries still replay the SAME built envelope, so dedup still works.
  const eventKey =
    p.eventNonce != null
      ? `${kind}|${String(p.email || "").toLowerCase()}|${p.bookId}|${attempt}|${p.eventNonce}`
      : `${kind}|${String(p.email || "").toLowerCase()}|${p.bookId}|${attempt}`;

  // Metrics TimeBack reads. masteredUnits always present (0 unless the
  // activity grants mastery); xp + question counts vary by activity kind.
  const items = [
    { type: "masteredUnits", value: Number(p.masteredUnits) || 0 },
    { type: "xpEarned", value: Number(p.xpEarned) || 0 },
    { type: "totalQuestions", value: Number(p.totalQuestions) || 0 },
    { type: "correctQuestions", value: Number(p.correctQuestions) || 0 },
  ];

  // Extensions — only include defined keys so the envelope stays clean.
  const extensions = {};
  if (p.rubric) {
    extensions.rubric = {
      retell_quality: Number(p.rubric.retell_quality) || 0,
      character_recall: Number(p.rubric.character_recall) || 0,
      event_recall: Number(p.rubric.event_recall) || 0,
      stayed_on_topic: Number(p.rubric.stayed_on_topic) || 0,
    };
  }
  if (p.tier) extensions.tier = p.tier;
  if (p.retellOutcome) extensions.retellOutcomeCode = p.retellOutcome;
  if (p.outcomeKey) extensions.outcomeKey = p.outcomeKey;
  if (p.bookGradeLevel != null) extensions.bookGradeLevel = String(p.bookGradeLevel);
  if (p.studentGrade != null) extensions.studentGrade = String(p.studentGrade);
  if (p.fraudFlag) extensions.fraudFlag = p.fraudFlag;
  if (p.held) extensions.held = true;
  if (p.retake) extensions.retake = true;

  const generated = {
    id: objectId,
    type: "TimebackActivityMetricsCollection",
    items,
    attempt,
  };
  if (Object.keys(extensions).length > 0) generated.extensions = extensions;

  return {
    "@context": CALIPER_CONTEXT,
    id: `urn:uuid:${uuidv5(eventKey)}`,
    type: "ActivityEvent",
    profile: "TimebackProfile",
    action: "Completed",
    actor: timebackUser({ onerosterUserId: p.onerosterUserId, email: p.email }),
    object: {
      id: objectId,
      type: "TimebackActivityContext",
      subject: "Reading",
      app: { name: APP_NAME },
      activity: { name: `${p.bookTitle || p.bookId} — ${activitySuffix}` },
      course: timebackCourse({ grade: p.studentGrade, courseId: p.courseId }),
      process: true,
    },
    eventTime,
    generated,
  };
}

/** Wrap a single event in the TimeBack sensor envelope. */
function envelope(event) {
  return {
    sensor: process.env.TIMEBACK_SENSOR_ID || edAppId(),
    sendTime: new Date().toISOString(),
    dataVersion: CALIPER_CONTEXT,
    data: [event],
  };
}

/**
 * Retell completion → one ActivityEvent. The rubric (0-12) is expressed as
 * totalQuestions=12 / correctQuestions=<rubricTotal> so TimeBack's generic
 * metrics read cleanly, with the per-axis breakdown + tier/outcome in
 * extensions.
 */
export function buildRetellEventEnvelope(p) {
  return envelope(
    buildActivityEvent({
      kind: "retell",
      email: p.email,
      onerosterUserId: p.onerosterUserId || p.studentId || null,
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      attemptNum: p.attemptNum || 1,
      masteredUnits: 0,
      xpEarned: p.xpAwarded != null ? p.xpAwarded : 0,
      totalQuestions: RETELL_MAX_SCORE,
      correctQuestions: Number(p.rubricTotal) || 0,
      rubric: p.rubric,
      tier: p.tier,
      retellOutcome: p.retellOutcome,
      outcomeKey: p.outcomeKey,
      bookGradeLevel: p.bookGradeLevel,
      studentGrade: p.studentGrade,
      held: !!p.held,
      courseId: p.courseId,
      eventNonce: p.eventNonce,
      eventTimeMs: p.eventTimeMs,
    })
  );
}

/**
 * Quiz completion → one ActivityEvent. Used standalone (quiz without a
 * retell). In the atomic quiz→retell flow only the retell envelope fires and
 * carries the combined outcomeKey + full-session XP.
 */
export function buildQuizEventEnvelope(p) {
  const maxScore = p.maxScore || 5;
  return envelope(
    buildActivityEvent({
      kind: "quiz",
      email: p.email,
      onerosterUserId: p.onerosterUserId || p.studentId || null,
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      attemptNum: p.attemptNum || 1,
      masteredUnits: 0,
      xpEarned: p.xpAwarded != null ? p.xpAwarded : 0,
      totalQuestions: maxScore,
      correctQuestions: Number(p.scoreGiven) || 0,
      bookGradeLevel: p.bookGradeLevel,
      studentGrade: p.studentGrade,
      fraudFlag: p.fraudFlag,
      retake: p.attemptNum === 2 ? true : undefined,
      courseId: p.courseId,
      eventNonce: p.eventNonce,
      eventTimeMs: p.eventTimeMs,
    })
  );
}
