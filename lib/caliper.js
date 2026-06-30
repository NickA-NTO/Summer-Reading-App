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

// OneRoster USERS base for object.assignee.id — the Alpha 1EdTech events API
// requires the student URL in the `/rostering/1.0/users/<sourcedId>` form
// (verified live: this exact path is what processed XP in the sandbox).
function onerosterUsersBase() {
  return (
    process.env.TIMEBACK_ONEROSTER_USERS_BASE ||
    "https://api.alpha-1edtech.ai/rostering/1.0/users"
  ).replace(/\/+$/, "");
}

// The registered application identity URL — used as BOTH edApp.id and (for
// GradeEvent) actor.id. Per the provisioning bundle: "Do not make up your own
// identifier." Defaults to the registered Alpha Summer Reading app.
export function edAppUrl() {
  return (
    process.env.TIMEBACK_EDAPP_URL ||
    "https://api.alpha-1edtech.ai/applications/1.0/9cfc753a-2a6b-4da7-9fd8-f78acd07e55c"
  ).replace(/\/+$/, "");
}
// OneRoster user URL for a sourcedId — exported for the heartbeat route's
// SessionEvent actor. (Mirrors the internal userUrl() used by the builders.)
export function onerosterUserUrl(sourcedId) {
  const base = (process.env.TIMEBACK_ONEROSTER_USERS_BASE ||
    "https://api.alpha-1edtech.ai/rostering/1.0/users").replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(sourcedId)}`;
}
function softwareApp() {
  return { id: edAppUrl(), type: "SoftwareApplication" };
}
// OneRoster user URL for a student sourcedId (the SSO id_token `sourcedId`).
function userUrl(sourcedId) {
  return `${onerosterUsersBase()}/${encodeURIComponent(sourcedId)}`;
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
 * Course context. Always carries the human-readable course name
 * ("Alpha Summer Reading <grade>"); adds the OneRoster course.id only when a
 * sourcedId is configured for the student's grade (env TIMEBACK_COURSE_MAP or
 * an explicit courseId param).
 */
function courseSourcedId({ grade, courseId }) {
  const g = gradeLabel(grade);
  return courseId || courseMap()[g] || DEFAULT_COURSE_SOURCED_ID;
}
// `extensions.course.id` URL form expected by the events API — the
// /rostering/1.0/courses/<sourcedId> shape (verified live). MUST resolve to a
// course the client owns or the event is 202'd then silently dropped.
function courseUrl(sourcedId) {
  const base = (process.env.TIMEBACK_ONEROSTER_COURSES_BASE ||
    "https://api.alpha-1edtech.ai/rostering/1.0/courses").replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(sourcedId)}`;
}

// Reading Spine publishes ONE lesson, not one-per-book: kids freely choose any
// book in any order, so a per-book checklist would misrepresent the product
// (and imply a required sequence that doesn't exist). All events therefore pin
// this single lesson ("Read on Reading Spine" → the site). Its sourcedId is the
// deterministic v5 of "asr-lesson|single" — MUST match the published catalog.
//
// NOTE: the PM doc says to pass the lesson via `extensions.lesson.id`, but the
// live events API REJECTS a `lesson` key in extensions (400 unrecognized_keys —
// verified). The working placement is `object.assignable.id` = this lesson URL.
function singleLessonSourcedId() {
  const h = createHash("sha1").update("asr-lesson|single").digest();
  const x = Buffer.from(h.subarray(0, 16));
  x[6] = (x[6] & 0x0f) | 0x50; // version 5
  x[8] = (x[8] & 0x3f) | 0x80; // RFC 4122 variant
  const v = x.toString("hex");
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}
function lessonUrl() {
  const base = (process.env.TIMEBACK_ONEROSTER_LESSONS_BASE ||
    "https://api.alpha-1edtech.ai/rostering/1.0/lessons").replace(/\/+$/, "");
  return `${base}/${singleLessonSourcedId()}`;
}

// ── Shared object.id scheme (MOVE-vs-accumulate, per TimeBack Doc 1) ─────────
// TimeBack stores one fact per object.id and OVERWRITES on a repeat object.id
// with a later eventTime (a "move"). So:
//   • Distinct earnings need DISTINCT object.ids → they accumulate.
//   • A correction (held-XP approval) must REUSE the original object.id + the
//     original eventTime → it patches in place.
// earnNonce is the existing eventNonce (held heldId / tutor sessionId) when
// present, else attempt#+day so a same-day re-read of the same book at the
// same attempt collapses (intended) while a later-day re-read stacks.
function attemptObjectId(p, kind) {
  const attempt = p.attemptNum != null ? p.attemptNum : 1;
  const day = new Date(p.eventTimeMs || Date.now()).toISOString().slice(0, 10);
  const earnNonce = p.eventNonce != null ? String(p.eventNonce) : `${attempt}|${day}`;
  const sidPart = p.sourcedId ? encodeURIComponent(p.sourcedId) : "anon";
  return `${edAppId()}/attempt/${kind}/${encodeURIComponent(p.bookId)}/${sidPart}/${encodeURIComponent(earnNonce)}`;
}

