import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import ws from "k6/ws";
import {
  buildSyntheticFeedback,
  callCreateSubmission,
  callSubmitFeedback,
  createRepositoryCheckRun,
  createTestAssignment,
  createTestClass,
  createTestRepository,
  createTestUserWithRole,
  exchangeMagicLinkForAccessToken,
  generateTestRunPrefix,
  getSupabaseConfig,
  logCleanupInfo,
  type RepositoryData,
  type StudentData,
  type SupabaseConfig
} from "./k6-supabase";

// k6 globals
declare const __ENV: Record<string, string>;
declare const __VU: number;

// ─────────────────────────────────────────────────────────────────────────────
// Tunable knobs (env-driven so a single binary can scale up/down)
// ─────────────────────────────────────────────────────────────────────────────
const NUM_STUDENTS = parseInt(__ENV.STORM_STUDENTS || "50", 10);
const NUM_GRADERS = parseInt(__ENV.STORM_GRADERS || "5", 10);
const NUM_ASSIGNMENTS = parseInt(__ENV.STORM_ASSIGNMENTS || "3", 10);
const STORM_DURATION_SECONDS = parseInt(__ENV.STORM_DURATION_SECONDS || "300", 10);
const PEAK_RPS = parseInt(__ENV.STORM_PEAK_RPS || "60", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Custom metrics. http_req_duration would conflate create-submission and
// submit-feedback latencies, so we record them separately.
// ─────────────────────────────────────────────────────────────────────────────
export const createSubmissionDuration = new Trend("create_submission_ms", true);
export const submitFeedbackDuration = new Trend("submit_feedback_ms", true);
export const createSubmissionSuccess = new Rate("create_submission_success_rate");
export const submitFeedbackSuccess = new Rate("submit_feedback_success_rate");
export const submissionsCompleted = new Counter("submissions_completed");
export const stormErrors = new Counter("storm_errors");

// Realtime fanout latency from broadcast.timestamp (server-emit time) to ws receipt.
export const realtimeFanoutMs = new Trend("realtime_fanout_ms", true);
export const realtimeMessages = new Counter("realtime_messages_received");
export const realtimeJoinFailures = new Counter("realtime_join_failures");

// ─────────────────────────────────────────────────────────────────────────────
// Scenario configuration. Two scenarios share setup() data.
// ─────────────────────────────────────────────────────────────────────────────
const totalSubscribers = NUM_STUDENTS + NUM_GRADERS;
const rampUp = 60;
const rampDown = 30;
const steady = Math.max(0, STORM_DURATION_SECONDS - rampUp - rampDown);

export const options = {
  scenarios: {
    realtime_subscribers: {
      executor: "per-vu-iterations",
      vus: totalSubscribers,
      iterations: 1,
      maxDuration: `${STORM_DURATION_SECONDS + 30}s`,
      exec: "subscriberFn"
    },
    submission_storm: {
      executor: "ramping-arrival-rate",
      startTime: "10s", // give subscribers a head start to settle
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: Math.max(50, PEAK_RPS),
      maxVUs: Math.max(200, PEAK_RPS * 4),
      exec: "stormFn",
      stages: [
        { duration: `${rampUp}s`, target: PEAK_RPS },
        { duration: `${steady}s`, target: PEAK_RPS },
        { duration: `${rampDown}s`, target: 0 }
      ]
    }
  },
  thresholds: {
    create_submission_success_rate: ["rate>0.95"],
    submit_feedback_success_rate: ["rate>0.95"],
    create_submission_ms: ["p(95)<5000"],
    submit_feedback_ms: ["p(95)<5000"],
    storm_errors: ["count<100"]
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Setup phase — runs once. Builds the class, all students/graders, magic-link
// tokens, assignments, and per-(student, assignment) repositories. Pre-exchanges
// magic links into JWTs so VUs can attach to realtime channels without an
// extra round-trip during the test window.
// ─────────────────────────────────────────────────────────────────────────────
export type StormSetupData = {
  config: SupabaseConfig;
  classId: number;
  testRunPrefix: string;
  graderName: string;
  endToEndSecret: string;
  students: SubscriberSetup[];
  graders: SubscriberSetup[];
  repositories: RepositoryData[];
};

type SubscriberSetup = {
  user: StudentData;
  accessToken: string;
};

export function setup(): StormSetupData {
  const config = getSupabaseConfig();
  const testRunPrefix = generateTestRunPrefix("storm");
  const endToEndSecret = __ENV.END_TO_END_SECRET || "not-a-secret";

  console.log(
    `🌩️ Storm setup: ${NUM_STUDENTS} students, ${NUM_GRADERS} graders, ${NUM_ASSIGNMENTS} assignments, peak ${PEAK_RPS} RPS for ${STORM_DURATION_SECONDS}s`
  );

  const classData = createTestClass(testRunPrefix, config);

  // 1. Assignments
  const assignments: Array<{ id: number; title: string }> = [];
  for (let i = 0; i < NUM_ASSIGNMENTS; i++) {
    const a = createTestAssignment(`Storm Assignment ${i + 1}`, classData.id, testRunPrefix, i, config);
    assignments.push({ id: a.id, title: a.title });
  }

  // 2. Students + graders (and pre-exchange magic links).
  const workerIndex = __ENV.TEST_WORKER_INDEX || "k6-storm";
  const students: SubscriberSetup[] = [];
  for (let i = 1; i <= NUM_STUDENTS; i++) {
    const u = createTestUserWithRole({
      role: "student",
      number: i,
      classId: classData.id,
      testRunPrefix,
      workerIndex,
      config
    });
    const auth = exchangeMagicLinkForAccessToken(u.magic_link.hashed_token, config);
    students.push({ user: u, accessToken: auth.access_token });
  }
  const graders: SubscriberSetup[] = [];
  for (let i = 1; i <= NUM_GRADERS; i++) {
    const u = createTestUserWithRole({
      role: "grader",
      number: i,
      classId: classData.id,
      testRunPrefix,
      workerIndex,
      config
    });
    const auth = exchangeMagicLinkForAccessToken(u.magic_link.hashed_token, config);
    graders.push({ user: u, accessToken: auth.access_token });
  }

  // 3. Repositories — one per (student, assignment).
  const repositories: RepositoryData[] = [];
  for (const s of students) {
    for (const a of assignments) {
      repositories.push(createTestRepository(s.user, a, classData.id, testRunPrefix, config));
    }
  }

  // 4. Pick a single grader profile name as the synthetic feedback author.
  const graderName = graders[0]?.user ? `Grader #1` : `Pawtograder`;

  console.log(
    `✅ Setup ready: classId=${classData.id}, ${students.length} students, ${graders.length} graders, ${repositories.length} repos`
  );

  return {
    config,
    classId: classData.id,
    testRunPrefix,
    graderName,
    endToEndSecret,
    students,
    graders,
    repositories
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Realtime subscriber VU. Each VU index in [1..N+M] maps to one student or
// grader, opens a Phoenix websocket, joins the relevant private topics, and
// listens for broadcasts until the test wraps up. We measure fanout latency
// (server timestamp → client receipt).
// ─────────────────────────────────────────────────────────────────────────────
export function subscriberFn(data: StormSetupData): void {
  const idx = __VU - 1; // VUs are 1-indexed
  const isGrader = idx >= data.students.length;
  const subscriber = isGrader ? data.graders[idx - data.students.length] : data.students[idx];
  if (!subscriber) {
    // More VUs than subscribers configured — exit cleanly
    return;
  }

  const topics = isGrader
    ? [`class:${data.classId}:staff`, `class:${data.classId}:user:${subscriber.user.private_profile_id}`]
    : [`class:${data.classId}:students`, `class:${data.classId}:user:${subscriber.user.private_profile_id}`];

  const wsBase = data.config.url.replace(/^http/, "ws");
  const url = `${wsBase}/realtime/v1/websocket?apikey=${data.config.anonKey}&vsn=1.0.0`;
  const holdMs = STORM_DURATION_SECONDS * 1000;

  const res = ws.connect(url, {}, (socket) => {
    let refCounter = 1;
    const nextRef = () => String(refCounter++);

    socket.on("open", () => {
      // Phoenix v1 envelope: { topic, event, payload, ref }
      // Realtime v2 expects the access_token inside payload for private channels;
      // setAuth flow used by the JS SDK is equivalent to including it on join.
      for (const topic of topics) {
        const ref = nextRef();
        socket.send(
          JSON.stringify({
            topic: `realtime:${topic}`,
            event: "phx_join",
            payload: {
              config: {
                broadcast: { ack: false, self: false },
                presence: { key: "" },
                postgres_changes: [],
                private: true
              },
              access_token: subscriber.accessToken
            },
            ref
          })
        );
      }

      // Heartbeat every 25s (Phoenix default timeout is 60s).
      socket.setInterval(() => {
        socket.send(
          JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() })
        );
      }, 25_000);

      // Stop after the test duration.
      socket.setTimeout(() => socket.close(), holdMs);
    });

    socket.on("message", (raw) => {
      let msg: { topic?: string; event?: string; payload?: Record<string, unknown>; ref?: string } | null = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg) return;

      // Track join failures (phx_reply with status: "error")
      if (msg.event === "phx_reply") {
        const status = (msg.payload as { status?: string } | undefined)?.status;
        if (status && status !== "ok") {
          realtimeJoinFailures.add(1);
          console.warn(`Realtime join failure on ${msg.topic}: ${JSON.stringify(msg.payload)}`);
        }
        return;
      }

      // Broadcast envelope. Pawtograder broadcasts always carry a top-level
      // `timestamp` ISO string; if we can find one, record the fanout latency.
      if (msg.event === "broadcast") {
        realtimeMessages.add(1);
        const inner = (msg.payload?.payload ?? msg.payload) as Record<string, unknown> | undefined;
        const tsString = (inner?.timestamp ?? msg.payload?.timestamp) as string | undefined;
        if (tsString) {
          const sentAt = Date.parse(tsString);
          if (!isNaN(sentAt)) {
            realtimeFanoutMs.add(Date.now() - sentAt);
          }
        }
      }
    });

    socket.on("error", (e: unknown) => {
      console.error(`Realtime ws error VU=${__VU}: ${String(e)}`);
    });
  });

  check(res, { "realtime websocket established": (r) => r && r.status === 101 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Submission storm VU. Each iteration: pick a random repository, generate fresh
// SHA + run identifiers, hit create-submission then submit-feedback. The pair
// is what real GitHub Action runs do.
// ─────────────────────────────────────────────────────────────────────────────
export function stormFn(data: StormSetupData): void {
  if (data.repositories.length === 0) {
    stormErrors.add(1);
    return;
  }

  const repo = data.repositories[Math.floor(Math.random() * data.repositories.length)];
  const sha = `HEAD-${Math.random().toString(36).slice(2, 14)}`;
  const runId = Math.floor(Math.random() * 1_000_000) + 1;
  const runAttempt = 1;

  // Webhook handoff: real flow inserts a check_run row before the GH Action calls
  // autograder-create-submission. We replicate that ordering.
  try {
    createRepositoryCheckRun(data.classId, repo.id, sha, data.config);
  } catch (e) {
    stormErrors.add(1);
    console.error(`check_run insert failed: ${String(e)}`);
    return;
  }

  // 1. autograder-create-submission
  const createStart = Date.now();
  const createResp = callCreateSubmission({
    repository: repo.name,
    sha,
    runId,
    runAttempt,
    config: data.config,
    endToEndSecret: data.endToEndSecret
  });
  const createMs = Date.now() - createStart;
  createSubmissionDuration.add(createMs);
  const createOk = createResp.status === 200;
  createSubmissionSuccess.add(createOk);
  if (!createOk) {
    stormErrors.add(1);
    console.error(`create-submission ${createResp.status}: ${createResp.body?.slice(0, 200)}`);
    return;
  }

  // 2. autograder-submit-feedback (synthetic 20-60 tests, 0-10 comments, no artifacts)
  const feedbackBody = buildSyntheticFeedback({
    graderName: data.graderName,
    fileName: "Main.java" // matches the canned file inserted by E2E_MOCK_GITHUB
  });
  const feedbackStart = Date.now();
  const feedbackResp = callSubmitFeedback({
    repository: repo.name,
    sha,
    runId,
    runAttempt,
    body: feedbackBody,
    config: data.config,
    endToEndSecret: data.endToEndSecret
  });
  const feedbackMs = Date.now() - feedbackStart;
  submitFeedbackDuration.add(feedbackMs);
  const feedbackOk = feedbackResp.status === 200;
  submitFeedbackSuccess.add(feedbackOk);
  if (!feedbackOk) {
    stormErrors.add(1);
    console.error(`submit-feedback ${feedbackResp.status}: ${feedbackResp.body?.slice(0, 200)}`);
    return;
  }

  submissionsCompleted.add(1);
}

// Default export is required by k6 even though we route per-scenario via `exec`.
// eslint-disable-next-line import/no-anonymous-default-export
export default function (): void {
  sleep(1);
}

export function teardown(data: StormSetupData): void {
  if (data?.classId) {
    logCleanupInfo(data.classId, "submissions-write-storm");
  }
}

/*
Submissions Write Storm Load Test

What it exercises:
  1. N students + M graders connected to realtime over websocket (Phoenix protocol,
     private channels: class:{id}:students | class:{id}:staff | class:{id}:user:{pid}).
  2. Sustained POSTs to autograder-create-submission then autograder-submit-feedback
     at a configurable peak RPS, mocking GitHub via E2E_MOCK_GITHUB on the server.
  3. Fanout latency from broadcast emission to ws receipt across all subscribers.

Required environment:
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
  END_TO_END_SECRET                — must match the deployed function env
  E2E_ENABLE=true                  — server must have E2E bypass enabled
  E2E_MOCK_GITHUB=true             — server must have GitHub mocking enabled

Optional knobs (defaults in parens):
  STORM_STUDENTS (50)
  STORM_GRADERS (5)
  STORM_ASSIGNMENTS (3)
  STORM_PEAK_RPS (60)
  STORM_DURATION_SECONDS (300)
  TEST_WORKER_INDEX                — disambiguates emails when running parallel workers

Run:
  k6 run dist/k6-tests/submissions-write-storm.js
*/
