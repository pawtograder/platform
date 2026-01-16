"use client";

import Link from "@/components/ui/link";
import { toaster } from "@/components/ui/toaster";
import { useAssignmentController } from "@/hooks/useAssignment";
import { useIsInstructor } from "@/hooks/useClassProfiles";
import {
  useActiveUserRolesWithProfiles,
  useClassSections,
  useCourseController,
  useLabSections
} from "@/hooks/useCourseController";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  Alert,
  Box,
  Button,
  Card,
  Field,
  Heading,
  HStack,
  Icon,
  Input,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { useParams } from "next/navigation";
import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FaDownload, FaExclamationTriangle, FaSearch, FaShieldAlt, FaSort, FaSortDown, FaSortUp } from "react-icons/fa";

// The joined select query for submission_files with submissions
const SUBMISSION_FILES_SELECT = `
  id,
  name,
  contents,
  submission_id,
  submissions!inner(
    id,
    ordinal,
    sha,
    repository,
    profile_id,
    assignment_id
  )
` as const;

type SubmissionFileWithSubmission = Database["public"]["Tables"]["submission_files"]["Row"] & {
  submissions: {
    id: number;
    ordinal: number;
    sha: string;
    repository: string;
    profile_id: string | null;
    assignment_id: number;
  };
};

type SecurityAuditResult = {
  id: number;
  student_name: string;
  student_email: string;
  class_section_name: string | null;
  lab_section_name: string | null;
  submission_id: number;
  submission_ordinal: number;
  file_name: string;
  file_id: number;
  repository: string;
  sha: string;
  matched_content: string;
  match_line_number: number;
};

function getMatchContext(
  contents: string,
  searchTerm: string,
  maxLength: number = 100
): { snippet: string; lineNumber: number } {
  const lowerContents = contents.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  const matchIndex = lowerContents.indexOf(lowerSearch);

  if (matchIndex === -1) {
    return { snippet: "", lineNumber: 0 };
  }

  // Calculate line number
  const linesBeforeMatch = contents.substring(0, matchIndex).split("\n");
  const lineNumber = linesBeforeMatch.length;

  // Get context around the match
  const contextStart = Math.max(0, matchIndex - Math.floor(maxLength / 3));
  const contextEnd = Math.min(contents.length, matchIndex + searchTerm.length + Math.floor((maxLength * 2) / 3));

  let snippet = contents.substring(contextStart, contextEnd);

  // Add ellipsis if truncated
  if (contextStart > 0) snippet = "..." + snippet;
  if (contextEnd < contents.length) snippet = snippet + "...";

  // Clean up the snippet (replace newlines with spaces for display)
  snippet = snippet.replace(/\n/g, " ").replace(/\s+/g, " ");

  return { snippet, lineNumber };
}

function getGitHubFileLink(repository: string, sha: string, fileName: string): string {
  return `https://github.com/${repository}/blob/${sha}/${fileName}`;
}

