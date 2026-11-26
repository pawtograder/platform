import { CAPABILITY_CATALOG, groupCapabilities } from "@/app/course/[course_id]/manage/course/roles/capabilityCatalog";

const row = (name: string) => ({ name, description: `Description of ${name}` });

test("groups known capabilities by app area and section, in app order", () => {
  const groups = groupCapabilities([
    row("manage_flashcards"),
    row("handle_regrades"),
    row("manage_assignments"),
    row("manage_gradebook")
  ]);
  expect(groups.map((group) => group.area)).toEqual(["Manage Assignments", "Gradebook", "Course Settings"]);
  expect(groups[0].sections.find((section) => section.name === "Grading")?.capabilities[0]).toEqual({
    name: "handle_regrades",
    label: "Handle regrades",
    info: CAPABILITY_CATALOG.handle_regrades.info
  });
});

test("keeps unknown database capabilities in Other with their description", () => {
  expect(groupCapabilities([row("future_action")])).toEqual([
    {
      area: "Other",
      sections: [
        {
          name: "Other capabilities",
          capabilities: [{ name: "future_action", label: "Future action", info: "Description of future_action" }]
        }
      ]
    }
  ]);
});

test("never offers manage_roles or capabilities absent from the database", () => {
  expect(groupCapabilities([row("manage_roles")])).toEqual([]);
  expect(groupCapabilities([])).toEqual([]);
  const groups = groupCapabilities(Object.keys(CAPABILITY_CATALOG).map(row));
  expect(groups.flatMap((group) => group.sections.flatMap((section) => section.capabilities))).toHaveLength(
    Object.keys(CAPABILITY_CATALOG).length
  );
});
