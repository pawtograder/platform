"use client";

import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import Markdown from "@/components/ui/markdown";
import { PopConfirm } from "@/components/ui/popconfirm";
import { toaster } from "@/components/ui/toaster";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack, IconButton, Input, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useDelete, useList } from "@refinedev/core";
import { useTable } from "@refinedev/react-table";
import { CellContext, ColumnDef, flexRender, Row } from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { format } from "date-fns";
import { useCallback, useMemo } from "react";
import { FaTrash } from "react-icons/fa";

// Type definitions
type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];

interface FlashcardDecksTableProps {
  courseId: string | number;
  onDeckDeleted?: () => void;
}

interface UserNameProps {
  userId: string;
  courseId: string | number;
}

function UserName({ userId, courseId }: UserNameProps) {
  // First, get the user's basic info
  const { data: userData } = useList<{ name: string }>({
    resource: "users",
    meta: {
      select: "name"
    },
    filters: [
      {
        field: "user_id",
        operator: "eq",
        value: userId
      }
    ],
    queryOptions: {
      enabled: !!userId
    }
  });

  // Then, get the user's profile info through user_roles for this course
  const { data: userRoleData } = useList<{ private_profile_id: string }>({
    resource: "user_roles",
    meta: {
      select: "private_profile_id"
    },
    filters: [
      {
        field: "user_id",
        operator: "eq",
        value: userId
      },
      {
        field: "class_id",
        operator: "eq",
        value: courseId
      }
    ],
    queryOptions: {
      enabled: !!userId && !!courseId
    }
  });

  const privateProfileId = userRoleData?.data?.[0]?.private_profile_id;

  // Finally, get the profile name if we have a private profile ID
  const { data: profileData } = useList<{ name: string }>({
    resource: "profiles",
    meta: {
      select: "name"
    },
    filters: [
      {
        field: "id",
        operator: "eq",
        value: privateProfileId
      }
    ],
    queryOptions: {
      enabled: !!privateProfileId
    }
  });

  const userName = userData?.data?.[0]?.name;
  const profileName = profileData?.data?.[0]?.name;

  // Display user name if available, otherwise fall back to private profile name
  const displayName = userName || profileName || "Unknown User";

  return <Text>{displayName}</Text>;
}

