"use client";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import Link from "@/components/ui/link";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useCourseController } from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import { rerunGrader } from "@/lib/edgeFunctions";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { ActiveSubmissionsWithRegressionTestResults, Assignment, Autograder } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Box,
  Button,
  Checkbox,
  CloseButton,
  Code,
  Dialog,
  Flex,
  Heading,
  HStack,
  Icon,
  Input,
  List,
  Skeleton,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { TZDate } from "@date-fns/tz";
import { useOne } from "@refinedev/core";
import * as Sentry from "@sentry/nextjs";
import { CellContext, ColumnDef, flexRender } from "@tanstack/react-table";
import { Select as ReactSelect } from "chakra-react-select";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaSort, FaSortDown, FaSortUp } from "react-icons/fa";

interface SelectOption {
  label: string;
  value: string;
}

type WhatIfGraderResult = Pick<
  Database["public"]["Tables"]["grader_results"]["Row"],
  "id" | "score" | "grader_sha" | "grader_action_sha" | "created_at"
>;

function SubmissionGraderTable({ autograder_repo }: { autograder_repo: string }) {
  const { assignment_id, course_id } = useParams();
  const { role } = useClassProfiles();
  const course = role.classes;
  const timeZone = course.time_zone || "America/New_York";
  const [commitOptions, setCommitOptions] = useState<SelectOption[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<SelectOption | null>(null);
  const [manualSha, setManualSha] = useState<string>("");
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [autoPromote, setAutoPromote] = useState(true);
  const [showDevColumns, setShowDevColumns] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const { classRealTimeController } = useCourseController();
  const [tableController, setTableController] = useState<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TableController<any, any, any, ActiveSubmissionsWithRegressionTestResults> | undefined
  >(undefined);
  const [promotingResults, setPromotingResults] = useState<Record<number, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyResults, setHistoryResults] = useState<WhatIfGraderResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historySubmissionId, setHistorySubmissionId] = useState<number | null>(null);
  const [historyStudentName, setHistoryStudentName] = useState<string | null>(null);

  const promoteResult = useCallback(
    async (graderResultId: number) => {
      setPromotingResults((prev) => ({ ...prev, [graderResultId]: true }));
      try {
        const { error } = await supabase.rpc("promote_whatif_grader_result", {
          p_grader_result_id: graderResultId,
          p_class_id: course.id
        });
        if (error) {
          throw new Error(error.message);
        }
        await tableController?.refetchAll();
        toaster.success({
          title: "Promoted result",
          description: "The what-if result is now the official autograder result."
        });
      } catch (error) {
        toaster.error({
          title: "Failed to promote",
          description: error instanceof Error ? error.message : "Unknown error"
        });
      } finally {
        setPromotingResults((prev) => ({ ...prev, [graderResultId]: false }));
      }
    },
    [course.id, supabase, tableController]
  );

  const openHistory = useCallback(
    async (submissionId: number, studentName: string | null) => {
      setHistoryOpen(true);
      setHistorySubmissionId(submissionId);
      setHistoryStudentName(studentName);
      setHistoryLoading(true);
      setHistoryError(null);
      setHistoryResults([]);
      try {
        const { data, error } = await supabase
          .from("grader_results")
          .select("id, score, grader_sha, grader_action_sha, created_at")
          .eq("rerun_for_submission_id", submissionId)
          .order("id", { ascending: false });
        if (error) {
          throw new Error(error.message);
        }
        setHistoryResults(data ?? []);
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : "Failed to load history");
      } finally {
        setHistoryLoading(false);
      }
    },
    [supabase]
  );
  const renderAsLinkToSubmission = useCallback(
    (props: CellContext<ActiveSubmissionsWithRegressionTestResults, unknown>) => {
      const row = props.row;
      const value = props.getValue();
      if (value === null || value === undefined) {
        return <Text></Text>;
      }
      if (row.original.activesubmissionid === null) {
        return <Text>{value as string}</Text>;
      }
      return (
        <Link href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.activesubmissionid}`}>
          <Text onClick={(e) => e.stopPropagation()}>{value as string}</Text>
        </Link>
      );
    },
    [course_id, assignment_id]
  );
  const columns = useMemo<ColumnDef<ActiveSubmissionsWithRegressionTestResults>[]>(
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
        id: "activesubmissionid",
        accessorKey: "activesubmissionid",
        header: "Active Submission ID",
        cell: renderAsLinkToSubmission
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Student",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!row.original.name) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => row.original.name?.toLowerCase().includes(filter.toLowerCase()));
        },
        cell: renderAsLinkToSubmission
      },
      {
        id: "groupname",
        accessorKey: "groupname",
        header: "Group",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!row.original.groupname) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            row.original.groupname?.toLowerCase().includes(filter.toLowerCase())
          );
        },
        cell: renderAsLinkToSubmission
      },
      {
        id: "autograder_score",
        accessorKey: "autograder_score",
        header: "Autograder Score",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (row.original.autograder_score === null || row.original.autograder_score === undefined) return false;
          if (
            filterValue === undefined ||
            filterValue === null ||
            (Array.isArray(filterValue) && filterValue.length === 0)
          )
            return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => String(row.original.autograder_score) === filter);
        },
        cell: renderAsLinkToSubmission
      },
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Submission Date",
        enableColumnFilter: true,
        cell: (props) => {
          if (props.getValue() === null) {
            return <Text></Text>;
          }
          return (
            <Text>
              <TimeZoneAwareDate date={props.getValue() as string} format="compact" />
            </Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.created_at) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const date = new TZDate(row.original.created_at, timeZone);
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            date.toLocaleString().toLowerCase().includes(filter.toLowerCase())
          );
        }
      },
      {
        id: "rerun_queued_at",
        accessorKey: "rerun_queued_at",
        header: "Rerun Status",
        enableColumnFilter: true,
        cell: (props) => {
          const queuedAt = props.getValue() as string | null;
          if (!queuedAt) {
            return <Text color="fg.muted">—</Text>;
          }
          return (
            <VStack gap={0} align="start">
              <Text color="orange.600" fontWeight="medium">
                Requested
              </Text>
              <Text fontSize="xs" color="fg.muted">
                <TimeZoneAwareDate date={queuedAt} format="compact" />
              </Text>
            </VStack>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          const hasPending = row.original.rerun_queued_at !== null;
          return filterArray.some((filter: string) => {
            if (filter === "Pending") return hasPending;
            if (filter === "None") return !hasPending;
            return false;
          });
        }
      },
      {
        id: "grader_sha",
        accessorKey: "grader_sha",
        header: "Submission Autograder SHA",
        enableColumnFilter: true,
        cell: (props) => {
          if (!props.getValue()) {
            return <Text></Text>;
          }
          return (
            <Link href={`https://github.com/${autograder_repo}/commit/${props.getValue()}`} target="_blank">
              <Code onClick={(e) => e.stopPropagation()}>{(props.getValue() as string).slice(0, 7)}</Code>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.grader_sha) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            (row.original.grader_sha as string).toLowerCase().includes(filter.toLowerCase())
          );
        }
      },
      {
        id: "rt_autograder_score",
        accessorKey: "rt_autograder_score",
        header: "Development Autograder Score (Hidden)",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (row.original.rt_autograder_score === null || row.original.rt_autograder_score === undefined) return false;
          if (
            filterValue === undefined ||
            filterValue === null ||
            (Array.isArray(filterValue) && filterValue.length === 0)
          )
            return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => String(row.original.rt_autograder_score) === filter);
        }
      },
      {
        id: "rt_grader_sha",
        accessorKey: "rt_grader_sha",
        header: "Development Autograder SHA (Hidden)",
        enableColumnFilter: true,
        cell: (props) => {
          if (!props.getValue()) {
            return <Text></Text>;
          }
          return (
            <Link href={`https://github.com/${autograder_repo}/commit/${props.getValue()}`} target="_blank">
              <Code onClick={(e) => e.stopPropagation()}>{(props.getValue() as string).slice(0, 7)}</Code>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.rt_grader_sha) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            (row.original.rt_grader_sha as string).toLowerCase().includes(filter.toLowerCase())
          );
        }
      },
      {
        id: "whatif_autograder_score",
        accessorKey: "whatif_autograder_score",
        header: "What-if Score",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (row.original.whatif_autograder_score === null || row.original.whatif_autograder_score === undefined)
            return false;
          if (
            filterValue === undefined ||
            filterValue === null ||
            (Array.isArray(filterValue) && filterValue.length === 0)
          )
            return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) => String(row.original.whatif_autograder_score) === filter);
        }
      },
      {
        id: "whatif_grader_sha",
        accessorKey: "whatif_grader_sha",
        header: "What-if Grader SHA",
        enableColumnFilter: true,
        cell: (props) => {
          if (!props.getValue()) {
            return <Text></Text>;
          }
          return (
            <Link href={`https://github.com/${autograder_repo}/commit/${props.getValue()}`} target="_blank">
              <Code onClick={(e) => e.stopPropagation()}>{(props.getValue() as string).slice(0, 7)}</Code>
            </Link>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!row.original.whatif_grader_sha) return false;
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const filterArray = Array.isArray(filterValue) ? filterValue : [filterValue];
          return filterArray.some((filter: string) =>
            (row.original.whatif_grader_sha as string).toLowerCase().includes(filter.toLowerCase())
          );
        }
      },
      {
        id: "whatif_history",
        header: "What-if History",
        enableColumnFilter: false,
        cell: (props) => {
          const submissionId = props.row.original.activesubmissionid;
          if (!submissionId) {
            return <Text color="fg.muted">None</Text>;
          }
          const hasHistory = Boolean(props.row.original.whatif_grader_result_id);
          return (
            <Button
              size="sm"
              variant="outline"
              disabled={!hasHistory}
              onClick={(e) => {
                e.stopPropagation();
                void openHistory(submissionId, props.row.original.name ?? null);
              }}
            >
              View
            </Button>
          );
        }
      },
      {
        id: "whatif_promote",
        header: "Promote",
        enableColumnFilter: false,
        cell: (props) => {
          const resultId = props.row.original.whatif_grader_result_id;
          if (!resultId) {
            return <Text color="fg.muted">None</Text>;
          }
          const isPromoting = promotingResults[resultId] || false;
          return (
            <Button
              size="sm"
              variant="outline"
              loading={isPromoting}
              onClick={(e) => {
                e.stopPropagation();
                void promoteResult(resultId);
              }}
            >
              Promote
            </Button>
          );
        }
      }
    ],
    [timeZone, autograder_repo, renderAsLinkToSubmission, promoteResult, promotingResults, openHistory]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadCommits() {
      if (!assignment_id) return;
      setCommitsLoading(true);
      setCommitsError(null);
      try {
        // Query autograder_commits table for main branch commits
        const { data: commits, error } = await supabase
          .from("autograder_commits")
          .select("sha, message, author, created_at")
          .eq("autograder_id", Number.parseInt(assignment_id as string))
          .eq("ref", "refs/heads/main")
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) {
          throw error;
        }

        const formatted = (commits || []).map((commit) => {
          const subject = commit.message?.split("\n")[0] || "No message";
          return {
            value: commit.sha,
            label: `${commit.sha.slice(0, 7)} - ${subject}`
          };
        });
        if (!cancelled) {
          setCommitOptions([{ label: "Latest on main (default)", value: "" }, ...formatted]);
          setSelectedCommit(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCommitsError(error instanceof Error ? error.message : "Failed to load commits");
        }
      } finally {
        if (!cancelled) {
          setCommitsLoading(false);
        }
      }
    }
    void loadCommits();
    return () => {
      cancelled = true;
    };
  }, [assignment_id, supabase]);

  useEffect(() => {
    Sentry.addBreadcrumb({
      category: "tableController",
      message: "Creating TableController for submissions_with_grades_for_assignment_and_regression_test",
      level: "info"
    });

    const query = supabase
      .from("submissions_with_grades_for_assignment_and_regression_test")
      .select("*")
      .eq("assignment_id", Number(assignment_id));

    const tc = new TableController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: query as any,
      client: supabase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      table: "submissions_with_grades_for_assignment_and_regression_test" as any
    });

    setTableController(tc);

    return () => {
      tc.close();
    };
  }, [supabase, assignment_id, classRealTimeController]);
  const { getHeaderGroups, getRowModel, getRowCount, getCoreRowModel, data } = useTableControllerTable({
    columns,
    tableController,
    initialState: {
      sorting: [{ id: "name", desc: false }],
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      }
    }
  });

  // Determine which columns to show based on data
  const columnVisibility = useMemo(() => {
    if (!data || data.length === 0) {
      return {
        name: true,
        groupname: true,
        rt_autograder_score: showDevColumns,
        rt_grader_sha: showDevColumns
      };
    }

    const hasName = data.some((row) => row.name !== null && row.name !== undefined);
    const hasGroupname = data.some((row) => row.groupname !== null && row.groupname !== undefined);

    return {
      name: hasName,
      groupname: hasGroupname,
      rt_autograder_score: showDevColumns,
      rt_grader_sha: showDevColumns
    };
  }, [data, showDevColumns]);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [regrading, setRegrading] = useState<boolean>(false);

  // Compute unique values for each column from ALL rows (before filtering)
  // Depends on 'data' so it recalculates when async data loads
  const columnUniqueValues = useMemo(() => {
    const rows = getCoreRowModel().rows; // Use getCoreRowModel to get ALL rows before filtering
    const uniqueValuesMap: Record<string, SelectOption[]> = {};

    columns.forEach((column) => {
      if (!column.enableColumnFilter) return;

      const uniqueValues = new Set<string>();
      rows.forEach((row) => {
        const value = row.getValue(column.id as string);
        if (value !== null && value !== undefined) {
          if (column.id === "created_at") {
            // For dates, show the formatted date string
            const dateValue = new TZDate(value as string, timeZone).toLocaleString();
            uniqueValues.add(dateValue);
          } else if (column.id === "grader_sha" || column.id === "rt_grader_sha" || column.id === "whatif_grader_sha") {
            // For SHAs, show the short version
            uniqueValues.add((value as string).slice(0, 7));
          } else {
            uniqueValues.add(String(value));
          }
        }
      });

      uniqueValuesMap[column.id as string] = Array.from(uniqueValues)
        .sort()
        .map((value) => ({ label: value, value }));
    });

    return uniqueValuesMap;
    // data is what actually changes, so we need to include it in the dependency array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, columns, timeZone, getCoreRowModel]);

  return (
    <VStack>
      <Toaster />
      <VStack paddingBottom="55px">
        <Box width="100%" maxWidth="1200px" border="1px solid" borderColor="border.muted" borderRadius="md" p={4}>
          <HStack alignItems="flex-end" gap={6} flexWrap="wrap">
            <Box width={{ base: "100%", md: "300px" }}>
              <Text fontSize="sm" color="fg.muted" mb={2}>
                Grader commit to use (from main branch)
              </Text>
              <ReactSelect
                name="grader_sha"
                options={commitOptions}
                placeholder="Latest on main (default)"
                isLoading={commitsLoading}
                value={selectedCommit}
                onChange={(selected) => {
                  setSelectedCommit(selected as SelectOption | null);
                  if (selected) {
                    setManualSha(""); // Clear manual input when selecting from dropdown
                  }
                }}
                chakraStyles={{
                  container: (provided) => ({
                    ...provided,
                    width: "100%"
                  }),
                  dropdownIndicator: (provided) => ({
                    ...provided,
                    bg: "transparent",
                    px: 2,
                    cursor: "pointer"
                  }),
                  indicatorSeparator: (provided) => ({
                    ...provided,
                    display: "none"
                  })
                }}
              />
              {commitsError && (
                <Text fontSize="sm" color="fg.error" mt={2}>
                  {commitsError}
                </Text>
              )}
            </Box>
            <Box width={{ base: "100%", md: "300px" }}>
              <Text fontSize="sm" color="fg.muted" mb={2}>
                Or enter a custom SHA
              </Text>
              <Input
                placeholder="Enter any valid SHA (e.g., abc1234)"
                value={manualSha}
                onChange={(e) => {
                  setManualSha(e.target.value);
                  if (e.target.value) {
                    setSelectedCommit(null); // Clear dropdown selection when typing manually
                  }
                }}
              />
              <Text fontSize="xs" color="fg.muted" mt={1}>
                You can use any valid SHA from the solution repository
              </Text>
            </Box>
            <Checkbox.Root
              checked={autoPromote}
              onCheckedChange={(checked) => setAutoPromote(Boolean(checked.checked))}
            >
              <Checkbox.HiddenInput />
              <HStack>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Checkbox.Label>Auto-promote new result to official</Checkbox.Label>
              </HStack>
            </Checkbox.Root>
            <Checkbox.Root
              checked={showDevColumns}
              onCheckedChange={(checked) => setShowDevColumns(Boolean(checked.checked))}
            >
              <Checkbox.HiddenInput />
              <HStack>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Checkbox.Label>Show development autograder columns</Checkbox.Label>
              </HStack>
            </Checkbox.Root>
          </HStack>
        </Box>
        <Table.Root interactive>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row bg="bg.subtle" key={headerGroup.id}>
                <Table.ColumnHeader>
                  <Checkbox.Root
                    id="select-all"
                    colorPalette="green"
                    onCheckedChange={(checked) => {
                      if (checked.checked) {
                        setSelectedRows(
                          getRowModel()
                            .rows.map((row) => row.original.activesubmissionid)
                            .filter((id) => id !== null) as number[]
                        );
                      } else {
                        setSelectedRows([]);
                      }
                    }}
                  >
                    <Checkbox.HiddenInput />
                    <VStack>
                      <Checkbox.Label>Select all</Checkbox.Label>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </VStack>
                  </Checkbox.Root>
                </Table.ColumnHeader>
                {headerGroup.headers
                  .filter((h) => {
                    if (h.id === "assignment_id") return false;
                    if (h.id === "name" && !columnVisibility.name) return false;
                    if (h.id === "groupname" && !columnVisibility.groupname) return false;
                    if (h.id === "rt_autograder_score" && !columnVisibility.rt_autograder_score) return false;
                    if (h.id === "rt_grader_sha" && !columnVisibility.rt_grader_sha) return false;
                    return true;
                  })
                  .map((header) => {
                    const canFilter = header.column.columnDef.enableColumnFilter;
                    const options = columnUniqueValues[header.id] || [];
                    return (
                      <Table.ColumnHeader key={header.id}>
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
                            {canFilter && (
                              <ReactSelect
                                isMulti
                                name={header.id}
                                options={options}
                                placeholder={`Filter ${header.column.columnDef.header}...`}
                                closeMenuOnSelect={false}
                                size="sm"
                                value={
                                  Array.isArray(header.column.getFilterValue())
                                    ? (header.column.getFilterValue() as string[]).map((v) => ({
                                        label: v,
                                        value: v
                                      }))
                                    : []
                                }
                                onChange={(selected) => {
                                  header.column.setFilterValue(selected ? selected.map((option) => option.value) : []);
                                }}
                                chakraStyles={{
                                  container: (provided) => ({
                                    ...provided,
                                    width: "100%",
                                    maxWidth: "200px"
                                  }),
                                  dropdownIndicator: (provided) => ({
                                    ...provided,
                                    bg: "transparent",
                                    px: 2,
                                    cursor: "pointer"
                                  }),
                                  indicatorSeparator: (provided) => ({
                                    ...provided,
                                    display: "none"
                                  })
                                }}
                              />
                            )}
                          </>
                        )}
                      </Table.ColumnHeader>
                    );
                  })}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {getRowModel()
              .rows //.filter(row => row.getValue("profiles.name") !== undefined)
              .map((row) => {
                return (
                  <Table.Row
                    key={row.id}
                    onClick={() => {
                      if (row.original.activesubmissionid) {
                        setSelectedRows((prev) => {
                          if (row.original.activesubmissionid === null) {
                            return prev;
                          }
                          if (prev.includes(row.original.activesubmissionid)) {
                            return prev.filter((id) => id !== row.original.activesubmissionid);
                          }
                          return [...prev, row.original.activesubmissionid];
                        });
                      }
                    }}
                  >
                    <Table.Cell>
                      {row.original.activesubmissionid && (
                        <Checkbox.Root
                          id={String(row.original.activesubmissionid)}
                          colorPalette="green"
                          checked={selectedRows.includes(row.original.activesubmissionid)}
                          onCheckedChange={(checked) => {
                            const id = row.original.activesubmissionid;
                            if (id === null) {
                              return;
                            }
                            if (checked.checked) {
                              setSelectedRows((prev) => [...prev, id]);
                            } else {
                              setSelectedRows((prev) => prev.filter((id) => id !== id));
                            }
                          }}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                        </Checkbox.Root>
                      )}
                    </Table.Cell>
                    {row
                      .getVisibleCells()
                      .filter((c) => {
                        if (c.column.id === "assignment_id") return false;
                        if (c.column.id === "name" && !columnVisibility.name) return false;
                        if (c.column.id === "groupname" && !columnVisibility.groupname) return false;
                        if (c.column.id === "rt_autograder_score" && !columnVisibility.rt_autograder_score)
                          return false;
                        if (c.column.id === "rt_grader_sha" && !columnVisibility.rt_grader_sha) return false;
                        return true;
                      })
                      .map((cell) => {
                        return (
                          <Table.Cell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </Table.Cell>
                        );
                      })}
                  </Table.Row>
                );
              })}
          </Table.Body>
        </Table.Root>
        <div>{getRowCount()} Rows</div>
      </VStack>
      <Box
        p="2"
        border="1px solid"
        borderColor="border.muted"
        backgroundColor="bg.subtle"
        height="55px"
        style={{
          position: "fixed",
          bottom: 0,
          right: 0,
          width: "100%"
        }}
      >
        <HStack justifyContent="flex-end">
          <Button
            colorPalette="green"
            variant="solid"
            loading={regrading}
            onClick={async () => {
              setRegrading(true);
              try {
                const graderSha = manualSha.trim() || selectedCommit?.value || undefined;
                await rerunGrader(
                  {
                    submission_ids: selectedRows,
                    class_id: course.id,
                    grader_sha: graderSha,
                    auto_promote: autoPromote
                  },
                  supabase
                );
                await tableController?.refetchAll();
                toaster.success({
                  title: "Regrading started",
                  description: "This may take a while... Use the Workflow Runs page to view the complete status."
                });
              } catch (error) {
                toaster.error({
                  title: "Error regrading",
                  description: error instanceof Error ? error.message : "Unknown error"
                });
              } finally {
                setRegrading(false);
              }
            }}
          >
            Regrade selected
          </Button>
        </HStack>
      </Box>
      <Dialog.Root open={historyOpen} onOpenChange={(details) => !details.open && setHistoryOpen(false)} size="lg">
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content p={3}>
            <Dialog.Header p={0}>
              <Flex justify="space-between" align="center">
                <Heading size="sm">
                  What-if history{historyStudentName ? ` for ${historyStudentName}` : ""}
                  {historySubmissionId ? ` (#${historySubmissionId})` : ""}
                </Heading>
                <Dialog.CloseTrigger asChild>
                  <CloseButton bg="bg" size="sm" />
                </Dialog.CloseTrigger>
              </Flex>
            </Dialog.Header>
            <Dialog.Body p={0} mt={3}>
              {historyLoading ? (
                <Skeleton height="60px" />
              ) : historyError ? (
                <Text color="fg.error">{historyError}</Text>
              ) : historyResults.length === 0 ? (
                <Text color="fg.muted">No what-if results yet.</Text>
              ) : (
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader>Date</Table.ColumnHeader>
                      <Table.ColumnHeader>Score</Table.ColumnHeader>
                      <Table.ColumnHeader>Grader SHA</Table.ColumnHeader>
                      <Table.ColumnHeader>Action SHA</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {historyResults.map((result) => {
                      const dateValue = result.created_at
                        ? new TZDate(result.created_at, timeZone).toLocaleString()
                        : "Unknown";
                      return (
                        <Table.Row key={result.id}>
                          <Table.Cell>{dateValue}</Table.Cell>
                          <Table.Cell>{result.score == null ? "Unknown" : result.score}</Table.Cell>
                          <Table.Cell>{result.grader_sha ? result.grader_sha.slice(0, 7) : "Unknown"}</Table.Cell>
                          <Table.Cell>
                            {result.grader_action_sha ? result.grader_action_sha.slice(0, 7) : "Unknown"}
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </VStack>
  );
}
type AssignmentWithAutograder = Assignment & { autograder: Autograder };
export default function RerunAutograderPage() {
  const { assignment_id, course_id } = useParams();
  const { data: assignment, isLoading: isAssignmentLoading } = useOne<AssignmentWithAutograder>({
    resource: "assignments",
    id: assignment_id as string,
    meta: {
      select: "*, autograder(*)"
    }
  });
  if (isAssignmentLoading) {
    return <Skeleton height="100px" />;
  }
  if (!assignment?.data.autograder.grader_repo) {
    return <Text>Assignment not found</Text>;
  }
  return (
    <Box>
      <Heading size="md">Rerun Autograder</Heading>
      <Text fontSize="sm" color="fg.muted">
        This table will allow you to rerun the autograder (potentially using a newer version) on the currently active
        submissions for students, overriding any due dates. This creates a new autograder result for each submission (no
        new submissions are created).
      </Text>
      <Text fontSize="sm" color="fg.muted">
        Re-running the autograder can be a time-consuming process, and it will occur asynchronously. After you select
        &quot;Regrade selected&quot;, the rows will be updated to show that a re-run was requested. Once it has been
        received by GitHub, it will no longer show as &quot;Requested&quot; here, but you will be able to see the queued
        workflow runs begin to appear in the{" "}
        <Link href={`/course/${course_id}/manage/workflow-runs`}>Workflow Runs Table</Link>.
      </Text>
      <Text fontSize="sm" color="fg.muted">
        If auto-promote is off, the new scores appear under the &quot;What-if&quot; columns and can be promoted manually
        from the table.
      </Text>
      <Box fontSize="sm" border="1px solid" borderColor="border.info" borderRadius="md" p={4}>
        <Heading size="sm">How to debug and rerun the autograder</Heading>
        Student submissions are automatically graded using the most recent revision of the autograder
        <Code>main</Code> branch. If you need to edit the autograder, you should:
        <List.Root as="ol" px={8} py={4}>
          <List.Item>
            Use the <Link href={`/course/${course_id}/manage/assignments/${assignment_id}/autograder`}>Autograder</Link>{" "}
            tab to select several student submissions to use for testing.
          </List.Item>
          <List.Item>
            Make the changes to the autograder, pushing them to a{" "}
            <Text as="span" color="fg.accent" fontWeight="bold">
              different
            </Text>{" "}
            branch than <Code>main</Code> (choose a good name).
          </List.Item>
          <List.Item>
            Check the detailed output of running the autograder on those test submissions by viewing the GitHub Actions
            logs for your new commit.
          </List.Item>
          <List.Item>Refresh and check this table to compare the new autograder scores to the old one.</List.Item>
          <List.Item>
            If satisfied, merge your new branch into <Code>main</Code>.
          </List.Item>
          <List.Item>
            Use this page to re-run some (or all) of the student submissions using the new autograder.
          </List.Item>
        </List.Root>
        (If you want to be wild, skip the branching and just edit <Code>main</Code>, but you risk new student
        submissions getting graded with a potentially buggy version of the autograder that you are still testing.)
      </Box>
      <Box>
        The current autograder commit to <Code>main</Code> is{" "}
        <Code>{assignment.data.autograder.latest_autograder_sha?.slice(0, 7)}</Code>.
      </Box>

      <SubmissionGraderTable autograder_repo={assignment?.data.autograder.grader_repo} />
    </Box>
  );
}
