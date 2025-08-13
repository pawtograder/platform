"use client";
import { Checkbox } from "@/components/ui/checkbox";
import PersonName from "@/components/ui/person-name";
import { toaster } from "@/components/ui/toaster";
import { useCourse } from "@/hooks/useAuthState";
import { useCanShowGradeFor, useObfuscatedGradesMode, useSetOnlyShowGradesFor } from "@/hooks/useCourseController";
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
  Input,
  Link,
  NativeSelect,
  Popover,
  Skeleton,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import TableController from "@/lib/TableController";
import { useCourseController } from "@/hooks/useCourseController";
import { SupabaseClient } from "@supabase/supabase-js";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { useParams } from "next/navigation";
import Papa from "papaparse";
import { useCallback, useMemo, useState } from "react";
import { FaCheck, FaExternalLinkAlt, FaSort, FaSortDown, FaSortUp, FaTimes } from "react-icons/fa";
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
      <PersonName uid={uid} size="2xs" />
      <Box flex="1" display="flex" justifyContent="flex-end">
        {isObfuscated && (
          <IconButton variant="ghost" colorPalette="gray" size="sm" onClick={toggleOnlyShowGradesFor}>
            <Icon as={canShowGradeFor ? TbEyeOff : TbEye} />
          </IconButton>
        )}
        {activeSubmissionId && (
          <IconButton
            variant="ghost"
            colorPalette="gray"
            size="sm"
            onClick={() => {
              window.open(
                `/course/${course_id}/assignments/${assignment_id}/submissions/${activeSubmissionId}`,
                "_blank"
              );
            }}
          >
            <Icon as={FaExternalLinkAlt} />
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
export default function AssignmentsTable() {
  const { assignment_id, course_id } = useParams();
  const course = useCourse();
  const { classRealTimeController } = useCourseController();
  const timeZone = course.classes.time_zone || "America/New_York";
  const supabase = createClient();
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
          if (!row.original.name) return false;
          const filterString = String(filterValue).toLowerCase();
          return row.original.name.toLowerCase().includes(filterString);
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
        id: "late_due_date",
        accessorKey: "late_due_date",
        header: "Late Due Date",
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }
          return <Text>{new TZDate(props.getValue() as string).toLocaleString()}</Text>;
        },
        filterFn: (row, id, filterValue) => {
          if (row.original.late_due_date === null) {
            return false;
          }
          const date = new TZDate(row.original.late_due_date);
          const filterString = String(filterValue).toLowerCase();
          return date.toLocaleString().toLowerCase().includes(filterString);
        }
      },

      {
        id: "autograder_score",
        accessorKey: "autograder_score",
        header: "Autograder Score",
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
        }
      },
      {
        id: "total_score",
        accessorKey: "total_score",
        header: "Total Score",
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
                href={`/course/${course_id}/assignments/${assignment_id}/submissions/${props.row.original.activesubmissionid}`}
              >
                {new TZDate(props.getValue() as string, timeZone).toLocaleString()}
              </Link>
            );
          }
          return <Text>{new TZDate(props.getValue() as string, timeZone).toLocaleString()}</Text>;
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.created_at) return false;
          const date = new TZDate(row.original.created_at, timeZone);
          const filterString = String(filterValue);
          return date.toLocaleString().toLowerCase().includes(filterString.toLowerCase());
        }
      },
      {
        id: "gradername",
        accessorKey: "gradername",
        header: "Grader"
      },
      {
        id: "checkername",
        accessorKey: "checkername",
        header: "Checker"
      },
      {
        id: "released",
        accessorKey: "released",
        header: "Released",
        cell: (props) => {
          return props.getValue() ? <Icon as={FaCheck} /> : <Icon as={FaTimes} />;
        }
      }
    ],
    [timeZone, course_id, assignment_id]
  );

  const tableController = useMemo(() => {
    const query = supabase
      .from("submissions_with_grades_for_assignment")
      .select("*")
      .eq("assignment_id", Number(assignment_id));

    return new TableController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: query as any,
      client: supabase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: "submissions_with_grades_for_assignment" as any,
      classRealTimeController
    });
  }, [supabase, assignment_id, classRealTimeController]);

  const {
    getHeaderGroups,
    getRowModel,
    getState,
    getRowCount,
    setPageIndex,
    getCanPreviousPage,
    getPageCount,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    isLoading,
    refetch
  } = useTableControllerTable({
    columns,
    //TODO: Longer term, we should fix to make this work with views!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tableController: tableController as any,
    initialState: {
      columnFilters: [{ id: "assignment_id", value: assignment_id as string }],
      pagination: {
        pageIndex: 0,
        pageSize: 200
      },
      sorting: [{ id: "name", desc: false }]
    }
  });
  const isInstructor = course.role === "instructor";
  return (
    <VStack w="100%">
      <VStack paddingBottom="55px" w="100%">
        {isInstructor && (
          <HStack alignItems="flex-end" gap={2} w="100%" justifyContent="flex-end">
            <Button
              colorPalette="green"
              variant="subtle"
              onClick={async () => {
                const submissionIds = getRowModel()
                  .rows.map((s) => s.original.activesubmissionid)
                  .filter((id) => id !== null);
                const supabase = createClient();

                const { error } = await supabase
                  .from("submission_reviews")
                  .update({ released: true })
                  .in("submission_id", submissionIds)
                  .select("*");
                refetch();

                if (error) {
                  toaster.error({ title: "Error", description: error.message });
                } else {
                  toaster.success({ title: "Success", description: "All submission reviews released" });
                }
              }}
            >
              Release All Submission Reviews
            </Button>
            <Button
              variant="ghost"
              colorPalette="red"
              onClick={async () => {
                const submissionIds = getRowModel()
                  .rows.map((s) => s.original.activesubmissionid)
                  .filter((id) => id !== null);
                const supabase = createClient();

                const { error } = await supabase
                  .from("submission_reviews")
                  .update({ released: false })
                  .in("submission_id", submissionIds)
                  .select("*");
                refetch();

                if (error) {
                  toaster.error({ title: "Error", description: error.message });
                } else {
                  toaster.success({ title: "Success", description: "All submission reviews unreleased" });
                }
              }}
            >
              Unrelease All Submission Reviews
            </Button>
            <ExportGradesButton assignment_id={Number(assignment_id)} class_id={Number(course_id)} />
          </HStack>
        )}
        <Box overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto">
          <Table.Root minW="0">
            <Table.Header>
              {getHeaderGroups().map((headerGroup) => (
                <Table.Row key={headerGroup.id}>
                  {headerGroup.headers
                    .filter((h) => h.id !== "assignment_id")
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
                            <Input
                              id={header.id}
                              value={(header.column.getFilterValue() as string) ?? ""}
                              onChange={(e) => {
                                header.column.setFilterValue(e.target.value);
                              }}
                            />
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
                    colSpan={
                      getHeaderGroups()
                        .map((h) => h.headers.length)
                        .reduce((a, b) => a + b, 0) - 1
                    }
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
                          href={`/course/${course_id}/manage/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`}
                        >
                          {linkContent}
                        </Link>
                      );
                    }
                    return linkContent;
                  };
                  return (
                    <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : undefined} _hover={{ bg: "bg.info" }}>
                      {row
                        .getVisibleCells()
                        .filter((c) => c.column.id !== "assignment_id")
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
    .from("submissions_with_grades_for_assignment")
    .select("*")
    .eq("assignment_id", assignment_id)
    .order("created_at", { ascending: false });

  const { data: autograder_test_results, error: autograder_test_results_error } = await supabase
    .from("grader_result_tests")
    .select("*, submissions!inner(id, assignment_id, is_active)")
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
  const supabase = createClient();
  const [includeScoreBreakdown, setIncludeScoreBreakdown] = useState(true);
  const [includeRubricChecks, setIncludeRubricChecks] = useState(true);
  const [includeRepoMetadata, setIncludeRepoMetadata] = useState(false);
  const [includeSubmissionMetadata, setIncludeSubmissionMetadata] = useState(false);
  const [includeAutograderTestResults, setIncludeAutograderTestResults] = useState(true);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="subtle">Export Grades</Button>
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
                onCheckedChange={(details) => setIncludeScoreBreakdown(details.checked === true)}
              >
                Include Score Breakdown
              </Checkbox>
              <Checkbox
                checked={includeRubricChecks}
                onCheckedChange={(details) => setIncludeRubricChecks(details.checked === true)}
              >
                Include Rubric Checks
              </Checkbox>
              <Checkbox
                checked={includeAutograderTestResults}
                onCheckedChange={(details) => setIncludeAutograderTestResults(details.checked === true)}
              >
                Include Autograder Test Results
              </Checkbox>
              <Checkbox
                checked={includeRepoMetadata}
                onCheckedChange={(details) => setIncludeRepoMetadata(details.checked === true)}
              >
                Include Repo Metadata
              </Checkbox>
              <Checkbox
                checked={includeSubmissionMetadata}
                onCheckedChange={(details) => setIncludeSubmissionMetadata(details.checked === true)}
              >
                Include Submission Metadata
              </Checkbox>
              <HStack w="100%" justifyContent="center" gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="green"
                  onClick={() =>
                    exportGrades({
                      assignment_id,
                      class_id,
                      supabase,
                      include_score_breakdown: includeScoreBreakdown,
                      include_rubric_checks: includeRubricChecks,
                      include_repo_metadata: includeRepoMetadata,
                      include_submission_metadata: includeSubmissionMetadata,
                      include_autograder_test_results: includeAutograderTestResults,
                      mode: "csv"
                    })
                  }
                >
                  CSV
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="green"
                  onClick={() =>
                    exportGrades({
                      assignment_id,
                      class_id,
                      supabase,
                      include_score_breakdown: includeScoreBreakdown,
                      include_rubric_checks: includeRubricChecks,
                      include_repo_metadata: includeRepoMetadata,
                      include_submission_metadata: includeSubmissionMetadata,
                      include_autograder_test_results: includeAutograderTestResults,
                      mode: "json"
                    })
                  }
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
