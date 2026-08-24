/**
 * Fingerprint normalization for Sentry/Bugsink grouping.
 *
 * Many edge-function errors embed the thing they failed on directly in the message — a repo name, a
 * commit sha, a queue read count, a uuid. Bugsink hashes the message into the group key, so one
 * defect arrives as N issues instead of one. A single e2e run of the push-webhook suite produced 72
 * separate issues that were all the same line of code:
 *
 *   Could not resolve the current head of pawtograder-playground/test-e2e-student-repo--msh98vk8kvtq7w
 *   to check whether deadbeefmsh98vk8kvtq7w is superseded (...)
 *
 * That drowns the project: real single-occurrence bugs sort next to the 40th copy of a known one,
 * and "new issue" alerts fire per repo. So before an event is sent we compute an explicit
 * `fingerprint` from the stable parts — error type, the innermost in-app frame, and the message with
 * its volatile identifiers replaced by placeholders. The message itself is untouched, so each event
 * still shows exactly which repo/sha it was; only the grouping key is normalized.
 *
 * An explicit fingerprint set at the call site always wins — the rate-limit call sites in
 * github-async-worker and friends deliberately group by installation-independent keys, and this must
 * not override that.
 *
 * Kept pure and env-free so it is cheap to import from every Sentry.init site and testable without a
 * Sentry client.
 */

/** The subset of a Sentry event this module reads. Avoids depending on @sentry/deno's exported types. */
export interface FingerprintableEvent {
  fingerprint?: string[];
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: { frames?: Array<{ filename?: string; function?: string; in_app?: boolean }> };
    }>;
  };
  message?: string | { formatted?: string; message?: string };
  logentry?: { message?: string; formatted?: string };
}

/**
 * Replace the parts of a message that vary per occurrence with placeholders.
 *
 * Order matters: the broad patterns would otherwise eat the pieces the narrow ones identify (a uuid
 * is also a run of hex; a repo slug contains an e2e suffix). Each rule below exists because it was
 * observed splitting a real group in the Dev project.
 */
export function normalizeErrorMessage(message: string): string {
  return (
    message
      // uuids: profile/class/message ids interpolated into messages
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      // owner/repo slugs, including the e2e suffixes (test-e2e-student-repo--msh98vk8kvtq7w).
      // URLs lead the alternation so the octokit doc links appended to every HttpError message
      // ("… - https://docs.github.com/rest/repos/repos#get-a-repository") survive intact instead of
      // being shredded into <repo> fragments — they are constant, and they name the failing call.
      .replace(/https?:\/\/\S+|\b[\w.-]+\/[\w.-]+\b/g, (m) => (m.startsWith("http") ? m : "<repo>"))
      // git shas: real (7-40 hex). A digit is required so ordinary a-f words ("defaced") are not
      // mistaken for one. The e2e fakes (deadbeefmsh98vk8kvtq7w) are not hex and fall to <id> below.
      .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, "<sha>")
      // opaque per-run ids: base36-ish tokens that mix letters and digits (msh98vk8kvtq7w, abcd1soci792v5f)
      .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/gi, "<id>")
      // 4xx/5xx codes carry meaning the catch-all below would erase: GitHubSyncHelpers throws
      // `Failed to download '<path>' from <repo>: ${response.status}`, and a 404 (missing file) needs
      // to stay separate from a 500 (upstream fault) — same frame, same message shape, different fix.
      // Deliberately positional rather than a bare range match: the same digits occur inside embedded
      // stack traces (`chunks/476.js`, `26_fetch.js:485:11`), where preserving them would SPLIT groups
      // across builds. So a code counts only as a free-standing token — not touching `.`, `:`, `/`, or
      // another digit on either side.
      .replace(/(^|[\s#([])([45]\d{2})(?=$|[\s),;\]]|\.(?:\s|$))/g, "$1<status:$2>")
      // anything numeric left over: ids, counts, ports, timestamps. The status tokens just written
      // lead the alternation so their digits survive this pass instead of collapsing to <status:<n>>.
      .replace(/<status:\d{3}>|\d+/g, (m) => (m.startsWith("<status:") ? m : "<n>"))
      .trim()
  );
}

/**
 * The exception that was actually captured.
 *
 * Sentry's LinkedErrors integration prepends the `cause` chain and `AggregateError.errors`, so the
 * captured wrapper is the LAST entry, not the first. Confirmed against a real event in the Dev project:
 * `values = [Error, AggregateError]` for a captured AggregateError, and Bugsink's own `calculated_type`
 * for that issue is `AggregateError`. Keying on `values[0]` would fingerprint the child instead — which
 * both splits aggregate failures whose first child varies and risks merging a wrapper with a directly
 * captured child error. Using the last entry also aligns our fingerprint's type with the type Bugsink
 * displays.
 */
function capturedException(event: FingerprintableEvent) {
  const values = event.exception?.values;
  return values?.length ? values[values.length - 1] : undefined;
}

/** Innermost in-app frame, as a stable `file:function` key. Falls back to the innermost frame. */
function topFrameKey(event: FingerprintableEvent): string | null {
  const frames = capturedException(event)?.stacktrace?.frames;
  if (!frames?.length) return null;
  // Sentry orders frames outermost-first, so the innermost is last.
  const frame = [...frames].reverse().find((f) => f.in_app) ?? frames[frames.length - 1];
  const file = frame.filename?.split("/").slice(-2).join("/") ?? "?";
  return `${file}:${frame.function ?? "?"}`;
}

function eventMessage(event: FingerprintableEvent): string {
  const exc = capturedException(event);
  if (exc?.value) return exc.value;
  if (typeof event.message === "string") return event.message;
  if (event.message) return event.message.formatted ?? event.message.message ?? "";
  return event.logentry?.formatted ?? event.logentry?.message ?? "";
}

/**
 * Compute the grouping fingerprint for an event, or null to leave Sentry's default grouping alone.
 *
 * Returns null when the call site already set a fingerprint, and when there is nothing to normalize
 * (a message with no volatile identifiers groups correctly on its own — forcing a fingerprint there
 * would only detach it from its existing issue history).
 */
export function fingerprintForEvent(event: FingerprintableEvent): string[] | null {
  if (event.fingerprint?.length) return null;
  const message = eventMessage(event);
  if (!message) return null;
  const normalized = normalizeErrorMessage(message);
  if (normalized === message.trim()) return null;
  const type = capturedException(event)?.type ?? "message";
  const frame = topFrameKey(event);
  return frame ? [type, frame, normalized] : [type, normalized];
}

/**
 * `beforeSend` hook: stamps the normalized fingerprint onto outgoing events.
 *
 * Typed against the local structural interface and returned as-is, so it drops into
 * `Sentry.init({ beforeSend: normalizeEventFingerprint })` for any @sentry/deno version without
 * fighting its generics.
 */
// deno-lint-ignore no-explicit-any
export function normalizeEventFingerprint<T extends FingerprintableEvent>(event: T, _hint?: any): T {
  const fingerprint = fingerprintForEvent(event);
  if (fingerprint) event.fingerprint = fingerprint;
  return event;
}