/**
 * GradeEvent (reports XP). Proven shape — verified live: this exact envelope
 * processed XP that read back from /xp/1.0. `actor` and `edApp` are the
 * registered SoftwareApplication; the student is `object.assignee` (a Person).
 * Returns null when no sourcedId — we NEVER fabricate a student id, and an
 * event without a resolvable assignee is dropped during processing anyway.
 *
 * @param {Object} p
 * @param {"retell"|"quiz"} p.kind
 * @param {string}  p.sourcedId          — OneRoster student sourcedId (REQUIRED)
 * @param {string}  p.bookId
 * @param {string}  p.bookTitle
 * @param {number}  [p.attemptNum=1]
 * @param {number}  p.xpEarned
 * @param {string}  [p.studentGrade]     — selects course via TIMEBACK_COURSE_MAP
 * @param {string}  [p.courseId]         — explicit course sourcedId override
 * @param {string}  [p.eventNonce]       — distinct-earning discriminator
 * @param {number}  [p.eventTimeMs]
 * @param {string}  [p.correctionOfObjectId] — set to overwrite a prior earning
 */
function buildGradeEvent(p) {
  if (!p.sourcedId) return null;
  const eventTime = new Date(p.eventTimeMs || Date.now()).toISOString();
  const kind = p.kind === "quiz" ? "quiz" : "retell";
  const activitySuffix = kind === "quiz" ? "comprehension quiz" : "oral retell";
  const objectId = p.correctionOfObjectId || attemptObjectId(p, kind);
  const xp = Number(p.xpEarned) || 0;
  // Deterministic event id: a network retry replays byte-identical (dedup),
  // but a new earning (new object.id) yields a new id.
  const eventKey = `grade|${objectId}|XP|${eventTime}`;

  // The events API validates `extensions` strictly — only `subject` and
  // `course` are accepted (extra keys → 400 unrecognized_keys, verified live).
  // A `lesson` key is rejected here despite the PM doc; the lesson reference
  // rides on object.assignable.id instead (see below). Our internal flags
  // (fraudFlag/held/retake/studentGrade) live in our own Redis records, NOT on
  // the Caliper envelope.
  const extensions = {
    subject: "Reading",
    course: { id: courseUrl(courseSourcedId(p)) },
  };

  return {
    "@context": CALIPER_CONTEXT,
    id: `urn:uuid:${uuidv5(eventKey)}`,
    type: "GradeEvent",
    profile: "GradingProfile",
    action: "Graded",
    eventTime,
    actor: softwareApp(),
    edApp: softwareApp(),
    object: {
      id: objectId,
      type: "Attempt",
      count: p.attemptNum != null ? p.attemptNum : 1,
      assignee: { id: userUrl(p.sourcedId), type: "Person" },
      // assignable = the single published "Read on Reading Spine" lesson. This
      // is how TimeBack ties the event to the lesson (the doc's conceptual
      // "lesson.id"); the events API rejects a `lesson` key in extensions, so
      // it rides here. The book title still travels in activityName below for
      // human-readable context, but XP attributes to the one lesson.
      assignable: {
        id: lessonUrl(),
        type: "DigitalResource",
        mediaType: "application/json",
      },
      extensions: { activityName: `${p.bookTitle || p.bookId} — ${activitySuffix}` },
    },
    generated: {
      id: `${edAppId()}/scores/${uuidv5(eventKey)}`,
      type: "Score",
      scoreGiven: xp,
      maxScore: xp,
      extensions: { scoreType: "XP" },
    },
    extensions,
  };
}

/**
 * AssessmentEvent (reports accuracy). `profile` MUST be "AssessmentProfile";
 * `actor` is the student Person (not the edApp). action "Submitted" requires
 * generated.endedAtTime. Returns null without a sourcedId. Quiz only — a
 * retell is a rubric, not a question-count assessment.
 *
 * @param {Object} p  — adds: correctQuestions, totalQuestions, startedAtMs
 */
