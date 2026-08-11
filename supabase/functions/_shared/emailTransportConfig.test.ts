import { assertEquals } from "jsr:@std/assert@^1";
import { resolveEmailTransport, type EnvReader } from "./emailTransportConfig.ts";

function env(vars: Record<string, string | undefined>): EnvReader {
  return (key: string) => vars[key];
}

const FULL = {
  SMTP_HOST: "smtp.example.edu",
  SMTP_USER: "apikey",
  SMTP_PASS: "secret",
  SMTP_FROM: "noreply@example.edu"
};

// --- the truth table ------------------------------------------------------

Deno.test("EMAIL_ENABLED=false disables regardless of SMTP config", () => {
  const d = resolveEmailTransport(env({ ...FULL, EMAIL_ENABLED: "false" }));
  assertEquals(d, { kind: "disabled", reason: "explicitly_disabled" });
});

Deno.test("EMAIL_ENABLED accepts the usual spellings of false", () => {
  for (const raw of ["false", "FALSE", "0", "no", "off", " No "]) {
    assertEquals(resolveEmailTransport(env({ ...FULL, EMAIL_ENABLED: raw })).kind, "disabled", raw);
  }
});

Deno.test("an unrecognized EMAIL_ENABLED is misconfigured, NOT a silent fall back to inference", () => {
  // The trap: folding "disabled"/"none"/a typo into `undefined` sent it down the "unset infers from
  // SMTP_HOST" row, and SMTP_HOST is supplied by the mounted Secret — so a deployment the operator
  // believed they had switched off would start mailing students.
  for (const raw of ["disabled", "none", "ture", "y", "enabled"]) {
    assertEquals(resolveEmailTransport(env({ ...FULL, EMAIL_ENABLED: raw })), {
      kind: "misconfigured",
      missing: ["EMAIL_ENABLED"]
    });
  }
});

Deno.test("EMAIL_ENABLED=true with SMTP_HOST is ready", () => {
  assertEquals(resolveEmailTransport(env({ ...FULL, EMAIL_ENABLED: "true" })).kind, "ready");
});

Deno.test("EMAIL_ENABLED=true without SMTP_HOST is misconfigured, not disabled", () => {
  // The loud refusal: this is the state that used to defer the queue forever in silence.
  const d = resolveEmailTransport(env({ EMAIL_ENABLED: "true", SMTP_HOST: undefined }));
  assertEquals(d, { kind: "misconfigured", missing: ["SMTP_HOST"] });
});

Deno.test("EMAIL_ENABLED unset with SMTP_HOST still sends", () => {
  // Backwards compatibility: local dev and staging must not go dark on deploy.
  assertEquals(resolveEmailTransport(env(FULL)).kind, "ready");
});

Deno.test("EMAIL_ENABLED unset without SMTP_HOST is disabled with a distinguishable reason", () => {
  assertEquals(resolveEmailTransport(env({})), { kind: "disabled", reason: "no_smtp_host" });
});

Deno.test("an empty-string SMTP_HOST counts as absent", () => {
  assertEquals(resolveEmailTransport(env({ SMTP_HOST: "" })), { kind: "disabled", reason: "no_smtp_host" });
});

// --- name reconciliation --------------------------------------------------

Deno.test("SMTP_PASS wins over SMTP_PASSWORD", () => {
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PASS: "from-pass", SMTP_PASSWORD: "from-password" }));
  assertEquals(d.kind === "ready" && d.pass, "from-pass");
});

Deno.test("SMTP_PASSWORD alone still resolves, so the legacy edge bundle keeps working", () => {
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PASS: undefined, SMTP_PASSWORD: "legacy" }));
  assertEquals(d.kind === "ready" && d.pass, "legacy");
});

Deno.test("SMTP_FROM wins over SMTP_ADMIN_EMAIL", () => {
  const d = resolveEmailTransport(env({ ...FULL, SMTP_ADMIN_EMAIL: "admin@example.edu" }));
  assertEquals(d.kind === "ready" && d.from, "noreply@example.edu");
});

Deno.test("SMTP_ADMIN_EMAIL alone resolves — it is what the chart Secret actually carries", () => {
  // Without this fallback, mounting pawtograder-smtp yields `From: Pawtograder <undefined>`.
  const d = resolveEmailTransport(env({ ...FULL, SMTP_FROM: undefined, SMTP_ADMIN_EMAIL: "admin@example.edu" }));
  assertEquals(d.kind === "ready" && d.from, "admin@example.edu");
});

