"use client";

import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { Box, Text } from "@chakra-ui/react";
import { Select as ChakraReactSelect, OptionBase } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type StudentOption = OptionBase & { label: string; value: string };

/**
 * Lets an instructor switch into the read-only view of a real enrolled student.
 *
 * The Test Assignment preview is a synthetic student identity over the instructor's own profile,
 * so the pages that need a real `role = 'student'` enrollment (the assignments dashboard, the
 * course-home upcoming panel) have nothing to show for it and it is bounded to the assignment it
 * was entered from. Picking an enrolled student is the path that gives a course-wide student view;
 * this puts it within reach of the places staff look for one instead of only on the student
 * summary page (issue #892).
 *
 * Instructors only: graders cannot masquerade as an enrolled student (`useClassProfiles` and
 * `getEffectiveCourseIdentity` both refuse it), so offering them the control would be a dead end.
 * The roster is fetched here rather than read from the course controller because that controller is
 * built under the *effective* identity — while the self-preview is active it is scoped to a
 * student and carries no roster. RLS still evaluates against the instructor's real session.
 */
/** One string for both the accessible name and the visible label, so they cannot drift (WCAG 2.5.3). */
const PICKER_LABEL = "View the course as a student";

export function ViewAsStudentPicker({ showLabel = false }: { showLabel?: boolean }) {
  const { course_id } = useParams();
  const { realRole, enterViewAs } = useClassProfiles();
  const [students, setStudents] = useState<StudentOption[] | null>(null);

  const isInstructor = realRole === "instructor";

  useEffect(() => {
    if (!isInstructor || !course_id) {
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // Page through the roster: PostgREST caps a response at 1000 rows, and courses here run
      // larger than that, so a single request would silently drop the tail of the alphabet.
      const pageSize = 1000;
      const collected: (StudentOption & { sortKey: string })[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from("user_roles")
          .select("private_profile_id, profiles!private_profile_id(name, sortable_name)")
          .eq("class_id", Number(course_id))
          .eq("role", "student")
          .eq("disabled", false)
          // Order server-side on the same key the list is presented by, so paging is stable.
          .order("private_profile_id", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (cancelled) {
          return;
        }
        if (error) {
          break;
        }
        collected.push(
          ...(data ?? []).map((row) => ({
            label: row.profiles?.name ?? "Student",
            value: row.private_profile_id,
            sortKey: row.profiles?.sortable_name ?? row.profiles?.name ?? ""
          }))
        );
        if (!data || data.length < pageSize) {
          break;
        }
      }
      if (cancelled) {
        return;
      }
      setStudents(
        collected.sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ label, value }) => ({ label, value }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [course_id, isInstructor]);

  const options = useMemo(() => students ?? [], [students]);

  if (!isInstructor) {
    return null;
  }

  return (
    <Box minW={{ base: "100%", md: "280px" }}>
      {showLabel && (
        <Text fontSize="xs" mb={1}>
          {PICKER_LABEL}
        </Text>
      )}
      <ChakraReactSelect<StudentOption>
        aria-label={PICKER_LABEL}
        placeholder={students === null ? "Loading students…" : "View as a student…"}
        isLoading={students === null}
        isClearable={false}
        size="sm"
        options={options}
        // Chakra's menu is portaled to the body so it is not clipped by the sticky banner.
        menuPortalTarget={typeof document === "undefined" ? undefined : document.body}
        styles={{ menuPortal: (base) => ({ ...base, zIndex: 2000 }) }}
        onChange={(option) => {
          const profileId = (option as StudentOption | null)?.value;
          if (!profileId) {
            return;
          }
          // Land on the student assignments dashboard: it is the surface the self-preview could
          // never populate, and the one instructors go looking for.
          enterViewAs(profileId, `/course/${course_id}/assignments`);
        }}
      />
    </Box>
  );
}
