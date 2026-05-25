// Caliper Analytics event builders for TimeBack integration (TODO 1e).
//
// Reading Spine emits two events when a kid passes a quiz:
//   1. AssessmentEvent  (action: "Completed")  — student finished the quiz
//   2. GradeEvent       (action: "Graded")    — the score was assigned
//
// Spec: Caliper v1.2 (https://www.imsglobal.org/spec/caliper/v1p2)
// Identity: we send BOTH the TimeBack student_id (UUID, if known) and the
//           email as the actor's `id` and `otherIdentifiers`. TimeBack's
//           ingestion picks whichever it keys on.
// Idempotency: each event's `id` is a UUID v5 derived from
//           (email, bookId, attemptNumber, eventType) so retries
//           don't credit XP twice.
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

// The edApp identifier — TimeBack uses this to attribute the event source.
// Override via TIMEBACK_EDAPP_ID env var; defaults to our public deployment.
function edAppId() {
  return (
    process.env.TIMEBACK_EDAPP_ID ||
    process.env.PUBLIC_BASE_URL ||
    "https://reading-spine.vercel.app"
  );
}
function edApp() {
  return {
    id: edAppId(),
    type: "SoftwareApplication",
    name: "Alpha Summer Reading",
  };
}

/**
 * Build the Caliper Person actor for a student. Sends BOTH the
 * TimeBack student_id (preferred) and the email — TimeBack can key
 * on whichever it has indexed.
 */
function actor({ studentId, email, name }) {
  const personId = studentId
    ? `urn:uuid:${studentId}`
    : `mailto:${String(email).toLowerCase()}`;
  const a = { id: personId, type: "Person" };
  if (name) a.name = name;
  // Include the email as a secondary identifier even when student_id is the
  // primary — helps TimeBack resolve identity when one isn't on file.
  if (email && studentId) {
    a.otherIdentifiers = [
      {
        type: "SystemIdentifier",
        identifierType: "EmailAddress",
        identifier: String(email).toLowerCase(),
      },
    ];
  }
  return a;
}

function assessmentObject({ bookId, bookTitle, maxScore = 5 }) {
  return {
    id: `${edAppId()}/quiz/${encodeURIComponent(bookId)}`,
    type: "Assessment",
    name: `${bookTitle} — comprehension quiz`,
    maxScore,
  };
}

function attemptObject({ bookId, bookTitle, attemptNum, maxScore = 5 }) {
  return {
    id: `${edAppId()}/quiz/${encodeURIComponent(bookId)}/attempt/${attemptNum}`,
    type: "AttemptItem",
    isPartOf: assessmentObject({ bookId, bookTitle, maxScore }),
  };
}

/**
 * AssessmentEvent (action: Completed) — the student finished the quiz
 * (regardless of pass/fail; we emit on every completion for completeness).
 *
 * @param {Object} p
 * @param {string} p.email
 * @param {string} [p.studentId]   — TimeBack UUID; preferred actor id when present
 * @param {string} [p.studentName]
 * @param {string} p.bookId
 * @param {string} p.bookTitle
 * @param {number} p.attemptNum    — 1 or 2
 * @param {number} p.scoreGiven    — quiz score (0-5)
 * @param {number} [p.maxScore=5]
 * @param {number} [p.eventTimeMs] — defaults to now
 */
export function buildAssessmentEvent(p) {
  const eventTime = new Date(p.eventTimeMs || Date.now()).toISOString();
  const eventKey = `assessment|${p.email}|${p.bookId}|${p.attemptNum}`;
  return {
    "@context": CALIPER_CONTEXT,
    id: `urn:uuid:${uuidv5(eventKey)}`,
    type: "AssessmentEvent",
    actor: actor({
      studentId: p.studentId,
      email: p.email,
      name: p.studentName,
    }),
    action: "Completed",
    object: assessmentObject({
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      maxScore: p.maxScore || 5,
    }),
    eventTime,
    edApp: edApp(),
  };
}

/**
 * GradeEvent (action: Graded) — the score was assigned to an attempt.
 * This is what TimeBack uses to credit XP per its own rules.
 *
 * extensions:
 *   retake          — true if this is the 2nd attempt
 *   bookGradeLevel  — the book's authored grade (K/1/2)
 *   studentGrade    — student's working grade at time of attempt
 *   xpAwarded       — Reading Spine's internal XP for this read (informational)
 *   fraudFlag       — "clean" | "soft_flag" | "held"
 */
export function buildGradeEvent(p) {
  const eventTime = new Date(p.eventTimeMs || Date.now()).toISOString();
  const eventKey = `grade|${p.email}|${p.bookId}|${p.attemptNum}`;
  const score = {
    id: `urn:uuid:${uuidv5(`score|${p.email}|${p.bookId}|${p.attemptNum}`)}`,
    type: "Score",
    scoreGiven: p.scoreGiven,
    maxScore: p.maxScore || 5,
    scoredBy: {
      id: edAppId(),
      type: "SoftwareApplication",
      name: "Alpha Summer Reading",
    },
  };
  const event = {
    "@context": CALIPER_CONTEXT,
    id: `urn:uuid:${uuidv5(eventKey)}`,
    type: "GradeEvent",
    actor: actor({
      studentId: p.studentId,
      email: p.email,
      name: p.studentName,
    }),
    action: "Graded",
    object: attemptObject({
      bookId: p.bookId,
      bookTitle: p.bookTitle,
      attemptNum: p.attemptNum,
      maxScore: p.maxScore || 5,
    }),
    generated: score,
    eventTime,
    edApp: edApp(),
  };
  // Optional extensions — TimeBack can use these or ignore them. Stored under
  // the Caliper-standard "extensions" key.
  const extensions = {};
  if (p.attemptNum === 2) extensions.retake = true;
  if (p.bookGradeLevel) extensions.bookGradeLevel = String(p.bookGradeLevel);
  if (p.studentGrade) extensions.studentGrade = String(p.studentGrade);
  if (p.xpAwarded != null) extensions.xpAwarded = p.xpAwarded;
  if (p.fraudFlag) extensions.fraudFlag = p.fraudFlag;
  if (Object.keys(extensions).length > 0) {
    event.extensions = extensions;
  }
  return event;
}

/**
 * Build the matched pair of events (AssessmentEvent + GradeEvent) that we
 * fire on every quiz completion. Returned as a Caliper "envelope" suitable
 * for a single POST to the TimeBack sensor endpoint.
 */
export function buildQuizEventEnvelope(p) {
  const sensorId = process.env.TIMEBACK_SENSOR_ID || `${edAppId()}/sensor`;
  return {
    sensor: sensorId,
    sendTime: new Date().toISOString(),
    dataVersion: CALIPER_CONTEXT,
    data: [buildAssessmentEvent(p), buildGradeEvent(p)],
  };
}
