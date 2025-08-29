"use client";

import { useMemo, useCallback } from "react";
import { IconButton, HStack, Table, Text, Input, NativeSelect, VStack, Spinner } from "@chakra-ui/react";
import { useDelete } from "@refinedev/core";
import { useTable } from "@refinedev/react-table";
import { type ColumnDef, flexRender, type Row } from "@tanstack/react-table";
import { FaTrash } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { PopConfirm } from "@/components/ui/popconfirm";
import { Tooltip } from "@/components/ui/tooltip";
import PersonName from "@/components/ui/person-name";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles } from "@/hooks/useClassProfiles";

type GradingConflictRow = Database["public"]["Tables"]["grading_conflicts"]["Row"];

export type GradingConflictWithPopulatedProfiles = GradingConflictRow & {
  grader_profile?: { id: string; name?: string | null };
  student_profile?: { id: string; name?: string | null };
  created_by_profile?: { id: string; name?: string | null };
};

interface GradingConflictsTableProps {
  courseId: string | number;
  onConflictDeleted: () => void;
}

export default function GradingConflictsTable({ courseId, onConflictDeleted }: GradingConflictsTableProps) {
  const { role } = useClassProfiles();
  const isGrader = role.role === "grader";

  const { mutateAsync: deleteConflict } = useDelete();

  const handleDelete = useCallback(
    async (id: number) => {
      await deleteConflict(
        {
          resource: "grading_conflicts",
          id: id
        },
        {
          onSuccess: () => {
            toaster.success({ title: "Conflict deleted successfully" });
            onConflictDeleted();
          },
          onError: (error) => {
            toaster.error({ title: "Error deleting conflict", description: error.message });
          }
        }
      );
    },
    [deleteConflict, onConflictDeleted]
  );

  const columns = useMemo<ColumnDef<GradingConflictWithPopulatedProfiles>[]>(
    () => [
      {
        id: "class_id_filter_col", // Renamed for clarity, will be hidden
        accessorKey: "class_id",
        header: "Class ID",
        enableHiding: true,
        filterFn: (row: Row<GradingConflictWithPopulatedProfiles>, columnId: string, filterValue: string | number) => {
          return String(row.original.class_id) === String(filterValue);
        }
      },
      {
        id: "grader",
        header: "Grader",
        accessorFn: (row) => row.grader_profile?.name || row.grader_profile_id,
        cell: function render({ row }) {
          return <PersonName uid={row.original.grader_profile_id} />;
        },
        enableColumnFilter: true,
        filterFn: (row, columnId: string, filterValue: string) => {
          const profile = row.original.grader_profile;
          const filterString = String(filterValue).toLowerCase();
          if (profile?.name && profile.name.toLowerCase().includes(filterString)) return true;
          return String(row.original.grader_profile_id).toLowerCase().includes(filterString);
        }
      },
      {
        id: "student",
        header: "Student",
        accessorFn: (row) => row.student_profile?.name || row.student_profile_id,
        cell: function render({ row }) {
          return <PersonName uid={row.original.student_profile_id} />;
        },
        enableColumnFilter: true,
        filterFn: (row, columnId: string, filterValue: string) => {
          const profile = row.original.student_profile;
          const filterString = String(filterValue).toLowerCase();
          if (profile?.name && profile.name.toLowerCase().includes(filterString)) return true;
          return String(row.original.student_profile_id).toLowerCase().includes(filterString);
        }
      },
      {
        id: "reason",
        header: "Reason",
        accessorKey: "reason",
        cell: function render({ getValue }) {
          return (
            <Text style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{(getValue() as string) || "N/A"}</Text>
          );
        },
        enableColumnFilter: true,
        filterFn: (row, columnId: string, filterValue: string) => {
          const reason = row.original.reason;
          const filterString = String(filterValue).toLowerCase();
          return reason ? reason.toLowerCase().includes(filterString) : filterString === "n/a" || filterString === "";
        }
      },
      {
        id: "created_by",
        header: "Created By",
        accessorFn: (row) => row.created_by_profile?.name || row.created_by_profile_id,
        cell: function render({ row }) {
          return <PersonName uid={row.original.created_by_profile_id} />;
        },
        enableColumnFilter: true,
        filterFn: (row, columnId: string, filterValue: string) => {
          const profile = row.original.created_by_profile;
          const filterString = String(filterValue).toLowerCase();
          if (profile?.name && profile.name.toLowerCase().includes(filterString)) return true;
          return String(row.original.created_by_profile_id).toLowerCase().includes(filterString);
        }
      },
      {
        id: "created_at",
        header: "Created At",
        accessorKey: "created_at",
        cell: function render({ getValue }) {
          return new Date(getValue() as string).toLocaleString();
        }
      },
      {
        id: "actions",
        header: "Actions",
        accessorKey: "id",
        enableSorting: false,
        enableColumnFilter: false,
        cell: function render({ row }) {
          const conflictId = row.original.id;

          const deleteButton = (
            <IconButton
              aria-label="Delete conflict"
              colorPalette="red"
              variant="ghost"
              size="sm"
              disabled={isGrader}
              opacity={isGrader ? 0.5 : 1}
              cursor={isGrader ? "not-allowed" : "pointer"}
            >
              <FaTrash />
            </IconButton>
          );

          if (isGrader) {
            return (
              <Tooltip content="Please contact your instructor to ask them to delete this conflict.">
                {deleteButton}
              </Tooltip>
            );
          }

          return (
            <PopConfirm
              triggerLabel="Delete"
              confirmHeader="Delete Grading Conflict"
              confirmText="Are you sure you want to delete this grading conflict?"
              onConfirm={async () => await handleDelete(conflictId)}
              trigger={deleteButton}
            />
          );
        }
      }
    ],
    [handleDelete, isGrader]
  );

  const table = useTable<GradingConflictWithPopulatedProfiles>({
    columns: columns,
    initialState: {
      columnFilters: [{ id: "class_id_filter_col", value: courseId as string | number }],
      pagination: { pageIndex: 0, pageSize: 50 }
    },
    refineCoreProps: {
      resource: "grading_conflicts",
      filters: { mode: "off" },
      sorters: { mode: "off" }, // Client-side sorting
      pagination: { mode: "off" }, // Client-side pagination
      meta: {
        select:
          "*, grader_profile:profiles!grading_conflicts_grader_profile_id_fkey(id, name), student_profile:profiles!grading_conflicts_student_profile_id_fkey(id, name), created_by_profile:profiles!grading_conflicts_created_by_profile_id_fkey(id, name)"
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

  const { isLoading: isLoadingConflicts, isError, error } = tableQuery;

  if (isLoadingConflicts) {
    return <Spinner />;
  }

  if (isError) {
    return <Text color="red.500">Error loading grading conflicts: {error?.message}</Text>;
  }

  const currentRows = getRowModel().rows;

  return (
    <VStack align="stretch" w="100%">
      <Table.Root>
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
                        {header.column.getCanFilter() ? (
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
          <Text whiteSpace="nowrap">
            Page{" "}
            <strong>
              {getState().pagination.pageIndex + 1} of {getPageCount()}
            </strong>
          </Text>
          <Text whiteSpace="nowrap">| Go to page:</Text>
          <Input
            type="number"
            defaultValue={getState().pagination.pageIndex + 1}
            min={1}
            max={getPageCount() || 1}
            onChange={(e) => {
              const page = e.target.value ? Number(e.target.value) - 1 : 0;
              const newPageIndex = Math.max(0, Math.min(page, getPageCount() > 0 ? getPageCount() - 1 : 0));
              setPageIndex(newPageIndex);
            }}
            width="60px"
            size="sm"
            textAlign="center"
            aria-label="Go to page number"
          />
        </HStack>
        <NativeSelect.Root
          title="Select number of conflicts to display per page"
          aria-label="Select page size to show"
          width="120px"
          size="sm"
        >
          <NativeSelect.Field
            id="page-size-select"
            title="Select page size"
            aria-label="Select number of items per page"
            value={getState().pagination.pageSize}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              setPageSize(Number(e.target.value));
            }}
          >
            {[10, 20, 30, 40, 50, 100].map((pageSizeOption) => (
              <option key={pageSizeOption} value={pageSizeOption}>
                Show {pageSizeOption}
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
      </HStack>
    </VStack>
  );
}
