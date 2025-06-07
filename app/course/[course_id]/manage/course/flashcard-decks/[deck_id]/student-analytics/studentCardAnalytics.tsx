"use client";

import { Button } from "@/components/ui/button";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack, Input, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { useTable } from "@refinedev/react-table";
import { ColumnDef, flexRender, Row } from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { useMemo } from "react";

// Supabase types
type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
type FlashcardInteractionLogRow = Database["public"]["Tables"]["flashcard_interaction_logs"]["Row"];
type UserRoleRow = Database["public"]["Tables"]["user_roles"]["Row"];
type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];

/**
 * @property {string} deckId - The ID of the flashcard deck.
 * @property {string} courseId - The ID of the course.
 */
type StudentCardAnalyticsProps = {
  deckId: string;
  courseId: string;
};

/**
 * @property {string} studentName - The name of the student.
 * @property {string} cardTitle - The title of the flashcard.
 * @property {number} promptViews - Number of times the card prompt was viewed.
 * @property {number} answerViews - Number of times the card answer was viewed.
 * @property {number} gotIt - Number of times the card was marked as "Got It".
 * @property {number} keepTrying - Number of times the card was marked as "Keep Trying".
 * @property {number} returnedToDeck - Number of times the card was returned to the deck.
 * @property {number|string} avgAnswerTime - Average time from prompt to answer view in seconds.
 * @property {number|string} avgGotItTime - Average time from answer view to "Got It" in seconds.
 * @property {number|string} avgKeepTryingTime - Average time from answer view to "Keep Trying" in seconds.
 */
type StudentCardMetrics = {
  studentName: string;
  cardTitle: string;
  promptViews: number;
  answerViews: number;
  gotIt: number;
  keepTrying: number;
  returnedToDeck: number;
  avgAnswerTime: number | string;
  avgGotItTime: number | string;
  avgKeepTryingTime: number | string;
};

/**
 * This component displays detailed analytics for each student's interaction with flashcards in a deck.
 * It shows metrics like view counts, action counts (e.g., "Got It", "Keep Trying"), and average time spent on cards.
 * @param {StudentCardAnalyticsProps} props - The component props.
 * @returns {JSX.Element} The rendered student card analytics table.
 */