export default function FlashCardDecksTable({ courseId, onDeckDeleted }: FlashcardDecksTableProps) {
  const { mutate: deleteDeck, isLoading: isDeleting } = useDelete();

  const handleDeleteDeck = useCallback(
    (deckId: number, deckName: string) => {
      deleteDeck(
        {
          resource: "flashcard_decks",
          id: deckId
        },
        {
          onSuccess: () => {
            toaster.create({
              title: "Success",
              description: `Flashcard deck "${deckName}" has been deleted successfully.`,
              type: "success"
            });
            onDeckDeleted?.();
          },
          onError: (error) => {
            toaster.create({
              title: "Error",
              description: `Failed to delete flashcard deck: ${error.message}`,
              type: "error"
            });
          }
        }
      );
    },
    [deleteDeck, onDeckDeleted]
  );

  const columns = useMemo<ColumnDef<FlashcardDeckRow>[]>(
    () => [
      {
        id: "class_id_filter_col",
        accessorKey: "class_id",
        header: "Class ID",
        enableHiding: true,
        filterFn: (row: Row<FlashcardDeckRow>, id: string, filterValue: string | number) => {
          return String(row.original.class_id) === String(filterValue);
        }
      },
      {
        id: "name",
        header: "Deck Name",
        accessorKey: "name",
        enableColumnFilter: true,
        cell: function render(props: CellContext<FlashcardDeckRow, unknown>) {
          const name = props.getValue() as string;
          const deck = props.row.original;
          return (
            <Link href={`/course/${courseId}/manage/course/flashcard-decks/${deck.id}`}>
              <Text cursor="pointer" className="hover:underline">
                {name}
              </Text>
            </Link>
          );
        },
        filterFn: (row: Row<FlashcardDeckRow>, id, filterValue: string) => {
          const name = row.original.name;
          const filterString = String(filterValue).toLowerCase();
          return name.toLowerCase().includes(filterString);
        }
      },
      {
        id: "description",
        header: "Description",
        accessorKey: "description",
        enableColumnFilter: true,
        cell: function render(props: CellContext<FlashcardDeckRow, unknown>) {
          const description = props.getValue() as string | null;
          if (!description) return <Text color="gray.500">No description</Text>;
          return (
            <Box
              maxWidth="300px"
              title={description}
              css={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical"
              }}
            >
              <Markdown>{description}</Markdown>
            </Box>
          );
        },
        filterFn: (row: Row<FlashcardDeckRow>, id, filterValue: string) => {
          const description = row.original.description;
          if (!description) return false;
          const filterString = String(filterValue).toLowerCase();
          return description.toLowerCase().includes(filterString);
        }
      },
      {
        id: "creator",
        header: "Created By",
        accessorKey: "creator_id",
        enableColumnFilter: true,
        cell: function render(props: CellContext<FlashcardDeckRow, unknown>) {
          const creatorId = props.getValue() as string;
          return <UserName userId={creatorId} courseId={courseId} />;
        }
      },
      {
        id: "created_at",
        header: "Created",
        accessorKey: "created_at",
        cell: function render(props: CellContext<FlashcardDeckRow, unknown>) {
          const createdAt = props.getValue() as string;
          if (!createdAt) return <Text>-</Text>;
          return <Text>{format(new Date(createdAt), "MMM dd, yyyy HH:mm")}</Text>;
        },
        enableColumnFilter: true,
        filterFn: (row: Row<FlashcardDeckRow>, id, filterValue: string) => {
          const createdAt = row.original.created_at;
          if (!createdAt) return false;
          const formattedDate = format(new Date(createdAt), "MMM dd, yyyy HH:mm");
          const filterString = String(filterValue).toLowerCase();
          return formattedDate.toLowerCase().includes(filterString);
        }
      },
      {
        id: "updated_at",
        header: "Last Updated",
        accessorKey: "updated_at",
        cell: function render(props: CellContext<FlashcardDeckRow, unknown>) {
          const updatedAt = props.getValue() as string | null;
          if (!updatedAt) return <Text>-</Text>;
          return <Text>{format(new Date(updatedAt), "MMM dd, yyyy HH:mm")}</Text>;
        },
        enableColumnFilter: true,
        filterFn: (row: Row<FlashcardDeckRow>, id, filterValue: string) => {
          const updatedAt = row.original.updated_at;
          if (!updatedAt) return false;
          const formattedDate = format(new Date(updatedAt), "MMM dd, yyyy HH:mm");
          const filterString = String(filterValue).toLowerCase();
          return formattedDate.toLowerCase().includes(filterString);
        }
      },
      {
        id: "actions",
        header: "Actions",
        cell: function render({ row }: { row: Row<FlashcardDeckRow> }) {
          const deck = row.original;

          return (
            <HStack gap={2} justifyContent="center">
              <PopConfirm
                triggerLabel="Delete deck"
                trigger={
                  <IconButton
                    aria-label="Delete deck"
                    size="sm"
                    variant="ghost"
                    colorPalette="red"
                    loading={isDeleting}
                  >
                    <FaTrash />
                  </IconButton>
                }
                confirmHeader="Delete Flashcard Deck"
                confirmText={`Are you sure you want to delete the deck "${deck.name}"? This action cannot be undone.`}
                onConfirm={() => handleDeleteDeck(deck.id, deck.name)}
                onCancel={() => {}}
              />
            </HStack>
          );
        }
      }
    ],
    [handleDeleteDeck, isDeleting, courseId]
  );

  const table = useTable<FlashcardDeckRow>({
    columns,
    initialState: {
      columnFilters: courseId ? [{ id: "class_id_filter_col", value: courseId }] : [],
      pagination: {
        pageIndex: 0,
        pageSize: 20
      },
      sorting: [{ id: "created_at", desc: true }]
    },
    refineCoreProps: {
      resource: "flashcard_decks",
      filters: {
        mode: "off" // Handled by column filters
      },
      sorters: {
        mode: "off" // Client-side sorting
      },
      pagination: {
        mode: "off" // Client-side pagination
      },
      meta: {
        select: "*"
      }
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
    getPageCount,
    refineCore: { tableQuery }
  } = table;

  const { isLoading, isError, error } = tableQuery;

  if (isLoading) {
    return <Spinner size="lg" />;
  }

  if (isError) {
    return <Text color="red.500">Error loading flashcard decks: {error?.message}</Text>;
  }

  const currentRows = getRowModel().rows;

  return (
    <VStack align="stretch" w="100%">
      <Table.Root striped>
        <Table.Header>
          {getHeaderGroups().map((headerGroup) => (
            <Table.Row bg="bg.subtle" key={headerGroup.id}>
              {headerGroup.headers
                .filter((h) => h.id !== "class_id_filter_col")
                .map((header) => (
                  <Table.ColumnHeader key={header.id}>
                    {header.isPlaceholder ? null : (
                      <>
                        <Text
                          onClick={header.column.getToggleSortingHandler()}
                          cursor={header.column.getCanSort() ? "pointer" : "default"}
                          textAlign={header.column.id === "actions" ? "center" : undefined}
                          title={header.column.getCanSort() ? `Sort by ${header.column.id}` : undefined}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {{
                            asc: " 🔼",
                            desc: " 🔽"
                          }[header.column.getIsSorted() as string] ?? null}
                        </Text>
                        {header.column.getCanFilter() && header.column.id !== "actions" ? (
                          <Input
                            mt={1}
                            size="sm"
                            placeholder={`Filter ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}`}
                            value={(header.column.getFilterValue() as string) ?? ""}
                            onChange={(e) => header.column.setFilterValue(e.target.value)}
                            aria-label={`Filter by ${typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}`}
                          />
                        ) : null}
                      </>
                    )}
                  </Table.ColumnHeader>
                ))}
            </Table.Row>
          ))}
        </Table.Header>
        <Table.Body>
          {currentRows.map((row) => (
            <Table.Row key={row.id}>
              {row
                .getVisibleCells()
                .filter((cell) => cell.column.id !== "class_id_filter_col")
                .map((cell) => (
                  <Table.Cell key={cell.id} textAlign={cell.column.id === "actions" ? "center" : undefined}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </Table.Cell>
                ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>

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
            onChange={(selectedOption) => {
              if (selectedOption) {
                setPageSize(selectedOption.value);
              }
            }}
            options={[10, 20, 30, 40, 50].map((pageSize) => ({
              value: pageSize,
              label: `${pageSize} rows`
            }))}
            size="sm"
            isSearchable={false}
            placeholder="Select page size"
            aria-label="Rows per page"
            chakraStyles={{
              container: (provided) => ({
                ...provided,
                width: "120px"
              }),
              control: (provided) => ({
                ...provided,
                minHeight: "32px"
              })
            }}
          />
        </HStack>
      </HStack>

      {/* Summary Information */}
      <Text fontSize="sm" color="gray.600" textAlign="center">
        Showing {currentRows.length} of {getRowModel().rows.length} flashcard decks
      </Text>
    </VStack>
  );
}