function buildAssessmentEvent(p) {
  if (!p.sourcedId) return null;
  const endMs = p.eventTimeMs || Date.now();
  const eventTime = new Date(endMs).toISOString();
  const startedAtTime = new Date(p.startedAtMs || endMs - 120000).toISOString();
  const assessmentId = `${edAppId()}/quiz/${encodeURIComponent(p.bookId)}`;
  const attemptNonce = p.eventNonce != null ? String(p.eventNonce)
    : `${p.attemptNum != null ? p.attemptNum : 1}|${eventTime.slice(0,10)}`;
  const eventKey = `assess|${assessmentId}|${p.sourcedId}|${attemptNonce}`;

  return {
    "@context": CALIPER_CONTEXT,
    id: `urn:uuid:${uuidv5(eventKey)}`,
    type: "AssessmentEvent",
    profile: "AssessmentProfile",
    action: "Submitted",
    eventTime,
    actor: { id: userUrl(p.sourcedId), type: "Person" },
    edApp: softwareApp(),
    object: {
      id: assessmentId,
      type: "Assessment",
      name: `${p.bookTitle || p.bookId} — comprehension quiz`,
    },
    generated: {
      id: `${assessmentId}/attempts/${uuidv5(eventKey)}`,
      type: "Attempt",
      assignee: { id: userUrl(p.sourcedId), type: "Person" },
      assignable: assessmentId,
      startedAtTime,
      endedAtTime: eventTime,
      extensions: {
        correctQuestions: Number(p.correctQuestions) || 0,
        totalQuestions: Number(p.totalQuestions) || 0,
      },
    },
    extensions: {
      // Only subject + course are accepted here (a `lesson` key → 400). The
      // lesson tie rides on generated.assignable below.
      subject: "Reading",
      course: { id: courseUrl(courseSourcedId(p)) },
    },
  };
}

/** Wrap a single event in the TimeBack sensor envelope. Returns null if the
 *  event is null (e.g. no sourcedId), so callers skip emitting. */
function envelope(event) {
  if (!event) return null;
  return {
    sensor: process.env.TIMEBACK_SENSOR_ID || edAppUrl(),
    sendTime: new Date().toISOString(),
    dataVersion: CALIPER_CONTEXT,
    data: [event],
  };
}

/**
 * Retell completion → GradeEvent envelope (XP). Returns null when sourcedId is
 * missing (we never fabricate identity). `p.sourcedId` is the OneRoster id
 * from the student's TimeBack SSO login.
 */
export function buildRetellEventEnvelope(p) {
  return envelope(
    buildGradeEvent({
      kind: "retell",
      sourcedId: p.sourcedId || p.onerosterUserId || null,
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      attemptNum: p.attemptNum || 1,
      xpEarned: p.xpAwarded != null ? p.xpAwarded : 0,
      studentGrade: p.studentGrade,
      held: !!p.held,
      courseId: p.courseId,
      eventNonce: p.eventNonce,
      eventTimeMs: p.eventTimeMs,
      correctionOfObjectId: p.correctionOfObjectId,
    })
  );
}

/**
 * Quiz completion → GradeEvent envelope (XP). Used standalone (quiz without a
 * retell). In the atomic quiz→retell flow the retell envelope carries the
 * combined full-session XP; accuracy goes via buildQuizAccuracyEnvelope.
 */
export function buildQuizEventEnvelope(p) {
  return envelope(
    buildGradeEvent({
      kind: "quiz",
      sourcedId: p.sourcedId || p.onerosterUserId || null,
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      attemptNum: p.attemptNum || 1,
      xpEarned: p.xpAwarded != null ? p.xpAwarded : 0,
      studentGrade: p.studentGrade,
      fraudFlag: p.fraudFlag,
      retake: p.attemptNum === 2 ? true : undefined,
      courseId: p.courseId,
      eventNonce: p.eventNonce,
      eventTimeMs: p.eventTimeMs,
      correctionOfObjectId: p.correctionOfObjectId,
    })
  );
}

/**
 * Quiz accuracy → AssessmentEvent envelope. Fired alongside the XP GradeEvent
 * on a quiz pass so TimeBack gets the correct/total signal, not just XP.
 * Returns null without a sourcedId. Quiz only (retell has no question count).
 */
export function buildQuizAccuracyEnvelope(p) {
  return envelope(
    buildAssessmentEvent({
      sourcedId: p.sourcedId || p.onerosterUserId || null,
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      attemptNum: p.attemptNum || 1,
      correctQuestions: Number(p.scoreGiven) || 0,
      totalQuestions: p.maxScore || 5,
      studentGrade: p.studentGrade,
      courseId: p.courseId,
      eventNonce: p.eventNonce,
      eventTimeMs: p.eventTimeMs,
      startedAtMs: p.startedAtMs,
    })
  );
}
