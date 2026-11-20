/**
 * The F7 check on stored IP addresses (tests/e2e/bugReport/ipCheck.ts), without Sentry: a
 * stored IP is noted, and fails only when BUG_REPORT_REQUIRE_NO_IP=1.
 */
import { checkStoredIp, REQUIRE_NO_IP_ENV } from "@/tests/e2e/bugReport/ipCheck";

const ip = "10.0.3.17";

describe("checkStoredIp", () => {
  it("passes quietly when neither the replay nor the feedback has an IP", () => {
    expect(checkStoredIp({ replayUser: { ip: null }, feedbackUser: { ip_address: null } }, {})).toEqual({
      present: []
    });
    expect(checkStoredIp({ replayUser: undefined, feedbackUser: {} }, { [REQUIRE_NO_IP_ENV]: "1" })).toEqual({
      present: []
    });
  });

  it("annotates, without failing, when an IP is stored and the env var is unset", () => {
    const r = checkStoredIp({ replayUser: { ip }, feedbackUser: { ip_address: ip } }, {});
    expect(r.present).toEqual(["replay", "feedback"]);
    expect(r.failure).toBeUndefined();
    expect(r.annotation?.type).toBe("sentry-ip-stored");
    expect(r.annotation?.description).toContain("Prevent storing of IP addresses");
    expect(r.annotation?.description).not.toContain(ip);
  });

  it("fails naming the setting when an IP is stored and BUG_REPORT_REQUIRE_NO_IP=1", () => {
    const r = checkStoredIp({ replayUser: { ip }, feedbackUser: null }, { [REQUIRE_NO_IP_ENV]: "1" });
    expect(r.present).toEqual(["replay"]);
    expect(r.failure).toContain('"Prevent storing of IP addresses"');
    expect(r.failure).toContain("replay");
    expect(r.failure).not.toContain(ip);
    expect(r.annotation).toBeUndefined();
  });

  it("only treats the exact value 1 as required", () => {
    const r = checkStoredIp({ replayUser: null, feedbackUser: { ip_address: ip } }, { [REQUIRE_NO_IP_ENV]: "0" });
    expect(r.failure).toBeUndefined();
    expect(r.annotation).toBeDefined();
  });
});
