"use client";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { Checkbox } from "@/components/ui/checkbox";
import Link from "@/components/ui/link";
import PersonName from "@/components/ui/person-name";
import { toaster } from "@/components/ui/toaster";
import { useAssignmentController, useAssignmentGroups } from "@/hooks/useAssignment";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  useCanShowGradeFor,
  useClassSections,
  useCourseController,
  useObfuscatedGradesMode,
  useSetOnlyShowGradesFor
} from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import TableController from "@/lib/TableController";
import { useTimeZone } from "@/lib/TimeZoneProvider";
import { createClient } from "@/utils/supabase/client";
import {
  ActiveSubmissionsWithGradesForAssignment,
  GraderResultTest,
  RubricCheck
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Box,
  Button,
  HStack,
  Icon,
  IconButton,
  NativeSelect,
  Popover,
  Skeleton,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import * as Sentry from "@sentry/nextjs";
import { SupabaseClient } from "@supabase/supabase-js";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { formatInTimeZone } from "date-fns-tz";
import { useParams, useRouter } from "next/navigation";
import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaCheck, FaSort, FaSortDown, FaSortUp, FaTimes } from "react-icons/fa";
import { TbEye, TbEyeOff } from "react-icons/tb";

function StudentNameCell({
  course_id,
  assignment_id,
  uid,
  activeSubmissionId
}: {
  course_id: string;
  assignment_id: string;
  uid: string;
  activeSubmissionId: number | null;
}) {
  const isObfuscated = useObfuscatedGradesMode();
  const canShowGradeFor = useCanShowGradeFor(uid);
  const setOnlyShowGradesFor = useSetOnlyShowGradesFor();
  const toggleOnlyShowGradesFor = useCallback(() => {
    setOnlyShowGradesFor(canShowGradeFor ? "" : uid);
  }, [setOnlyShowGradesFor, uid, canShowGradeFor]);

  return (
    <HStack w="100%">
      {activeSubmissionId !== null ? (
        <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${activeSubmissionId}`}>
          <PersonName uid={uid} showAvatar={false} />
        </Link>
      ) : (
        <PersonName uid={uid} showAvatar={false} />
      )}
      <Box flex="1" display="flex" justifyContent="flex-end">
        {isObfuscated && (
          <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={toggleOnlyShowGradesFor}>
            <Icon as={canShowGradeFor ? TbEyeOff : TbEye} />
          </IconButton>
        )}
      </Box>
    </HStack>
  );
}

function ScoreLink({
  score,
  private_profile_id,
  submission_id,
  course_id,
  assignment_id
}: {
  score: number;
  private_profile_id: string;
  submission_id: number;
  course_id: string;
  assignment_id: string;
}) {
  const isObfuscated = useObfuscatedGradesMode();
  const canShowGradeFor = useCanShowGradeFor(private_profile_id);
  if (isObfuscated && !canShowGradeFor) {
    return <Skeleton w="50px" h="1em" />;
  }
  return <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${submission_id}`}>{score}</Link>;
}
export default function AssignmentsTable({
  tableController: providedTableController
}: {
  tableController?: TableController<"submissions"> | null;
} = {}) {
  const { assignment_id, course_id } = useParams();
  const router = useRouter();
  const { role: classRole } = useClassProfiles();
  const { assignment } = useAssignmentController();
  const assignmentGroups = useAssignmentGroups();

  const { classRealTimeController } = useCourseController();
  const { timeZone } = useTimeZone();
  const supabase = useMemo(() => createClient(), []);
  const [isReleasingAll, setIsReleasingAll] = useState(false);
  const [isUnreleasingAll, setIsUnreleasingAll] = useState(false);

  // Get sections and assignment data for default visibility logic
  const classSections = useClassSections();
  const hasGroups = useMemo(() => assignmentGroups.length > 0, [assignmentGroups]);

  // Column visibility state with dynamic defaults
  const [columnVisibility, setColumnVisibility] = useState(() => {
    return {
      groupname: false,
      class_section_name: false,
      lab_section_name: false,
      late_due_date: false,
      created_at: false,
      gradername: false,
      checkername: false
    };
  });

  // Update column visibility when data loads
  useEffect(() => {
    if (classSections.length > 0 || assignment || hasGroups !== undefined) {
      const hasMultipleClassSections = classSections.length > 2;
      const hasLabScheduling = assignment?.minutes_due_after_lab !== null;

      setColumnVisibility((prev) => ({
        ...prev,
        groupname: hasGroups,
        class_section_name: hasMultipleClassSections,
        lab_section_name: hasLabScheduling
      }));
    }
  }, [classSections.length, assignment, hasGroups]);

  const columns = useMemo<ColumnDef<ActiveSubmissionsWithGradesForAssignment>[]>(
    () => [
      {
        id: "assignment_id",
        accessorKey: "assignment_id",
        header: "Assignment",
        filterFn: (row, id, filterValue) => {
          return String(row.original.assignment_id) === String(filterValue);
        }
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Student",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.name) return false;
          return values.some((val) => row.original.name!.toLowerCase().includes(val.toLowerCase()));
        },
        cell: ({ row }) => (
          <StudentNameCell
            course_id={course_id as string}
            assignment_id={assignment_id as string}
            uid={row.original.student_private_profile_id!}
            activeSubmissionId={row.original.activesubmissionid}
          />
        )
      },
      {
        id: "groupname",
        accessorKey: "groupname",
        header: "Group"
      },
      {
        id: "class_section_name",
        accessorKey: "class_section_name",
        header: "Class Section",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.class_section_name) return values.includes("Not assigned");
          return values.some((val) => row.original.class_section_name!.toLowerCase().includes(val.toLowerCase()));
        }
      },
      {
        id: "lab_section_name",
        accessorKey: "lab_section_name",
        header: "Lab Section",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.lab_section_name) return values.includes("Not assigned");
          return values.some((val) => row.original.lab_section_name!.toLowerCase() === val.toLowerCase());
        }
      },
      {
        id: "late_due_date",
        accessorKey: "late_due_date",
        header: "Late Due Date",
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }

          // If late due date is the same as assignment due date, show empty cell
          const lateDueDate = props.getValue() as string;
          if (assignment?.due_date && lateDueDate === assignment.due_date) {
            return <Text></Text>;
          }

          return (
            <Text>
              <TimeZoneAwareDate date={lateDueDate} format="Pp" />
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (row.original.late_due_date === null) {
            return values.includes("No late due date");
          }

          // If late due date is the same as assignment due date, treat as "Same as due date"
          if (assignment?.due_date && row.original.late_due_date === assignment.due_date) {
            return values.includes("Same as due date");
          }

          const date = new TZDate(row.original.late_due_date, timeZone);
          const formattedDate = formatInTimeZone(date, timeZone, "MM/dd/yyyy, h:mm a zzz");
          return values.some((val) => formattedDate.toLowerCase().includes(val.toLowerCase()));
        }
      },

      {
        id: "autograder_score",
        accessorKey: "autograder_score",
        header: "Autograder Score",
        enableColumnFilter: true,
        cell: (props) => {
          return (
            <ScoreLink
              score={props.getValue() as number}
              private_profile_id={props.row.original.student_private_profile_id!}
              submission_id={props.row.original.activesubmissionid!}
              course_id={course_id as string}
              assignment_id={assignment_id as string}
            />
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const score = row.original.autograder_score;
          if (score === null || score === undefined) return values.includes("No score");
          return values.includes(score.toString());
        }
      },
      {
        id: "total_score",
        accessorKey: "total_score",
        header: "Total Score",
        enableColumnFilter: true,
        cell: (props) => {
          return (
            <ScoreLink
              score={props.getValue() as number}
              private_profile_id={props.row.original.student_private_profile_id!}
              submission_id={props.row.original.activesubmissionid!}
              course_id={course_id as string}
              assignment_id={assignment_id as string}
            />
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const score = row.original.total_score;
          if (score === null || score === undefined) return values.includes("No score");
          return values.includes(score.toString());
        }
      },
      // {
      //   id: "tweak",
      //   accessorKey: "tweak",
      //   header: "Total Score Tweak"
      // },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Submission Date",
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }
          if (props.row.original.activesubmissionid) {
            return (
              <Link
                prefetch={false}
                href={`/course/${course_id}/assignments/${assignment_id}/submissions/${props.row.original.activesubmissionid}`}
              >
                <TimeZoneAwareDate date={props.getValue() as string} format="compact" />
              </Link>
            );
          }
          return (
            <Text>
              <TimeZoneAwareDate date={props.getValue() as string} format="compact" />
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.created_at) return values.includes("No submission");
          const date = new TZDate(row.original.created_at, timeZone);
          const formatted = formatInTimeZone(date, timeZone, "MM/dd/yyyy, h:mm a zzz");
          return values.some((val) => formatted.toLowerCase().includes(val.toLowerCase()));
        }
      },
      {
        id: "gradername",
        accessorKey: "gradername",
        header: "Grader",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.gradername) return values.includes("Not assigned");
          return values.some((val) => row.original.gradername!.toLowerCase().includes(val.toLowerCase()));
        }
      },
      {
        id: "checkername",
        accessorKey: "checkername",
        header: "Checker",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          if (!row.original.checkername) return values.includes("Not assigned");
          return values.some((val) => row.original.checkername!.toLowerCase().includes(val.toLowerCase()));
        }
      },
      {
        id: "released",
        accessorKey: "released",
        header: "Released",
        enableColumnFilter: true,
        cell: (props) => {
          return props.getValue() ? <Icon as={FaCheck} /> : <Icon as={FaTimes} />;
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const isReleased = row.original.released;
          const status = isReleased ? "Released" : "Not Released";
          return values.includes(status);
        }
      }
    ],
    [timeZone, course_id, assignment_id, assignment]
  );

  const [internalTableController, setInternalTableController] = useState<TableController<"submissions"> | null>(null);

  // Use provided tableController if available, otherwise create our own
  const tableController = providedTableController ?? internalTableController;

  useEffect(() => {
    // Only create internal tableController if one wasn't provided
    if (providedTableController) {
      return;
    }

    Sentry.addBreadcrumb({
      category: "tableController",
      message: "Creating TableController for submissions_with_grades_for_assignment_nice",
      level: "info"
    });

    const query = supabase
      .from("submissions_with_grades_for_assignment_nice")
      .select("*")
      .eq("assignment_id", Number(assignment_id));

    const tc = new TableController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: query as any,
      client: supabase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: "submissions_with_grades_for_assignment_nice" as any
    });

    setInternalTableController(tc);

    return () => {
      tc.close();
    };
  }, [supabase, assignment_id, classRealTimeController, providedTableController]);

  const {
    getHeaderGroups,
    getRowModel,
    getCoreRowModel,
    getState,
    getRowCount,
    setPageIndex,
    getCanPreviousPage,
    getPageCount,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    isLoading
  } = useTableControllerTable({
    columns,
    //TODO: Longer term, we should fix to make this work with views!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tableController: tableController as any,
    initialState: {
      columnFilters: [{ id: "assignment_id", value: assignment_id as string }],
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      },
      sorting: [{ id: "name", desc: false }]
    }
  });
  const isInstructor = classRole.role === "instructor";

  const toggleColumnVisibility = (columnId: keyof typeof columnVisibility) => {
    setColumnVisibility((prev) => ({
      ...prev,
      [columnId]: !prev[columnId]
    }));
  };

  return (
    <VStack w="100%">
      <VStack paddingBottom="55px" w="100%" gap={0}>
        {isInstructor && (
          <HStack alignItems="flex-end" gap={2} w="100%" justifyContent="flex-end">
            <Button
              colorPalette="green"
              variant="subtle"
              loading={isReleasingAll}
              disabled={isReleasingAll || isUnreleasingAll}
              onClick={async () => {
                setIsReleasingAll(true);
                try {
                  const { error } = await supabase.rpc("release_all_grading_reviews_for_assignment", {
                    assignment_id: Number(assignment_id)
                  });

                  if (error) {
                    throw new Error(`Failed to release reviews: ${error.message}`);
                  }

                  await tableController?.refetchAll();

                  toaster.success({ title: "Success", description: "All submission reviews released" });
                } catch (error) {
                  // eslint-disable-next-line no-console
                  console.error("Error releasing all grading reviews:", error);
                  toaster.error({
                    title: "Error",
                    description:
                      error instanceof Error ? error.message : "Unknown error occurred while releasing reviews"
                  });
                } finally {
                  setIsReleasingAll(false);
                }
              }}
            >
              Release All Submission Reviews
            </Button>
            <Button
              variant="ghost"
              colorPalette="red"
              loading={isUnreleasingAll}
              disabled={isReleasingAll || isUnreleasingAll}
              onClick={async () => {
                setIsUnreleasingAll(true);
                try {
                  const { error } = await supabase.rpc("unrelease_all_grading_reviews_for_assignment", {
                    assignment_id: Number(assignment_id)
                  });

                  if (error) {
                    throw new Error(`Failed to unrelease reviews: ${error.message}`);
                  }

                  await tableController?.refetchAll();
                  toaster.success({ title: "Success", description: "All submission reviews unreleased" });
                } catch (error) {
                  // eslint-disable-next-line no-console
                  console.error("Error unreleasing all grading reviews:", error);
                  toaster.error({
                    title: "Error",
                    description:
                      error instanceof Error ? error.message : "Unknown error occurred while unreleasing reviews"
                  });
                } finally {
                  setIsUnreleasingAll(false);
                }
              }}
            >
              Unrelease All Submission Reviews
            </Button>
            <ExportGradesButton assignment_id={Number(assignment_id)} class_id={Number(course_id)} />
            <DownloadAllButton />
          </HStack>
        )}
        {/* Column Visibility Controls */}
        <Box w="100%" p={4} bg="bg.subtle" borderRadius="md" mb={0}>
          <Text fontSize="sm" fontWeight="medium" mb={3}>
            Toggle Column Visibility:
          </Text>
          <HStack wrap="wrap" gap={4}>
            <Checkbox checked={columnVisibility.groupname} onCheckedChange={() => toggleColumnVisibility("groupname")}>
              Group
            </Checkbox>
            <Checkbox
              checked={columnVisibility.class_section_name}
              onCheckedChange={() => toggleColumnVisibility("class_section_name")}
            >
              Class Section
            </Checkbox>
            <Checkbox
              checked={columnVisibility.lab_section_name}
              onCheckedChange={() => toggleColumnVisibility("lab_section_name")}
            >
              Lab Section
            </Checkbox>
            <Checkbox
              checked={columnVisibility.late_due_date}
              onCheckedChange={() => toggleColumnVisibility("late_due_date")}
            >
              Late Due Date
            </Checkbox>
            <Checkbox
              checked={columnVisibility.created_at}
              onCheckedChange={() => toggleColumnVisibility("created_at")}
            >
              Submission Date
            </Checkbox>
            <Checkbox
              checked={columnVisibility.gradername}
              onCheckedChange={() => toggleColumnVisibility("gradername")}
            >
              Grader
            </Checkbox>
            <Checkbox
              checked={columnVisibility.checkername}
              onCheckedChange={() => toggleColumnVisibility("checkername")}
            >
              Checker
            </Checkbox>
          </HStack>
        </Box>
        <Box overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto" w="100%">
          <Table.Root minW="0" w="100%">
            <Table.Header>
              {getHeaderGroups().map((headerGroup) => (
                <Table.Row key={headerGroup.id}>
                  {headerGroup.headers
                    .filter(
                      (h) =>
                        h.id !== "assignment_id" &&
                        (h.id === "name" ||
                          h.id === "autograder_score" ||
                          h.id === "total_score" ||
                          h.id === "released" ||
                          columnVisibility[h.id as keyof typeof columnVisibility])
                    )
                    .map((header, colIdx) => (
                      <Table.ColumnHeader
                        key={header.id}
                        bg="bg.muted"
                        style={{
                          position: "sticky",
                          top: 0,
                          left: colIdx === 0 ? 0 : undefined,
                          zIndex: colIdx === 0 ? 21 : 20,
                          minWidth: colIdx === 0 ? 180 : undefined,
                          width: colIdx === 0 ? 180 : undefined
                        }}
                      >
                        {header.isPlaceholder ? null : (
                          <>
                            <Text onClick={header.column.getToggleSortingHandler()}>
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {{
                                asc: (
                                  <Icon size="md">
                                    <FaSortUp />
                                  </Icon>
                                ),
                                desc: (
                                  <Icon size="md">
                                    <FaSortDown />
                                  </Icon>
                                )
                              }[header.column.getIsSorted() as string] ?? (
                                <Icon size="md">
                                  <FaSort />
                                </Icon>
                              )}
                            </Text>
                            {header.id === "name" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={Array.from(
                                  getCoreRowModel()
                                    .rows.reduce((map, row) => {
                                      const name = row.original.name;
                                      if (name && !map.has(name)) {
                                        map.set(name, name);
                                      }
                                      return map;
                                    }, new Map())
                                    .values()
                                ).map((name) => ({ label: name, value: name }))}
                                placeholder="Filter by name..."
                              />
                            )}
                            {header.id === "class_section_name" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getCoreRowModel()
                                      .rows.reduce((map, row) => {
                                        const sectionName = row.original.class_section_name;
                                        if (sectionName && !map.has(sectionName)) {
                                          map.set(sectionName, sectionName);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "Not assigned", value: "Not assigned" }
                                ]}
                                placeholder="Filter by class section..."
                              />
                            )}
                            {header.id === "lab_section_name" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getCoreRowModel()
                                      .rows.reduce((map, row) => {
                                        const sectionName = row.original.lab_section_name;
                                        if (sectionName && !map.has(sectionName)) {
                                          map.set(sectionName, sectionName);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "Not assigned", value: "Not assigned" }
                                ]}
                                placeholder="Filter by lab section..."
                              />
                            )}
                            {header.id === "gradername" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getCoreRowModel()
                                      .rows.reduce((map, row) => {
                                        const graderName = row.original.gradername;
                                        if (graderName && !map.has(graderName)) {
                                          map.set(graderName, graderName);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "Not assigned", value: "Not assigned" }
                                ]}
                                placeholder="Filter by grader..."
                              />
                            )}
                            {header.id === "checkername" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getCoreRowModel()
                                      .rows.reduce((map, row) => {
                                        const checkerName = row.original.checkername;
                                        if (checkerName && !map.has(checkerName)) {
                                          map.set(checkerName, checkerName);
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((name) => ({ label: name, value: name })),
                                  { label: "Not assigned", value: "Not assigned" }
                                ]}
                                placeholder="Filter by checker..."
                              />
                            )}
                            {header.id === "released" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  { label: "Released", value: "Released" },
                                  { label: "Not Released", value: "Not Released" }
                                ]}
                                placeholder="Filter by release status..."
                              />
                            )}
                            {header.id === "created_at" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getRowModel()
                                      .rows.reduce((map, row) => {
                                        if (row.original.created_at) {
                                          const date = new TZDate(row.original.created_at, timeZone);
                                          const dateStr = formatInTimeZone(date, timeZone, "MM/dd/yyyy");
                                          if (!map.has(dateStr)) {
                                            map.set(dateStr, dateStr);
                                          }
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((date) => ({ label: date, value: date })),
                                  { label: "No submission", value: "No submission" }
                                ]}
                                placeholder="Filter by submission date..."
                              />
                            )}
                            {header.id === "late_due_date" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getRowModel()
                                      .rows.reduce((map, row) => {
                                        if (row.original.late_due_date) {
                                          // Check if late due date is same as assignment due date
                                          if (
                                            assignment?.due_date &&
                                            row.original.late_due_date === assignment.due_date
                                          ) {
                                            map.set("Same as due date", "Same as due date");
                                          } else {
                                            const date = new TZDate(row.original.late_due_date, timeZone);
                                            const dateStr = formatInTimeZone(date, timeZone, "MM/dd/yyyy, h:mm a zzz");
                                            if (!map.has(dateStr)) {
                                              map.set(dateStr, dateStr);
                                            }
                                          }
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  ).map((date) => ({ label: date, value: date })),
                                  { label: "No late due date", value: "No late due date" }
                                ]}
                                placeholder="Filter by late due date..."
                              />
                            )}
                            {header.id === "autograder_score" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getRowModel()
                                      .rows.reduce((map, row) => {
                                        const score = row.original.autograder_score;
                                        if (score !== null && score !== undefined) {
                                          const scoreStr = score.toString();
                                          if (!map.has(scoreStr)) {
                                            map.set(scoreStr, scoreStr);
                                          }
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  )
                                    .sort((a, b) => parseFloat(a) - parseFloat(b))
                                    .map((score) => ({ label: score, value: score })),
                                  { label: "No score", value: "No score" }
                                ]}
                                placeholder="Filter by autograder score..."
                              />
                            )}
                            {header.id === "total_score" && (
                              <Select
                                isMulti={true}
                                id={header.id}
                                onChange={(e) => {
                                  const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                  header.column.setFilterValue(values.length > 0 ? values : undefined);
                                }}
                                options={[
                                  ...Array.from(
                                    getRowModel()
                                      .rows.reduce((map, row) => {
                                        const score = row.original.total_score;
                                        if (score !== null && score !== undefined) {
                                          const scoreStr = score.toString();
                                          if (!map.has(scoreStr)) {
                                            map.set(scoreStr, scoreStr);
                                          }
                                        }
                                        return map;
                                      }, new Map())
                                      .values()
                                  )
                                    .sort((a, b) => parseFloat(a) - parseFloat(b))
                                    .map((score) => ({ label: score, value: score })),
                                  { label: "No score", value: "No score" }
                                ]}
                                placeholder="Filter by total score..."
                              />
                            )}
                          </>
                        )}
                      </Table.ColumnHeader>
                    ))}
                </Table.Row>
              ))}
            </Table.Header>
            <Table.Body>
              {isLoading && (
                <Table.Row>
                  <Table.Cell
                    colSpan={getHeaderGroups()
                      .map(
                        (h) =>
                          h.headers.filter(
                            (header) =>
                              header.id !== "assignment_id" &&
                              (header.id === "name" ||
                                header.id === "autograder_score" ||
                                header.id === "total_score" ||
                                header.id === "released" ||
                                columnVisibility[header.id as keyof typeof columnVisibility])
                          ).length
                      )
                      .reduce((a, b) => a + b, 0)}
                    bg="bg.subtle"
                  >
                    <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                      <Spinner size="lg" />
                      <Text>Loading...</Text>
                    </VStack>
                  </Table.Cell>
                </Table.Row>
              )}
              {getRowModel()
                .rows //.filter(row => row.getValue("profiles.name") !== undefined)
                .map((row, idx) => {
                  const linkToSubmission = (linkContent: string) => {
                    if (row.original.activesubmissionid) {
                      return (
                        <Link
                          prefetch={false}
                          href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`}
                        >
                          {linkContent}
                        </Link>
                      );
                    }
                    return linkContent;
                  };
                  const handleRowClick = () => {
                    if (row.original.activesubmissionid) {
                      router.push(
                        `/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`
                      );
                    }
                  };

                  return (
                    <Table.Row
                      key={row.id}
                      bg={idx % 2 === 0 ? "bg.subtle" : undefined}
                      _hover={{ bg: "bg.info" }}
                      onClick={handleRowClick}
                      cursor={row.original.activesubmissionid ? "pointer" : "default"}
                      title={row.original.activesubmissionid ? "Click to view submission" : "No active submission"}
                    >
                      {row
                        .getVisibleCells()
                        .filter(
                          (c) =>
                            c.column.id !== "assignment_id" &&
                            (c.column.id === "name" ||
                              c.column.id === "autograder_score" ||
                              c.column.id === "total_score" ||
                              c.column.id === "released" ||
                              columnVisibility[c.column.id as keyof typeof columnVisibility])
                        )
                        .map((cell, colIdx) => (
                          <Table.Cell
                            key={cell.id}
                            p={0}
                            style={
                              colIdx === 0
                                ? {
                                    position: "sticky",
                                    left: 0,
                                    zIndex: 1,
                                    background: "bg.subtle",
                                    borderRight: "1px solid",
                                    borderColor: "border.muted"
                                  }
                                : {}
                            }
                          >
                            {cell.column.columnDef.cell
                              ? flexRender(cell.column.columnDef.cell, cell.getContext())
                              : linkToSubmission(String(cell.getValue()))}
                          </Table.Cell>
                        ))}
                    </Table.Row>
                  );
                })}
            </Table.Body>
          </Table.Root>
        </Box>
        <HStack>
          <Button onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
            {"<<"}
          </Button>
          <Button id="previous-button" onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
            {"<"}
          </Button>
          <Button id="next-button" onClick={() => nextPage()} disabled={!getCanNextPage()}>
            {">"}
          </Button>
          <Button onClick={() => setPageIndex(getPageCount() - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
          <VStack>
            <Text>Page</Text>
            <Text>
              {getState().pagination.pageIndex + 1} of {getPageCount()}
            </Text>
          </VStack>
          <VStack>
            | Go to page:
            <input
              title="Go to page"
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                setPageIndex(page);
              }}
            />
          </VStack>
          <VStack>
            <Text>Show</Text>
            <NativeSelect.Root title="Select page size">
              <NativeSelect.Field
                value={"" + getState().pagination.pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                }}
              >
                {[25, 50, 100, 200, 500, 1000, 2000].map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    Show {pageSize}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </VStack>
        </HStack>
        <div>{getRowCount()} Rows</div>
      </VStack>
    </VStack>
  );
}

type ExportRow = {
  student_name?: string;
  canvas_user_id?: number | null;
  student_email?: string;
  group_name?: string;
  autograder_score?: number | null;
  total_score?: number | null;
  total_score_tweak?: number | null;
  extra: {
    github_username?: string;
    pawtograder_link?: string;
    github_link?: string;
    submission_id?: string;
    submission_date?: string;
    grader_name?: string;
    checker_name?: string;
    sha?: string;
    late_due_date?: string | null;
    grader_sha?: string;
    grader_action_sha?: string;
  };
  rubricCheckIdToScore?: Map<number, number>;
  autograder_test_results?: GraderResultTest[];
};

async function exportGrades({
  assignment_id,
  supabase,
  class_id,
  include_rubric_checks,
  include_repo_metadata,
  include_score_breakdown,
  include_submission_metadata,
  include_autograder_test_results,
  mode
}: {
  assignment_id: number;
  class_id: number;
  supabase: SupabaseClient<Database>;
  include_score_breakdown: boolean;
  include_rubric_checks: boolean;
  include_repo_metadata: boolean;
  include_submission_metadata: boolean;
  include_autograder_test_results: boolean;
  mode: "csv" | "json";
}) {
  const { data: latestSubmissionsWithGrades } = await supabase
    .from("submissions_with_grades_for_assignment_nice")
    .select("*")
    .eq("assignment_id", assignment_id)
    .order("created_at", { ascending: false });

  const { data: autograder_test_results, error: autograder_test_results_error } = await supabase
    .from("grader_result_tests")
    .select("*, submissions!grader_result_tests_submission_id_fkey!inner(id, assignment_id, is_active)")
    .eq("submissions.is_active", true)
    .eq("submissions.assignment_id", assignment_id);
  if (autograder_test_results_error) {
    // eslint-disable-next-line no-console
    console.error(autograder_test_results_error);
    throw new Error("Error fetching autograder test results");
  }
  const { data: roster } = await supabase
    .from("user_roles")
    .select("*, profiles!user_roles_private_profile_id_fkey(*), users(*)")
    .eq("class_id", class_id)
    .eq("role", "student");
  if (!latestSubmissionsWithGrades || !roster) {
    throw new Error("No submissions found");
  }
  const RubricCheckIDToScoreBySubmissionID = new Map<number, Map<number, number>>();
  const allRubricChecks: RubricCheck[] = [];
  if (include_rubric_checks) {
    const { data: assignment } = await supabase
      .from("assignments")
      .select(
        "*, rubrics!assignments_rubric_id_fkey(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, submission_file_comments(*), submission_comments(*), submission_artifact_comments!submission_artifact_comments_rubric_check_id_fkey(*)))))"
      )
      .eq("id", assignment_id)
      .single();
    if (!assignment) {
      throw new Error("Assignment not found");
    }
    for (const rubricPart of assignment.rubrics?.rubric_parts || []) {
      for (const rubricCriteria of rubricPart.rubric_criteria || []) {
        for (const rubricCheck of rubricCriteria.rubric_checks) {
          allRubricChecks.push(rubricCheck);
          for (const submissionFileComment of rubricCheck.submission_file_comments || []) {
            const { submission_id, points } = submissionFileComment;
            if (points === null) {
              continue;
            }
            if (!RubricCheckIDToScoreBySubmissionID.has(submission_id)) {
              RubricCheckIDToScoreBySubmissionID.set(submission_id, new Map());
            }
            const mapForSubmission = RubricCheckIDToScoreBySubmissionID.get(submission_id);
            if (mapForSubmission?.get(rubricCheck.id) === undefined) {
              mapForSubmission?.set(rubricCheck.id, points);
            } else {
              mapForSubmission?.set(rubricCheck.id, mapForSubmission.get(rubricCheck.id)! + points);
            }
          }
          for (const submissionArtifactComment of rubricCheck.submission_artifact_comments || []) {
            const { submission_id, points } = submissionArtifactComment;
            if (points === null) {
              continue;
            }
            if (!RubricCheckIDToScoreBySubmissionID.has(submission_id)) {
              RubricCheckIDToScoreBySubmissionID.set(submission_id, new Map());
            }
            const mapForSubmission = RubricCheckIDToScoreBySubmissionID.get(submission_id);
            if (mapForSubmission?.get(rubricCheck.id) === undefined) {
              mapForSubmission?.set(rubricCheck.id, points);
            } else {
              mapForSubmission?.set(rubricCheck.id, mapForSubmission.get(rubricCheck.id)! + points);
            }
          }
          for (const submissionComment of rubricCheck.submission_comments || []) {
            const { submission_id, points } = submissionComment;
            if (points === null) {
              continue;
            }
            if (!RubricCheckIDToScoreBySubmissionID.has(submission_id)) {
              RubricCheckIDToScoreBySubmissionID.set(submission_id, new Map());
            }
            const mapForSubmission = RubricCheckIDToScoreBySubmissionID.get(submission_id);
            if (mapForSubmission?.get(rubricCheck.id) === undefined) {
              mapForSubmission?.set(rubricCheck.id, points);
            } else {
              mapForSubmission?.set(rubricCheck.id, mapForSubmission.get(rubricCheck.id)! + points);
            }
          }
        }
      }
    }
  }
  const autograderTestResultsBySubmissionID = new Map<number, GraderResultTest[]>();
  if (include_autograder_test_results) {
    for (const autograderTestResult of autograder_test_results) {
      if (autograderTestResult.submission_id === null) {
        continue;
      }
      if (!autograderTestResultsBySubmissionID.has(autograderTestResult.submission_id)) {
        autograderTestResultsBySubmissionID.set(autograderTestResult.submission_id, []);
      } else {
        autograderTestResultsBySubmissionID.get(autograderTestResult.submission_id)!.push(autograderTestResult);
      }
    }
  }

  const exportRows: ExportRow[] = [];
  for (const submission of latestSubmissionsWithGrades) {
    const rosterRow = roster.find((r) => r.private_profile_id === submission.student_private_profile_id);

    const row: ExportRow = {
      student_name: submission.name || "",
      canvas_user_id: rosterRow?.canvas_id,
      student_email: rosterRow?.users.email || "",
      autograder_score: submission.autograder_score,
      total_score: submission.total_score,
      total_score_tweak: submission.tweak,
      extra: {
        github_username: rosterRow?.users.github_username || "",
        pawtograder_link: `https://app.pawtograder.com/course/${class_id}/assignments/${assignment_id}/submissions/${submission.activesubmissionid}`,
        submission_id: submission.activesubmissionid?.toString() || "",
        submission_date: submission.created_at?.toString() || "",
        grader_name: submission.gradername || "",
        checker_name: submission.checkername || "",
        sha: submission.sha || "",
        late_due_date: submission.late_due_date?.toString() || "",
        grader_sha: submission.grader_sha || "",
        grader_action_sha: submission.grader_action_sha || "",
        github_link: submission.repository
          ? `https://github.com/${submission.repository}/commit/${submission.sha}`
          : undefined
      },
      rubricCheckIdToScore: submission.activesubmissionid
        ? RubricCheckIDToScoreBySubmissionID.get(submission.activesubmissionid)
        : new Map(),
      autograder_test_results: submission.activesubmissionid
        ? autograderTestResultsBySubmissionID.get(submission.activesubmissionid)
        : []
    };
    exportRows.push(row);
  }

  if (mode === "csv") {
    const preparedRows = exportRows.map((row) => {
      const record: Record<string, unknown> = {};
      record.student_name = row.student_name;
      record.canvas_user_id = row.canvas_user_id;
      record.student_email = row.student_email;
      record.group_name = row.group_name;
      record.total_score = (row.total_score ?? 0) + (row.total_score_tweak ?? 0);
      if (include_repo_metadata) {
        record.github_username = row.extra.github_username;
        record.github_link = row.extra.github_link;
        record.sha = row.extra.sha;
      }
      if (include_submission_metadata) {
        record.submission_id = row.extra.submission_id;
        record.submission_date = row.extra.submission_date;
        record.grader_name = row.extra.grader_name;
        record.checker_name = row.extra.checker_name;
      }
      if (include_score_breakdown) {
        record.total_score_tweak_amount = row.total_score_tweak;
        record.autograder_score = row.autograder_score;
      }
      if (include_autograder_test_results) {
        for (const test of row.autograder_test_results || []) {
          record[test.name] = test.score;
        }
      }
      if (include_rubric_checks) {
        for (const rubricCheck of allRubricChecks) {
          record[rubricCheck.name] = row.rubricCheckIdToScore?.get(rubricCheck.id) ?? 0;
        }
      }
      return record;
    });
    const csv = Papa.unparse(preparedRows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `grades_${assignment_id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } else if (mode === "json") {
    const jsonData = exportRows.map((row) => {
      const record: Record<string, unknown> = {};
      record.student_name = row.student_name;
      record.student_email = row.student_email;
      record.canvas_user_id = row.canvas_user_id;
      record.group_name = row.group_name;
      record.total_score = (row.total_score ?? 0) + (row.total_score_tweak ?? 0);
      if (include_repo_metadata) {
        record.github_username = row.extra.github_username;
        record.github_link = row.extra.github_link;
        record.sha = row.extra.sha;
      }
      if (include_submission_metadata) {
        record.submission_id = row.extra.submission_id;
        record.submission_date = row.extra.submission_date;
        record.grader_name = row.extra.grader_name;
        record.checker_name = row.extra.checker_name;
      }
      if (include_score_breakdown) {
        record.total_score_tweak_amount = row.total_score_tweak;
        record.autograder_score = row.autograder_score;
      }
      if (include_autograder_test_results) {
        record.autograder_test_results = row.autograder_test_results?.map((test) => {
          return {
            name: test.name,
            score: test.score,
            max_score: test.max_score,
            extra_data: test.extra_data
          };
        });
      }
      if (include_rubric_checks) {
        record.rubric_check_results = allRubricChecks.map((rubricCheck) => {
          return {
            name: rubricCheck.name,
            score: row.rubricCheckIdToScore?.get(rubricCheck.id) ?? 0
          };
        });
      }
      return record;
    });
    const json = JSON.stringify(jsonData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `grades_${assignment_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
function ExportGradesButton({ assignment_id, class_id }: { assignment_id: number; class_id: number }) {
  const supabase = useMemo(() => createClient(), []);
  const [includeScoreBreakdown, setIncludeScoreBreakdown] = useState(true);
  const [includeRubricChecks, setIncludeRubricChecks] = useState(true);
  const [includeRepoMetadata, setIncludeRepoMetadata] = useState(false);
  const [includeSubmissionMetadata, setIncludeSubmissionMetadata] = useState(false);
  const [includeAutograderTestResults, setIncludeAutograderTestResults] = useState(true);
  const [isExporting, setIsExporting] = useState<null | "csv" | "json">(null);

  const handleExport = useCallback(
    async (mode: "csv" | "json") => {
      if (isExporting) return;
      setIsExporting(mode);
      try {
        await exportGrades({
          assignment_id,
          class_id,
          supabase,
          include_score_breakdown: includeScoreBreakdown,
          include_rubric_checks: includeRubricChecks,
          include_repo_metadata: includeRepoMetadata,
          include_submission_metadata: includeSubmissionMetadata,
          include_autograder_test_results: includeAutograderTestResults,
          mode
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Error exporting grades:", error);
        toaster.error({
          title: "Error",
          description: error instanceof Error ? error.message : "Unknown error occurred while exporting grades"
        });
      } finally {
        setIsExporting(null);
      }
    },
    [
      assignment_id,
      class_id,
      includeAutograderTestResults,
      includeRepoMetadata,
      includeRubricChecks,
      includeScoreBreakdown,
      includeSubmissionMetadata,
      isExporting,
      supabase
    ]
  );

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="subtle" loading={isExporting !== null} disabled={isExporting !== null}>
          Export Grades
        </Button>
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Popover.Arrow>
            <Popover.ArrowTip />
          </Popover.Arrow>
          <Popover.Body>
            <VStack align="start" gap={2}>
              <Checkbox
                checked={includeScoreBreakdown}
                disabled={isExporting !== null}
                onCheckedChange={(details) => setIncludeScoreBreakdown(details.checked === true)}
              >
                Include Score Breakdown
              </Checkbox>
              <Checkbox
                checked={includeRubricChecks}
                disabled={isExporting !== null}
                onCheckedChange={(details) => setIncludeRubricChecks(details.checked === true)}
              >
                Include Rubric Checks
              </Checkbox>
              <Checkbox
                checked={includeAutograderTestResults}
                disabled={isExporting !== null}
                onCheckedChange={(details) => setIncludeAutograderTestResults(details.checked === true)}
              >
                Include Autograder Test Results
              </Checkbox>
              <Checkbox
                checked={includeRepoMetadata}
                disabled={isExporting !== null}
                onCheckedChange={(details) => setIncludeRepoMetadata(details.checked === true)}
              >
                Include Repo Metadata
              </Checkbox>
              <Checkbox
                checked={includeSubmissionMetadata}
                disabled={isExporting !== null}
                onCheckedChange={(details) => setIncludeSubmissionMetadata(details.checked === true)}
              >
                Include Submission Metadata
              </Checkbox>
              <HStack w="100%" justifyContent="center" gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="green"
                  loading={isExporting === "csv"}
                  disabled={isExporting !== null}
                  onClick={() => handleExport("csv")}
                >
                  CSV
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="green"
                  loading={isExporting === "json"}
                  disabled={isExporting !== null}
                  onClick={() => handleExport("json")}
                >
                  JSON
                </Button>
              </HStack>
            </VStack>
          </Popover.Body>
        </Popover.Content>
      </Popover.Positioner>
    </Popover.Root>
  );
}

function DownloadAllButton() {
  const { assignment_id, course_id } = useParams();
  const supabase = useMemo(() => createClient(), []);
  const [isDownloading, setIsDownloading] = useState(false);

  async function handleDownloadAllClick() {
    try {
      setIsDownloading(true);
      const assignmentIdNum = Number(assignment_id);
      const classIdNum = Number(course_id);

      // 1) Get all students for this assignment with their active submission ids
      const { data: students, error: studentsError } = await supabase
        .from("submissions_with_grades_for_assignment_nice")
        .select("activesubmissionid, student_private_profile_id, name")
        .eq("assignment_id", assignmentIdNum);

      if (studentsError) {
        toaster.error({ title: "Error", description: studentsError.message });
        return;
      }
      if (!students || students.length === 0) {
        toaster.error({ title: "No data", description: "No students found for this assignment." });
        return;
      }

      // 2) Collect all active submission ids
      const studentRows = students.filter((s) => s.activesubmissionid !== null);
      const submissionIds = Array.from(new Set(studentRows.map((s) => s.activesubmissionid as number)));
      if (submissionIds.length === 0) {
        toaster.error({ title: "No active submissions", description: "No active submissions to download." });
        return;
      }

      // 3) Fetch all submission files for those submissions from DB
      const { data: files, error: filesError } = await supabase
        .from("submission_files")
        .select("submission_id, name, contents")
        .in("submission_id", submissionIds)
        .eq("class_id", classIdNum);

      if (filesError) {
        toaster.error({ title: "Error", description: filesError.message });
        return;
      }

      // 4) Build the zip: one folder per student, with their submission files
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const sanitizeFolderName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "student";
      // Prevent zip-slip and absolute paths while preserving valid nested dirs
      const sanitizeEntryPath = (p: string) => {
        // strip Windows drive letters and leading slashes
        let cleaned = (p ?? "")
          .toString()
          .replace(/^[a-zA-Z]:/, "")
          .replace(/^[/\\]+/, "");
        // normalize separators to /
        cleaned = cleaned.replace(/[\\]+/g, "/");
        // remove ., .. segments and illegal chars in segments
        const parts = [];
        for (const seg of cleaned.split("/")) {
          if (!seg || seg === ".") continue;
          if (seg === "..") {
            if (parts.length) parts.pop();
            continue;
          }
          parts.push(seg.replace(/[<>:"|?*\x00-\x1F]/g, "_"));
        }
        return parts.join("/");
      };

      // Index files by submission_id for faster lookups
      const filesBySubmissionId = new Map<
        number,
        { submission_id: number; name: string | null; contents: string | null }[]
      >();
      for (const f of files || []) {
        const arr = filesBySubmissionId.get(f.submission_id) ?? [];
        arr.push(f);
        filesBySubmissionId.set(f.submission_id, arr);
      }

      // We may have multiple students for the same submission (group work).
      // We still create one folder per student as requested, even if files duplicate.
      for (const s of students) {
        const folderLabelBase = s.name || "student";
        const profileSuffix = s.student_private_profile_id
          ? `_${String(s.student_private_profile_id).slice(0, 8)}`
          : "";
        const studentFolder = sanitizeFolderName(`${folderLabelBase}${profileSuffix}`);
        const folder = zip.folder(studentFolder);

        if (!folder) continue;

        if (s.activesubmissionid === null) {
          // No active submission: create a placeholder to make it visible
          folder.file("NO_ACTIVE_SUBMISSION.txt", "No active submission for this student.");
          continue;
        }

        const theseFiles = filesBySubmissionId.get(s.activesubmissionid) || [];
        if (theseFiles.length === 0) {
          folder.file("NO_FILES.txt", "No files recorded in the database for this submission.");
          continue;
        }

        for (const f of theseFiles) {
          const entryName = sanitizeEntryPath(f.name || "unnamed");
          // JSZip will create nested directories automatically from safe path separators
          folder.file(entryName, f.contents ?? "");
        }
      }

      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `assignment_${assignmentIdNum}_submissions.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toaster.success({ title: "Download started", description: "Your ZIP is being downloaded." });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toaster.error({ title: "Unexpected error", description: message });
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <Button variant="subtle" onClick={handleDownloadAllClick} disabled={isDownloading}>
      {isDownloading ? "Preparing ZIP..." : "Download All Submissions"}
    </Button>
  );
}