export default function SecurityAuditPage() {
  const { assignment_id, course_id } = useParams();
  const { assignment } = useAssignmentController();
  const { classRealTimeController } = useCourseController();
  const isInstructor = useIsInstructor();

  // Use existing hooks for user data
  const userRolesWithProfiles = useActiveUserRolesWithProfiles();
  const classSections = useClassSections();
  const labSections = useLabSections();

  const [searchTerm, setSearchTerm] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const supabase = useMemo(() => createClient(), []);

  // Create TableController for submission_files when search is triggered
  const [tableController, setTableController] = useState<TableController<
    "submission_files",
    typeof SUBMISSION_FILES_SELECT
  > | null>(null);

  // Create lookup maps from hooks data
  const profileToUserData = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        email: string;
        class_section_id: number | null;
        lab_section_id: number | null;
      }
    >();

    for (const role of userRolesWithProfiles) {
      if (role.private_profile_id) {
        map.set(role.private_profile_id, {
          name: role.profiles?.name || "Unknown",
          email: role.users?.email || "Unknown",
          class_section_id: role.class_section_id,
          lab_section_id: role.lab_section_id
        });
      }
    }

    return map;
  }, [userRolesWithProfiles]);

  const classSectionMap = useMemo(() => {
    return new Map(classSections.map((s) => [s.id, s.name]));
  }, [classSections]);

  const labSectionMap = useMemo(() => {
    return new Map(labSections.map((s) => [s.id, s.name]));
  }, [labSections]);

  // Perform search by creating a new TableController
  const performSearch = useCallback(async () => {
    if (!searchTerm.trim()) {
      toaster.error({ title: "Error", description: "Please enter a search term" });
      return;
    }

    setHasSearched(true);

    // Close existing controller if any
    if (tableController) {
      tableController.close();
    }

    // Create new TableController with the search query
    const query = supabase
      .from("submission_files")
      .select(SUBMISSION_FILES_SELECT)
      .eq("submissions.assignment_id", Number(assignment_id))
      .ilike("contents", `%${searchTerm}%`);

    const tc = new TableController({
      query: query as ReturnType<typeof supabase.from<"submission_files">>,
      client: supabase,
      table: "submission_files",
      classRealTimeController,
      selectForSingleRow: SUBMISSION_FILES_SELECT
    });

    setTableController(tc);
  }, [searchTerm, supabase, assignment_id, classRealTimeController, tableController]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      tableController?.close();
    };
  }, [tableController]);

  // Transform data from TableController to SecurityAuditResult format
  const transformToResults = useCallback(
    (files: SubmissionFileWithSubmission[]): SecurityAuditResult[] => {
      const results: SecurityAuditResult[] = [];

      for (const file of files) {
        if (!file.contents) continue;

        const submission = file.submissions;
        const profileId = submission.profile_id;
        const userData = profileId ? profileToUserData.get(profileId) : null;

        const classSectionName = userData?.class_section_id ? classSectionMap.get(userData.class_section_id) : null;
        const labSectionName = userData?.lab_section_id ? labSectionMap.get(userData.lab_section_id) : null;

        const { snippet, lineNumber } = getMatchContext(file.contents, searchTerm);

        results.push({
          id: file.id,
          student_name: userData?.name || "Unknown",
          student_email: userData?.email || "Unknown",
          class_section_name: classSectionName || null,
          lab_section_name: labSectionName || null,
          submission_id: submission.id,
          submission_ordinal: submission.ordinal,
          file_name: file.name,
          file_id: file.id,
          repository: submission.repository,
          sha: submission.sha,
          matched_content: snippet,
          match_line_number: lineNumber
        });
      }

      return results;
    },
    [searchTerm, profileToUserData, classSectionMap, labSectionMap]
  );

  // Define columns for the table
  const columns = useMemo<ColumnDef<SecurityAuditResult>[]>(
    () => [
      {
        id: "student_name",
        accessorKey: "student_name",
        header: "Student Name",
        cell: ({ row }) => (
          <Link
            href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.submission_id}`}
            data-testid={`result-student-name-${row.index}`}
          >
            {row.original.student_name}
          </Link>
        )
      },
      {
        id: "student_email",
        accessorKey: "student_email",
        header: "Student Email"
      },
      {
        id: "class_section_name",
        accessorKey: "class_section_name",
        header: "Class Section",
        cell: ({ row }) => row.original.class_section_name || "N/A"
      },
      {
        id: "lab_section_name",
        accessorKey: "lab_section_name",
        header: "Lab Section",
        cell: ({ row }) => row.original.lab_section_name || "N/A"
      },
      {
        id: "submission_ordinal",
        accessorKey: "submission_ordinal",
        header: "Submission",
        cell: ({ row }) => (
          <Link
            href={`/course/${course_id}/assignments/${assignment_id}/submissions/${row.original.submission_id}`}
            data-testid={`result-submission-id-${row.index}`}
          >
            #{row.original.submission_ordinal}
          </Link>
        )
      },
      {
        id: "file_name",
        accessorKey: "file_name",
        header: "File Name",
        cell: ({ row }) => (
          <Link
            href={getGitHubFileLink(row.original.repository, row.original.sha, row.original.file_name)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`result-file-link-${row.index}`}
          >
            {row.original.file_name}
            <Text as="span" fontSize="xs" color="gray.500" ml={1}>
              (L{row.original.match_line_number})
            </Text>
          </Link>
        )
      },
      {
        id: "matched_content",
        accessorKey: "matched_content",
        header: "Matched Content",
        cell: ({ row }) => (
          <Text
            fontSize="xs"
            fontFamily="mono"
            whiteSpace="pre-wrap"
            wordBreak="break-all"
            maxW="400px"
            data-testid={`result-matched-content-${row.index}`}
          >
            {row.original.matched_content}
          </Text>
        )
      }
    ],
    [course_id, assignment_id]
  );

  // Use TableControllerTable hook with transformed data
  const [transformedData, setTransformedData] = useState<SecurityAuditResult[]>([]);

  // Subscribe to table controller data changes
  useEffect(() => {
    if (!tableController) {
      setTransformedData([]);
      return;
    }

    const { data, unsubscribe } = tableController.list((newData) => {
      const results = transformToResults(newData as unknown as SubmissionFileWithSubmission[]);
      setTransformedData(results);
    });

    // Set initial data
    const results = transformToResults(data as unknown as SubmissionFileWithSubmission[]);
    setTransformedData(results);

    return () => unsubscribe();
  }, [tableController, transformToResults]);

  // Use the table controller table hook for table features
  const { getHeaderGroups, getRowModel, isLoading } = useTableControllerTable({
    columns,
    tableController: tableController as unknown as TableController<"submission_files">,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 1000
      },
      sorting: [{ id: "student_name", desc: false }]
    }
  });

  // Override getRowModel to use our transformed data
  const rowModel = useMemo(() => {
    return {
      rows: transformedData.map((row, index) => ({
        id: String(row.id),
        index,
        original: row,
        getVisibleCells: () =>
          columns.map((col) => ({
            id: `${row.id}_${col.id}`,
            column: { id: col.id, columnDef: col },
            getContext: () => ({ row: { original: row, index }, column: { id: col.id, columnDef: col }, getValue: () => row[col.id as keyof SecurityAuditResult] })
          }))
      }))
    };
  }, [transformedData, columns]);

  const exportToCSV = useCallback(() => {
    if (transformedData.length === 0) {
      toaster.error({ title: "Error", description: "No results to export" });
      return;
    }

    const csvData = transformedData.map((result) => ({
      "Student Name": result.student_name,
      "Student Email": result.student_email,
      "Class Section": result.class_section_name || "N/A",
      "Lab Section": result.lab_section_name || "N/A",
      "Submission ID": result.submission_id,
      "Submission #": result.submission_ordinal,
      "File Name": result.file_name,
      "Line Number": result.match_line_number,
      "GitHub Link": getGitHubFileLink(result.repository, result.sha, result.file_name),
      "Matched Content": result.matched_content,
      "Search Term": searchTerm
    }));

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `security_audit_${assignment?.slug || assignment_id}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    toaster.success({ title: "Export complete", description: "CSV file downloaded" });
  }, [transformedData, searchTerm, assignment, assignment_id]);

  if (!isInstructor) {
    return (
      <Alert.Root status="error">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Access Denied</Alert.Title>
          <Alert.Description>Only instructors can access the security audit dashboard.</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }

  return (
    <VStack w="100%" align="stretch" gap={4}>
      <HStack gap={2}>
        <Icon as={FaShieldAlt} color="red.500" boxSize={6} />
        <Heading size="md">Security Audit Dashboard</Heading>
      </HStack>

      <Alert.Root status="warning">
        <Alert.Indicator>
          <Icon as={FaExclamationTriangle} />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Security Tool</Alert.Title>
          <Alert.Description>
            This tool searches all submission file contents for a specific string match. Use it to detect potential
            academic integrity violations, hidden backdoors, or other security concerns.
          </Alert.Description>
        </Alert.Content>
      </Alert.Root>

      <Card.Root>
        <Card.Body>
          <VStack gap={4} align="stretch">
            <Field.Root>
              <Field.Label>Search Term</Field.Label>
              <HStack>
                <Input
                  placeholder="Enter string to search for in all submission files..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isLoading) {
                      performSearch();
                    }
                  }}
                  data-testid="security-search-input"
                />
                <Button
                  colorPalette="blue"
                  onClick={performSearch}
                  loading={isLoading}
                  disabled={isLoading || !searchTerm.trim()}
                  data-testid="security-search-button"
                >
                  <Icon as={FaSearch} mr={2} />
                  Search All Submissions
                </Button>
              </HStack>
              <Field.HelperText>
                Search is case-insensitive and searches the full contents of all submission files.
              </Field.HelperText>
            </Field.Root>
          </VStack>
        </Card.Body>
      </Card.Root>

      {isLoading && hasSearched && (
        <VStack py={8}>
          <Spinner size="lg" />
          <Text>Searching through all submission files...</Text>
        </VStack>
      )}

      {!isLoading && hasSearched && (
        <>
          <HStack justify="space-between">
            <Text fontWeight="medium">
              {transformedData.length} match{transformedData.length === 1 ? "" : "es"} found
              {transformedData.length > 0 &&
                ` across ${new Set(transformedData.map((r) => r.submission_id)).size} submission${new Set(transformedData.map((r) => r.submission_id)).size === 1 ? "" : "s"}`}
            </Text>
            {transformedData.length > 0 && (
              <Button variant="outline" size="sm" onClick={exportToCSV} data-testid="security-export-csv">
                <Icon as={FaDownload} mr={2} />
                Export All to CSV
              </Button>
            )}
          </HStack>

          {transformedData.length > 0 && (
            <Box overflowX="auto" maxH="600px" overflowY="auto">
              <Table.Root size="sm" data-testid="security-results-table">
                <Table.Header>
                  {getHeaderGroups().map((headerGroup) => (
                    <Table.Row key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <Table.ColumnHeader key={header.id} bg="bg.muted">
                          <HStack
                            cursor={header.column.getCanSort() ? "pointer" : "default"}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            <Text>{flexRender(header.column.columnDef.header, header.getContext())}</Text>
                            {header.column.getCanSort() && (
                              <Icon
                                as={
                                  header.column.getIsSorted() === "asc"
                                    ? FaSortUp
                                    : header.column.getIsSorted() === "desc"
                                      ? FaSortDown
                                      : FaSort
                                }
                                boxSize={3}
                              />
                            )}
                          </HStack>
                        </Table.ColumnHeader>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Header>
                <Table.Body>
                  {rowModel.rows.map((row, idx) => (
                    <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : undefined}>
                      {row.getVisibleCells().map((cell) => (
                        <Table.Cell key={cell.id}>
                          {cell.column.columnDef.cell
                            ? flexRender(cell.column.columnDef.cell, cell.getContext())
                            : String(cell.getContext().getValue() ?? "")}
                        </Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          )}

          {transformedData.length === 0 && (
            <Card.Root>
              <Card.Body>
                <VStack py={8}>
                  <Icon as={FaSearch} boxSize={8} color="gray.400" />
                  <Text color="gray.500">No matches found for &quot;{searchTerm}&quot;</Text>
                </VStack>
              </Card.Body>
            </Card.Root>
          )}
        </>
      )}

      {!hasSearched && !isLoading && (
        <Card.Root>
          <Card.Body>
            <VStack py={8}>
              <Icon as={FaShieldAlt} boxSize={8} color="gray.400" />
              <Text color="gray.500">Enter a search term above to scan all submission files</Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
