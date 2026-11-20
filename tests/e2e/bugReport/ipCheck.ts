/**
 * F7's check that Sentry stored no IP address with a report. The upload sends
 * `user: { id, ip_address: null }`, but relay still fills in `user.ip` from the ingress address
 * unless the org or project setting "Prevent storing of IP addresses" is on. Turning it on is a
 * human task, so until then F7 notes the IP instead of failing; with
 * BUG_REPORT_REQUIRE_NO_IP=1 a stored IP fails the test. No Playwright import, so the logic is
 * unit-tested (tests/unit/bugReport/ipCheck.test.ts).
 */

export const REQUIRE_NO_IP_ENV = "BUG_REPORT_REQUIRE_NO_IP";
export const IP_SETTING = 'the Sentry org or project setting "Prevent storing of IP addresses"';

/** `user` as the replay details API returns it (`ip`) and as the event API does (`ip_address`). */
type StoredUser = { ip?: unknown; ip_address?: unknown } | null | undefined;

export type IpCheck = {
  /** Where an IP was stored. The address itself is never included. */
  present: ("replay" | "feedback")[];
  /** Set when the test must fail. */
  failure?: string;
  /** Set when an IP was stored but the env var doesn't require its absence. */
  annotation?: { type: string; description: string };
};

function hasIp(user: StoredUser): boolean {
  const ip = user?.ip ?? user?.ip_address;
  return typeof ip === "string" && ip.length > 0;
}

export function checkStoredIp(
  stored: { replayUser: StoredUser; feedbackUser: StoredUser },
  env: Record<string, string | undefined> = process.env
): IpCheck {
  const present: IpCheck["present"] = [];
  if (hasIp(stored.replayUser)) present.push("replay");
  if (hasIp(stored.feedbackUser)) present.push("feedback");
  if (present.length === 0) return { present };
  const where = present.join(" and ");
  if (env[REQUIRE_NO_IP_ENV] === "1") {
    return {
      present,
      failure:
        `Sentry stored user.ip on the ${where}. Turn on ${IP_SETTING} (a human task), ` +
        `or unset ${REQUIRE_NO_IP_ENV} until it is on.`
    };
  }
  return {
    present,
    annotation: {
      type: "sentry-ip-stored",
      description:
        `Sentry stored user.ip on the ${where}; ${IP_SETTING} is off. ` +
        `Set ${REQUIRE_NO_IP_ENV}=1 to fail on this once the setting is on.`
    }
  };
}
