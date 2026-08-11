// Pure resolution of "can this deployment send notification email, and with what settings?".
//
// Two failures motivate this. First, the processor decided by reading SMTP_HOST and, when it was
// unset, returning `false` — which its caller reads as "no work found". That is indistinguishable
// from an empty queue: no throw, no Sentry, no metric, so the loop slept and re-read the same
// messages forever while the queue grew. Notification email had never worked in production and
// nothing said so.
//
// Second, the variable names disagreed with the deployment. The chart's `pawtograder-smtp` Secret
// (shared with GoTrue) provides SMTP_PASS and SMTP_ADMIN_EMAIL; this code read SMTP_PASSWORD and
// SMTP_FROM. Mounting that Secret without reconciling the names would have produced auth failures
// and a literal `From: Pawtograder <undefined>`.
//
// Injectable env reader for the same reason as SentryContext.ts: the truth table below is the part
// worth testing, and it should be testable without a Deno.serve host.

export type EnvReader = (key: string) => string | undefined;

export type EmailTransportDecision =
  | { kind: "disabled"; reason: "explicitly_disabled" | "no_smtp_host" }
  | { kind: "misconfigured"; missing: string[] }
  | {
      kind: "ready";
      host: string;
      port: number;
      user: string;
      pass: string;
      from: string;
      replyTo: string | undefined;
      secure: boolean;
      requireTLS: boolean;
      ignoreTLS: boolean;
    };

const INBUCKET_PORT = "54325";
/** The only port that speaks TLS from the first byte. Everything else negotiates with STARTTLS. */
const IMPLICIT_TLS_PORT = 465;

function readBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

// TRIMMED, not raw. A Secret value written with `echo` carries a trailing newline, and an
// untrimmed " 2525" fails the exact-match port comparisons below — selecting implicit TLS against a
// STARTTLS port, so every send fails at the handshake with nothing pointing at the whitespace.
function firstNonEmpty(readEnv: EnvReader, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readEnv(key);
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Truth table:
 *
 * | EMAIL_ENABLED | SMTP_HOST | decision                      | runtime behavior            |
 * |---------------|-----------|-------------------------------|------------------------------|
 * | false         | any       | disabled/explicitly_disabled  | archive, log once, no Sentry |
 * | true          | present   | ready (or misconfigured)      | send                         |
 * | true          | missing   | misconfigured                 | throw + Sentry (loud refusal)|
 * | unset         | present   | ready                         | send                         |
 * | unset         | missing   | disabled/no_smtp_host         | defer + Sentry message       |
 *
 * Orthogonal to the table: a bad SMTP_PORT or a missing SMTP_FROM is `misconfigured` in every row
 * that reaches a host, because neither has a usable default. SMTP_PASS is only required under an
 * explicit EMAIL_ENABLED=true — see the comment at the check itself.
 *
 * The "unset infers from SMTP_HOST" rows are deliberate. A hard "unset means off" would silently
 * kill notification email in every environment that works today — local Inbucket, staging — the
 * moment this ships and before anyone edits a values file. Explicit EMAIL_ENABLED=true in staging
 * and production then buys the loud refusal, because there the absence of SMTP_HOST is a genuine
 * misconfiguration rather than a deliberate opt-out.
 */
export function resolveEmailTransport(readEnv: EnvReader): EmailTransportDecision {
  const enabled = readBool(readEnv("EMAIL_ENABLED"));
  const host = firstNonEmpty(readEnv, "SMTP_HOST");

  if (enabled === false) {
    return { kind: "disabled", reason: "explicitly_disabled" };
  }

  if (enabled === true && !host) {
    return { kind: "misconfigured", missing: ["SMTP_HOST"] };
  }

  if (!host) {
    return { kind: "disabled", reason: "no_smtp_host" };
  }

  // SMTP_PASS first: that is the name the chart Secret and GoTrue use, so one Secret can serve
  // both. SMTP_PASSWORD stays as a fallback so the pre-existing OpenBao edge bundle keeps working
  // with no coordinated change.
  const pass = firstNonEmpty(readEnv, "SMTP_PASS", "SMTP_PASSWORD");
  // Likewise SMTP_ADMIN_EMAIL is what pawtograder-smtp actually carries.
  const from = firstNonEmpty(readEnv, "SMTP_FROM", "SMTP_ADMIN_EMAIL");
  const user = firstNonEmpty(readEnv, "SMTP_USER");

  const portRaw = firstNonEmpty(readEnv, "SMTP_PORT") ?? String(IMPLICIT_TLS_PORT);
  const isInbucket = portRaw === INBUCKET_PORT;
  const port = Number.parseInt(portRaw, 10);

  // SMTP_FROM is required unconditionally — there is no send without an envelope sender, and a
  // missing one is what produced the literal `From: Pawtograder <undefined>` this module exists to
  // stop. SMTP_PASS is NOT: plenty of legitimate targets need no auth at all (local Inbucket on
  // 54325, an IP-allowlisted campus relay, the chart's in-cluster socat relay), so requiring it
  // whenever SMTP_HOST is set would resolve `misconfigured` — which the processor throws on — and
  // stop mail in deployments that send it today. That contradicts the `| unset | present | ready |`
  // row above, which exists precisely so shipping this does not go dark anywhere. Under an explicit
  // EMAIL_ENABLED=true a missing credential IS a genuine misconfiguration, and the loud refusal is
  // the whole point of the opt-in.
  const missing: string[] = [];
  if (!Number.isFinite(port) || port <= 0 || port > 65535) missing.push("SMTP_PORT");
  if (!from) missing.push("SMTP_FROM");
  if (enabled === true && !pass) missing.push("SMTP_PASS");
  if (missing.length > 0) {
    return { kind: "misconfigured", missing };
  }

  return {
    kind: "ready",
    host,
    port,
    user: user ?? "",
    pass: pass ?? "",
    from: from!,
    replyTo: firstNonEmpty(readEnv, "SMTP_REPLY_TO"),
    // Keyed on 465 vs "anything else", not on an allowlist of two known ports. The previous shape
    // hardcoded 2525 (Postmark) and 54325 (Inbucket) as the only non-implicit-TLS ports, which
    // silently mishandles 587 -- the standard submission port, and the value the chart README
    // documents for the pawtograder-smtp Secret this commit now mounts into the edge runtime. 587
    // would have resolved `secure: true`, opening an implicit-TLS handshake against a port that
    // does not speak TLS until STARTTLS, so every send fails at connect while EMAIL_ENABLED=true
    // actively asserts email should be working.
    secure: port === IMPLICIT_TLS_PORT,
    requireTLS: !isInbucket && port !== IMPLICIT_TLS_PORT,
    ignoreTLS: isInbucket
  };
}