export default function StudentCardAnalytics({ deckId, courseId }: StudentCardAnalyticsProps) {
  const { data: cardsData, isLoading: isLoadingCards } = useList<FlashcardRow>({
    resource: "flashcards",
    filters: [{ field: "deck_id", operator: "eq", value: deckId }],
    queryOptions: { enabled: !!deckId }
  });

  const { data: interactionsData, isLoading: isLoadingInteractions } = useList<FlashcardInteractionLogRow>({
    resource: "flashcard_interaction_logs",
    filters: [{ field: "deck_id", operator: "eq", value: deckId }],
    pagination: { pageSize: 10000 },
    queryOptions: { enabled: !!deckId }
  });

  const { data: userRolesData, isLoading: isLoadingUserRoles } = useList<UserRoleRow>({
    resource: "user_roles",
    filters: [{ field: "class_id", operator: "eq", value: courseId }],
    pagination: { pageSize: 5000 },
    queryOptions: { enabled: !!courseId }
  });

  const profileIds = useMemo(
    () => userRolesData?.data.map((role) => role.private_profile_id).filter(Boolean) ?? [],
    [userRolesData]
  );

  const { data: profilesData, isLoading: isLoadingProfiles } = useList<ProfileRow>({
    resource: "profiles",
    filters: [{ field: "id", operator: "in", value: profileIds }],
    pagination: { pageSize: 5000 },
    queryOptions: { enabled: profileIds.length > 0 }
  });

  const analyticsData = useMemo<StudentCardMetrics[]>(() => {
    if (!interactionsData?.data || !cardsData?.data || !profilesData?.data || !userRolesData?.data) {
      return [];
    }

    const cardMap = new Map(cardsData.data.map((card) => [card.id, card.title]));
    const profileMap = new Map(profilesData.data.map((profile) => [profile.id, profile.name]));
    const userRoleMap = new Map(userRolesData.data.map((role) => [role.user_id, role.private_profile_id]));

    const studentMetrics: {
      [key: string]: {
        studentId: string;
        cardId: number;
        promptViews: number;
        answerViews: number;
        gotIt: number;
        keepTrying: number;
        returnedToDeck: number;
        answerTimeTotal: number;
        gotItTimeTotal: number;
        keepTryingTimeTotal: number;
      };
    } = {};

    for (const log of interactionsData.data) {
      if (!log.student_id || !log.card_id) continue;

      const profileId = userRoleMap.get(log.student_id);
      if (!profileId) continue; // Only include users with a profile in this course

      const key = `${log.student_id}-${log.card_id}`;
      if (!studentMetrics[key]) {
        studentMetrics[key] = {
          studentId: log.student_id,
          cardId: log.card_id,
          promptViews: 0,
          answerViews: 0,
          gotIt: 0,
          keepTrying: 0,
          returnedToDeck: 0,
          answerTimeTotal: 0,
          gotItTimeTotal: 0,
          keepTryingTimeTotal: 0
        };
      }

      const metrics = studentMetrics[key];
      const duration = log.duration_on_card_ms || 0;

      switch (log.action) {
        case "card_prompt_viewed":
          metrics.promptViews++;
          break;
        case "card_answer_viewed":
          metrics.answerViews++;
          metrics.answerTimeTotal += duration;
          break;
        case "card_marked_got_it":
          metrics.gotIt++;
          metrics.gotItTimeTotal += duration;
          break;
        case "card_marked_keep_trying":
          metrics.keepTrying++;
          metrics.keepTryingTimeTotal += duration;
          break;
        case "card_returned_to_deck":
          metrics.returnedToDeck++;
          break;
      }
    }

    return Object.values(studentMetrics).map((metrics) => {
      const profileId = userRoleMap.get(metrics.studentId);
      const studentName = (profileId ? profileMap.get(profileId) : `User ${metrics.studentId}`) || "Unknown";
      const cardTitle = cardMap.get(metrics.cardId) || `Card ${metrics.cardId}`;

      return {
        studentName,
        cardTitle,
        promptViews: metrics.promptViews,
        answerViews: metrics.answerViews,
        gotIt: metrics.gotIt,
        keepTrying: metrics.keepTrying,
        returnedToDeck: metrics.returnedToDeck,
        avgAnswerTime: metrics.answerViews > 0 ? (metrics.answerTimeTotal / metrics.answerViews / 1000).toFixed(2) : 0,
        avgGotItTime: metrics.gotIt > 0 ? (metrics.gotItTimeTotal / metrics.gotIt / 1000).toFixed(2) : 0,
        avgKeepTryingTime:
          metrics.keepTrying > 0 ? (metrics.keepTryingTimeTotal / metrics.keepTrying / 1000).toFixed(2) : 0
      };
    });
  }, [interactionsData, cardsData, profilesData, userRolesData]);

  const columns = useMemo<ColumnDef<StudentCardMetrics>[]>(
    () => [
      {
        header: "Student",
        accessorKey: "studentName",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        },
        size: 250
      },
      {
        header: "Card",
        accessorKey: "cardTitle",
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        },
        size: 200
      },
      {
        header: "Prompt Views",
        accessorKey: "promptViews",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "Answer Views",
        accessorKey: "answerViews",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "'Got It' Clicks",
        accessorKey: "gotIt",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "'Keep Trying' Clicks",
        accessorKey: "keepTrying",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "Returned to Deck",
        accessorKey: "returnedToDeck",
        size: 80,
        cell: (info) => <Text textAlign="right">{info.getValue<number>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "Avg. Answer Time (s)",
        accessorKey: "avgAnswerTime",
        size: 100,
        cell: (info) => <Text textAlign="right">{info.getValue<string>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "Avg. 'Got It' Time (s)",
        accessorKey: "avgGotItTime",
        size: 100,
        cell: (info) => <Text textAlign="right">{info.getValue<string>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      },
      {
        header: "Avg. 'Keep Trying' Time (s)",
        accessorKey: "avgKeepTryingTime",
        size: 110,
        cell: (info) => <Text textAlign="right">{info.getValue<string>()}</Text>,
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          const value = row.getValue(id);
          if (value === null || value === undefined) return false;
          return String(value).toLowerCase().includes(String(filterValue).toLowerCase());
        }
      }
    ],
    []
  );

  const table = useTable<StudentCardMetrics>({
    columns,
    data: analyticsData,
    initialState: {
      pagination: { pageSize: 20 },
      sorting: [{ id: "studentName", desc: false }]
    },
    manualFiltering: false,
    manualPagination: false,
    manualSorting: false,
    filterFromLeafRows: true
  });

  const {
    getHeaderGroups,
    getRowModel,
    getState,
    setPageIndex,
    getCanPreviousPage,
    getCanNextPage,
    nextPage,
    previousPage,
    setPageSize,
    getPageCount
  } = table;

  if (isLoadingCards || isLoadingInteractions || isLoadingUserRoles || isLoadingProfiles) {
    return <Spinner />;
  }

  const currentRows = getRowModel().rows;

  if (currentRows.length === 0) {
    return <Text>No student interaction data available for this deck.</Text>;
  }

  return (
    <VStack align="stretch" w="100%">
      <Box overflowX="auto">
        <Table.Root striped style={{ tableLayout: "fixed", width: "100%" }}>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader
                    key={header.id}
                    style={{
                      width: `${header.getSize()}px`
                    }}
                  >
                    {header.isPlaceholder ? null : (
                      <VStack align="center" gap={2}>
                        <HStack
                          onClick={header.column.getToggleSortingHandler()}
                          cursor={header.column.getCanSort() ? "pointer" : "default"}
                          title={header.column.getCanSort() ? `Sort by ${header.column.id}` : undefined}
                          gap={1}
                        >
                          <Text fontWeight="bold">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </Text>
                          <Box>
                            {{
                              asc: "🔼",
                              desc: "🔽"
                            }[header.column.getIsSorted() as string] ?? null}
                          </Box>
                        </HStack>
                        {header.column.getCanFilter() && (
                          <Input
                            id={header.id}
                            size="sm"
                            placeholder={`Filter by ${header.column.columnDef.header}`}
                            value={(header.column.getFilterValue() as string) ?? ""}
                            onChange={(e) => header.column.setFilterValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()} // Prevent sorting when clicking input
                          />
                        )}
                      </VStack>
                    )}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {currentRows.map((row: Row<StudentCardMetrics>) => (
              <Table.Row key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <Table.Cell key={cell.id} verticalAlign="top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>

      {/* Pagination Controls */}
      <HStack mt={4} gap={2} justifyContent="space-between" alignItems="center" width="100%">
        <HStack gap={2}>
          <Button size="sm" onClick={() => setPageIndex(0)} disabled={!getCanPreviousPage()}>
            {"<<"}
          </Button>
          <Button size="sm" onClick={() => previousPage()} disabled={!getCanPreviousPage()}>
            {"<"}
          </Button>
          <Button size="sm" onClick={() => nextPage()} disabled={!getCanNextPage()}>
            {">"}
          </Button>
          <Button size="sm" onClick={() => setPageIndex(getPageCount() - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
        </HStack>

        <HStack gap={2} alignItems="center">
          <Text fontSize="sm">
            Page {getState().pagination.pageIndex + 1} of {getPageCount()}
          </Text>
          <Text fontSize="sm">|</Text>
          <Text fontSize="sm">Go to page:</Text>
          <Input
            size="sm"
            width="20"
            type="number"
            min="1"
            max={getPageCount()}
            defaultValue={getState().pagination.pageIndex + 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              setPageIndex(page);
            }}
          />
        </HStack>

        <HStack gap={2} alignItems="center">
          <Text fontSize="sm">Show:</Text>
          <Select
            value={{
              value: getState().pagination.pageSize,
              label: `${getState().pagination.pageSize} rows`
            }}
            onChange={(selectedOption: { value: number; label: string } | null) => {
              if (selectedOption) {
                setPageSize(selectedOption.value);
              }
            }}
            options={[10, 20, 50, 100].map((pageSize) => ({
              value: pageSize,
              label: `${pageSize} rows`
            }))}
            size="sm"
            isSearchable={false}
            aria-label="Rows per page"
            chakraStyles={{
              container: (provided) => ({ ...provided, width: "120px" }),
              control: (provided) => ({ ...provided, minHeight: "32px" })
            }}
          />
        </HStack>
      </HStack>

      <Text fontSize="sm" textAlign="center">
        Showing {currentRows.length} of {analyticsData.length} total records
      </Text>
    </VStack>
  );
}
