/**
 * @jest-environment node
 */
import {
  appendPath,
  decodeJwtPayload,
  membersToRoster,
  parseNextLink,
  surrogateSisId,
  type RosterEntry
} from "@/lib/lti/util";
import { ltiRolesToAppRole, LTI_ROLE, type NrpsMember } from "@/lib/lti/types";

describe("ltiRolesToAppRole", () => {
  test("maps Instructor (full URN) to instructor", () => {
    expect(ltiRolesToAppRole([LTI_ROLE.instructor])).toBe("instructor");
  });
  test("maps TA / ContentDeveloper to grader", () => {
    expect(ltiRolesToAppRole([LTI_ROLE.teachingAssistant])).toBe("grader");
    expect(ltiRolesToAppRole([LTI_ROLE.contentDeveloper])).toBe("grader");
  });
  test("defaults to student", () => {
    expect(ltiRolesToAppRole([LTI_ROLE.learner])).toBe("student");
    expect(ltiRolesToAppRole([])).toBe("student");
    expect(ltiRolesToAppRole(undefined)).toBe("student");
  });
  test("instructor outranks learner when both present", () => {
    expect(ltiRolesToAppRole([LTI_ROLE.learner, LTI_ROLE.instructor])).toBe("instructor");
  });
  test("accepts short role forms", () => {
    expect(ltiRolesToAppRole(["Instructor"])).toBe("instructor");
  });
});

describe("surrogateSisId", () => {
  test("is deterministic", () => {
    expect(surrogateSisId("abc-123")).toBe(surrogateSisId("abc-123"));
  });
  test("is positive and within int4 range", () => {
    for (const s of ["a", "user-9999", "x".repeat(64), "🦴"]) {
      const id = surrogateSisId(s);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(2_000_000_000);
      expect(Number.isInteger(id)).toBe(true);
    }
  });
  test("differs for different subs", () => {
    expect(surrogateSisId("alice")).not.toBe(surrogateSisId("bob"));
  });
});

describe("membersToRoster", () => {
  const member = (over: Partial<NrpsMember>): NrpsMember => ({
    user_id: "sub-1",
    roles: [LTI_ROLE.learner],
    ...over
  });

  test("prefers numeric lis_person_sourcedid as sis_user_id", () => {
    const [r] = membersToRoster([member({ lis_person_sourcedid: "778899" })]);
    expect(r.sis_user_id).toBe(778899);
  });

  test("falls back to surrogate for non-numeric sourcedid", () => {
    const [r] = membersToRoster([member({ user_id: "abc", lis_person_sourcedid: "NU-xyz" })]);
    expect(r.sis_user_id).toBe(surrogateSisId("abc"));
  });

  test("skips inactive members", () => {
    const roster = membersToRoster([
      member({ user_id: "a", status: "Active" }),
      member({ user_id: "b", status: "Inactive" }),
      member({ user_id: "c", status: "Deleted" })
    ]);
    expect(roster.map((r: RosterEntry) => r.sub)).toEqual(["a"]);
  });

  test("derives name from given/family when name missing", () => {
    const [r] = membersToRoster([member({ given_name: "Ada", family_name: "Lovelace" })]);
    expect(r.name).toBe("Ada Lovelace");
  });

  test("maps roles to app role", () => {
    const [r] = membersToRoster([member({ roles: [LTI_ROLE.instructor] })]);
    expect(r.role).toBe("instructor");
  });
});

describe("parseNextLink", () => {
  test("extracts rel=next", () => {
    const header = '<https://lms/x?page=1>; rel="prev", <https://lms/x?page=3>; rel="next"';
    expect(parseNextLink(header)).toBe("https://lms/x?page=3");
  });
  test("returns undefined when no next", () => {
    expect(parseNextLink('<https://lms/x>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe("appendPath", () => {
  test("inserts segment before query string", () => {
    expect(appendPath("https://lms/li/42?type_id=1", "/scores")).toBe("https://lms/li/42/scores?type_id=1");
  });
  test("handles trailing slash", () => {
    expect(appendPath("https://lms/li/42/", "/scores")).toBe("https://lms/li/42/scores");
  });
});

describe("decodeJwtPayload", () => {
  test("decodes base64url payload", () => {
    const payload = { sub: "abc", "custom claim": 1 };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const jwt = `header.${b64}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual(payload);
  });
  test("throws on malformed jwt", () => {
    expect(() => decodeJwtPayload("not-a-jwt")).toThrow();
  });
});
