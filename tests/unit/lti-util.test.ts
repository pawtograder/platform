/**
 * @jest-environment node
 */
import {
  appendPath,
  COURSE_WIDE_CONFIG,
  decodeJwtPayload,
  extractSectionNames,
  ltiClientIdMatches,
  mapRoster,
  membersToRoster,
  parseNextLink,
  resolveMemberSections,
  surrogateSisId,
  type RosterEntry,
  type SectionConfig
} from "@/lib/lti/util";
import { LTI_CLAIM, ltiRolesToAppRole, LTI_ROLE, type NrpsMember } from "@/lib/lti/types";

describe("ltiRolesToAppRole", () => {
  test("maps Instructor (full URN) to instructor", () => {
    expect(ltiRolesToAppRole([LTI_ROLE.instructor])).toBe("instructor");
  });
  test("maps TA / ContentDeveloper to grader", () => {
    expect(ltiRolesToAppRole([LTI_ROLE.teachingAssistant])).toBe("grader");
    expect(ltiRolesToAppRole([LTI_ROLE.contentDeveloper])).toBe("grader");
  });
  test("maps a Canvas TA (sub-role + co-sent base Instructor) to grader, not instructor", () => {
    // Canvas (substitutions_helper) sends a TA as the sub-role AND the base role.
    expect(
      ltiRolesToAppRole([
        "http://purl.imsglobal.org/vocab/lis/v2/membership/instructor#TeachingAssistant",
        "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"
      ])
    ).toBe("grader");
    // A plain instructor (no grader sub-role) still maps to instructor.
    expect(ltiRolesToAppRole(["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"])).toBe("instructor");
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

describe("extractSectionNames", () => {
  const withSectionNames = (value: unknown): NrpsMember => ({
    user_id: "sub-1",
    roles: [LTI_ROLE.learner],
    message: [{ [LTI_CLAIM.custom]: { section_names: value } }]
  });

  test("parses a JSON-array string", () => {
    expect(extractSectionNames(withSectionNames('["L05 Mon","L06 Tue"]'))).toEqual(["L05 Mon", "L06 Tue"]);
  });
  test("parses a comma-joined string", () => {
    expect(extractSectionNames(withSectionNames("L05 Mon, L06 Tue"))).toEqual(["L05 Mon", "L06 Tue"]);
  });
  test("accepts a real array", () => {
    expect(extractSectionNames(withSectionNames(["L05", "L06"]))).toEqual(["L05", "L06"]);
  });
  test("returns [] when the custom claim is absent", () => {
    expect(extractSectionNames({ user_id: "x", roles: [] })).toEqual([]);
    expect(extractSectionNames({ user_id: "x", roles: [], message: [{ foo: "bar" }] })).toEqual([]);
  });
  test("returns [] when section_names is missing in custom", () => {
    expect(extractSectionNames({ user_id: "x", roles: [], message: [{ [LTI_CLAIM.custom]: { other: "1" } }] })).toEqual(
      []
    );
  });
  test("de-dups across message entries", () => {
    const m: NrpsMember = {
      user_id: "x",
      roles: [],
      message: [{ [LTI_CLAIM.custom]: { section_names: "L05" } }, { [LTI_CLAIM.custom]: { section_names: "L05,L06" } }]
    };
    expect(extractSectionNames(m)).toEqual(["L05", "L06"]);
  });
});

describe("resolveMemberSections / mapRoster", () => {
  const member = (over: Partial<NrpsMember>): NrpsMember => ({ user_id: "sub-1", roles: [LTI_ROLE.learner], ...over });
  const withNames = (names: string[]): NrpsMember =>
    member({ message: [{ [LTI_CLAIM.custom]: { section_names: JSON.stringify(names) } }] });

  test("course_wide assigns no sections (regression)", () => {
    const r = resolveMemberSections(member({}), COURSE_WIDE_CONFIG);
    expect(r).toEqual({ class_section_crn: null, lab_section_crn: null, unmappedNames: [] });
    const [entry] = membersToRoster([member({})]);
    expect(entry.class_section_crn).toBeNull();
    expect(entry.lab_section_crn).toBeNull();
  });

  test("context-level lecture sets the lecture CRN only", () => {
    const cfg: SectionConfig = {
      sectionRole: "lecture",
      classSectionCrn: 11111,
      labSectionCrn: null,
      splitByMemberSection: false,
      nameMap: new Map()
    };
    const r = resolveMemberSections(member({}), cfg);
    expect(r.class_section_crn).toBe(11111);
    expect(r.lab_section_crn).toBeNull();
  });

  test("context-level lab sets the lab CRN only", () => {
    const cfg: SectionConfig = {
      sectionRole: "lab",
      classSectionCrn: null,
      labSectionCrn: 22222,
      splitByMemberSection: false,
      nameMap: new Map()
    };
    const r = resolveMemberSections(member({}), cfg);
    expect(r.lab_section_crn).toBe(22222);
    expect(r.class_section_crn).toBeNull();
  });

  test("split: maps known section names and reports unmapped", () => {
    const cfg: SectionConfig = {
      sectionRole: "lab",
      classSectionCrn: null,
      labSectionCrn: null,
      splitByMemberSection: true,
      nameMap: new Map([["L05", { classSectionCrn: null, labSectionCrn: 22222 }]])
    };
    const mapped = resolveMemberSections(withNames(["L05"]), cfg);
    expect(mapped).toEqual({ class_section_crn: null, lab_section_crn: 22222, unmappedNames: [] });

    const unmapped = resolveMemberSections(withNames(["L99"]), cfg);
    expect(unmapped.lab_section_crn).toBeNull();
    expect(unmapped.unmappedNames).toEqual(["L99"]);

    const { roster, unmapped: allUnmapped } = mapRoster([withNames(["L05"]), withNames(["L99"])], cfg);
    expect(roster[0].lab_section_crn).toBe(22222);
    expect(roster[1].lab_section_crn).toBeNull();
    expect(allUnmapped).toEqual(["L99"]);
  });

  test("split: a member in two sections maps the known one and reports the other", () => {
    const cfg: SectionConfig = {
      sectionRole: "lab",
      classSectionCrn: null,
      labSectionCrn: null,
      splitByMemberSection: true,
      nameMap: new Map([["L05", { classSectionCrn: null, labSectionCrn: 22222 }]])
    };
    const r = resolveMemberSections(withNames(["L05", "L99"]), cfg);
    expect(r.lab_section_crn).toBe(22222);
    expect(r.unmappedNames).toEqual(["L99"]);
  });
});

describe("ltiClientIdMatches", () => {
  test("exact match", () => {
    expect(ltiClientIdMatches("10000000000003", "10000000000003")).toBe(true);
    expect(ltiClientIdMatches("3", "3")).toBe(true);
  });
  test("bridges a global id to its Canvas local-id form (either order)", () => {
    expect(ltiClientIdMatches("10000000000003", "3")).toBe(true);
    expect(ltiClientIdMatches("3", "10000000000003")).toBe(true);
  });
  test("does not match distinct keys", () => {
    expect(ltiClientIdMatches("10000000000003", "4")).toBe(false);
    expect(ltiClientIdMatches("3", "4")).toBe(false);
  });
  test("does not match two distinct globals that share a local component", () => {
    expect(ltiClientIdMatches("10000000000003", "20000000000003")).toBe(false);
  });
  test("non-numeric ids fall back to exact comparison", () => {
    expect(ltiClientIdMatches("abc", "abc")).toBe(true);
    expect(ltiClientIdMatches("abc", "def")).toBe(false);
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