Deno.test("a host with no from address is misconfigured — there is no send without a sender", () => {
  const d = resolveEmailTransport(env({ SMTP_HOST: "smtp.example.edu" }));
  assertEquals(d, { kind: "misconfigured", missing: ["SMTP_FROM"] });
});

Deno.test("an auth-less relay is ready when EMAIL_ENABLED is unset", () => {
  // Inbucket, an IP-allowlisted campus relay and the chart's in-cluster socat relay all take mail
  // with no credentials. Requiring SMTP_PASS here would resolve `misconfigured`, which the
  // processor throws on — so shipping this would stop mail in deployments that send it today, and
  // contradict the `| unset | present | ready |` row of the truth table.
  const d = resolveEmailTransport(env({ SMTP_HOST: "localhost", SMTP_PORT: "54325", SMTP_FROM: "dev@example.edu" }));
  assertEquals(d.kind, "ready");
  assertEquals(d.kind === "ready" && d.pass, "");
});

Deno.test("EMAIL_ENABLED=true makes the credential mandatory", () => {
  // The opt-in is what buys the loud refusal: here an absent SMTP_PASS is a real misconfiguration.
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PASS: undefined, EMAIL_ENABLED: "true" }));
  assertEquals(d, { kind: "misconfigured", missing: ["SMTP_PASS"] });
});

Deno.test("an unparseable SMTP_PORT is misconfigured rather than a NaN port", () => {
  assertEquals(resolveEmailTransport(env({ ...FULL, SMTP_PORT: "not-a-port" })), {
    kind: "misconfigured",
    missing: ["SMTP_PORT"]
  });
});

Deno.test("a SMTP_PORT with trailing garbage is misconfigured, not silently truncated", () => {
  // parseInt("587 (submission)") is 587 and parseInt("46 5") is 46, so a leading-digit guard alone
  // lets a malformed Secret through as a plausible-looking port.
  for (const raw of ["587 (submission)", "46 5", "465x", "4.65", "-465", "0x1d5"]) {
    assertEquals(resolveEmailTransport(env({ ...FULL, SMTP_PORT: raw })), {
      kind: "misconfigured",
      missing: ["SMTP_PORT"]
    });
  }
});

Deno.test("whitespace around a value does not change the transport", () => {
  // A Secret written with `echo` carries a trailing newline; an untrimmed " 2525" would miss the
  // exact-match port comparison and select implicit TLS against a STARTTLS port.
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PORT: " 2525\n", SMTP_HOST: " smtp.example.edu " }));
  assertEquals(d.kind === "ready" && [d.host, d.port, d.secure, d.requireTLS], ["smtp.example.edu", 2525, false, true]);
});

// --- port / TLS matrix ----------------------------------------------------

Deno.test("default port 465 uses implicit TLS", () => {
  const d = resolveEmailTransport(env(FULL));
  assertEquals(d.kind === "ready" && [d.port, d.secure, d.requireTLS, d.ignoreTLS], [465, true, false, false]);
});

Deno.test("port 2525 (Postmark relay) uses STARTTLS", () => {
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PORT: "2525" }));
  assertEquals(d.kind === "ready" && [d.port, d.secure, d.requireTLS, d.ignoreTLS], [2525, false, true, false]);
});

Deno.test("port 587 (standard submission) uses STARTTLS, not implicit TLS", () => {
  // 587 is what charts/pawtograder/README.md documents for the pawtograder-smtp Secret, which is
  // now mounted into the edge runtime. Treating it as implicit TLS opens the handshake against a
  // port that only speaks TLS after STARTTLS, so every send fails at connect.
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PORT: "587" }));
  assertEquals(d.kind === "ready" && [d.port, d.secure, d.requireTLS, d.ignoreTLS], [587, false, true, false]);
});

Deno.test("an unknown relay port defaults to STARTTLS rather than implicit TLS", () => {
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PORT: "25" }));
  assertEquals(d.kind === "ready" && [d.port, d.secure, d.requireTLS], [25, false, true]);
});

Deno.test("port 54325 (local Inbucket) disables TLS entirely", () => {
  const d = resolveEmailTransport(env({ ...FULL, SMTP_PORT: "54325" }));
  assertEquals(d.kind === "ready" && [d.port, d.secure, d.requireTLS, d.ignoreTLS], [54325, false, false, true]);
});

Deno.test("reply-to is optional and passes through", () => {
  assertEquals(resolveEmailTransport(env(FULL)).kind === "ready", true);
  const d = resolveEmailTransport(env({ ...FULL, SMTP_REPLY_TO: "help@example.edu" }));
  assertEquals(d.kind === "ready" && d.replyTo, "help@example.edu");
});
