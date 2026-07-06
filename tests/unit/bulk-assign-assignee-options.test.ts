import {
  compareAssigneeOptions,
  getAssigneeDisplayLabel,
  getAssigneeOptionLabel
} from "@/app/course/[course_id]/manage/assignments/[assignment_id]/reviews/bulk-assign/assigneeOptions";

describe("bulk assign assignee options", () => {
  it("falls back to profile id when a profile name is null or blank", () => {
    expect(
      getAssigneeDisplayLabel({
        private_profile_id: "profile-1",
        profiles: { name: null }
      })
    ).toBe("profile-1");

    expect(
      getAssigneeDisplayLabel({
        private_profile_id: "profile-2",
        profiles: { name: "   " }
      })
    ).toBe("profile-2");
  });

  it("sorts selected options with null labels without throwing", () => {
    const options = [
      {
        label: "Zoe",
        value: { private_profile_id: "profile-z", profiles: { name: "Zoe" } }
      },
      {
        label: null,
        value: { private_profile_id: "profile-a", profiles: { name: null } }
      },
      {
        label: "Ada",
        value: { private_profile_id: "profile-b", profiles: { name: "Ada" } }
      }
    ];

    expect(() => [...options].sort(compareAssigneeOptions)).not.toThrow();
    expect([...options].sort(compareAssigneeOptions).map(getAssigneeOptionLabel)).toEqual(["Ada", "profile-a", "Zoe"]);
  });
});
