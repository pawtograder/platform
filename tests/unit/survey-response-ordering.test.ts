import { compareSurveyResponsesByProfile } from "@/types/survey";

describe("compareSurveyResponsesByProfile", () => {
  it("tiebreaks equal name and submitted_at by profile_email, not profile_id", () => {
    const shared = {
      profile_name: "Same Name",
      submitted_at: "2026-01-15T12:00:00.000Z",
      profiles: { name: "Same Name" }
    };
    const a = {
      ...shared,
      profile_id: "00000000-0000-4000-8000-000000000001",
      profile_email: "student-b@pawtograder.net"
    };
    const b = {
      ...shared,
      profile_id: "00000000-0000-4000-8000-000000000099",
      profile_email: "student-a@pawtograder.net"
    };

    expect(compareSurveyResponsesByProfile(a, b)).toBeGreaterThan(0);
    expect(compareSurveyResponsesByProfile(b, a)).toBeLessThan(0);
  });

  it("falls back to sortable_name when profile_email is missing", () => {
    const shared = {
      profile_name: "Same Name",
      submitted_at: "2026-01-15T12:00:00.000Z"
    };
    const a = {
      ...shared,
      profile_id: "uuid-a",
      profiles: { name: "Same Name", sortable_name: "Student, B" }
    };
    const b = {
      ...shared,
      profile_id: "uuid-z",
      profiles: { name: "Same Name", sortable_name: "Student, A" }
    };

    expect(compareSurveyResponsesByProfile(a, b)).toBeGreaterThan(0);
  });
});
