"use client";

import { Button } from "@/components/ui/button";
import {
  DialogActionTrigger,
  DialogBackdrop,
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle
} from "@/components/ui/dialog";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { HStack, Text } from "@chakra-ui/react";
import { Select as ChakraReactSelect, OptionBase } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FaEye } from "react-icons/fa";

type StudentOption = OptionBase & { label: string; value: string };

const PICKER_LABEL = "Student to view as";

/**
 * Entry point for the read-only "view as student" mode: a button that opens a student picker and
 * enters that student's view of the course.
 *
 * Previously this mode was only reachable from a single student's summary page, so instructors
 * looking for "show me what students see" found the Test Assignment preview instead — which is
 * their own staff profile wearing a student's view, covers one assignment, and leaves
 * enrollment-keyed pages such as the assignments dashboard empty (issue #892). Viewing a real
 * enrolled student is the mode that shows the whole course, so it needs a way in from the top.
 *
 * Instructors only: graders cannot masquerade as an enrolled student (`useClassProfiles` and
 * `getEffectiveCourseIdentity` both refuse it), so offering them the control would be a dead end.
 */
export function ViewAsStudentButton() {
  const { course_id } = useParams();
  const { realRole, isViewingAsStudent, enterViewAs } = useClassProfiles();
  const [open, setOpen] = useState(false);
  const [students, setStudents] = useState<StudentOption[] | null>(null);
  const [selected, setSelected] = useState<StudentOption | null>(null);
  // A failed page must not commit as a successful (possibly partial) roster: an empty picker looks
  // like a course with no students, and a partial one looks complete while stopping mid-roster.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // The menu is portaled into the dialog content, not the body: a modal dialog sets
  // `pointer-events: none` outside its content, so a body-portaled menu renders and reads correctly
  // but silently swallows every click. Held in state (not a ref) so the node is available on the
  // render that follows mount, before the menu can be opened.
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);

  const isInstructor = realRole === "instructor";
  // The roster is fetched here rather than read from the course controller because that controller
  // is built under the *effective* identity, which carries no roster while a view-as is active.
  // RLS still evaluates against the instructor's real session.
  const shouldLoad = isInstructor && open && students === null;

  useEffect(() => {
    if (!shouldLoad || !course_id) {
      return;
    }
    let cancelled = false;
    setLoadError(null);
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
          // Order server-side on a unique key so paging is stable; presentation order is applied
          // below, once every page is in hand.
          .order("private_profile_id", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (cancelled) {
          return;
        }
        if (error) {
          setLoadError(error.message);
          return;
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
  }, [course_id, shouldLoad, reloadNonce]);

  // Hidden while a view-as is already active: the banner owns exiting and switching from there.
  if (!isInstructor || isViewingAsStudent) {
    return null;
  }

  return (
    <DialogRoot open={open} onOpenChange={(details) => setOpen(details.open)} size="sm">
      <DialogBackdrop />
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FaEye aria-hidden />
        View as student
      </Button>
      <DialogContent ref={setMenuPortalTarget}>
        <DialogHeader>
          <DialogTitle>View as student</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Text fontSize="sm" color="fg.muted" mb={3}>
            See the course exactly as one of your students sees it — assignments, grades, and feedback, all read only.
          </Text>
          {/* Visible label and accessible name are the same string, so they cannot drift (WCAG 2.5.3). */}
          <Text fontSize="sm" mb={1}>
            {PICKER_LABEL}
          </Text>
          {loadError ? (
            <HStack gap={3} align="center">
              <Text fontSize="sm" color="fg.error" role="alert">
                Could not load the student list. {loadError}
              </Text>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setLoadError(null);
                  setReloadNonce((nonce) => nonce + 1);
                }}
              >
                Retry
              </Button>
            </HStack>
          ) : (
            <ChakraReactSelect<StudentOption>
              aria-label={PICKER_LABEL}
              placeholder={students === null ? "Loading students…" : "Search students…"}
              isLoading={students === null}
              isClearable={false}
              size="sm"
              autoFocus
              value={selected}
              options={students ?? []}
              onChange={(option) => setSelected(option as StudentOption | null)}
              menuPortalTarget={menuPortalTarget}
              styles={{ menuPortal: (base) => ({ ...base, zIndex: 2000 }) }}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <DialogActionTrigger asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogActionTrigger>
          {/* Named to mirror the banner's "Exit student view", and to stay distinct from the
              trigger button's name. */}
          <Button
            size="sm"
            colorPalette="orange"
            disabled={!selected}
            onClick={() => {
              if (selected) {
                enterViewAs(selected.value);
              }
            }}
          >
            Enter student view
          </Button>
        </DialogFooter>
        <DialogCloseTrigger />
      </DialogContent>
    </DialogRoot>
  );
}
