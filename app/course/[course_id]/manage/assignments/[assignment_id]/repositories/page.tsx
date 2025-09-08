"use client";

import { useCourseController } from "@/hooks/useCourseController";
import TableController from "@/lib/TableController";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { useTableControllerTable } from "@/hooks/useTableControllerTable";
import Link from "next/link";
import {
  Box,
  HStack,
  Icon,
  Table,
  Text,
  VStack,
  Button,
  Input,
  NativeSelect,
  NativeSelectField
} from "@chakra-ui/react";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { CheckIcon } from "lucide-react";
import { FaTimes, FaExternalLinkAlt } from "react-icons/fa";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database } from "@/utils/supabase/SupabaseTypes";

type RepositoryRow = GetResult<
  Database["public"],
  Database["public"]["Tables"]["repositories"]["Row"],
  "repositories",
  Database["public"]["Tables"]["repositories"]["Relationships"],
  "*, assignment_groups(*), profiles(*)"
>;

export default function RepositoriesPage() {
  const { assignment_id } = useParams();
  const courseController = useCourseController();
  const joinedSelect = "*, assignment_groups(*), profiles(*)";
  const repositories: TableController<"repositories", typeof joinedSelect, number> = useMemo(() => {
    const client = createClient();
    const query = client.from("repositories").select(joinedSelect).eq("assignment_id", Number(assignment_id));
    const controller = new TableController({
      query,
      client: client,
      table: "repositories",
      selectForSingleRow: joinedSelect,
      classRealTimeController: courseController.classRealTimeController
    });
    return controller;
  }, [assignment_id, courseController]);
  const columns = useMemo<ColumnDef<RepositoryRow>[]>(
    () => [
      {
        id: "group_name",
        header: "Group",
        accessorFn: (row) => row.assignment_groups?.name ?? "—",
        cell: ({ row }) => <Text>{row.original.assignment_groups?.name ?? "—"}</Text>,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const name = (row.original as RepositoryRow).assignment_groups?.name ?? "—";
          return values.includes(name);
        }
      },
      {
        id: "profile_name",
        header: "Student",
        accessorFn: (row) => row.profiles?.name ?? "—",
        cell: ({ row }) => <Text>{row.original.profiles?.name ?? "—"}</Text>,
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const name = (row.original as RepositoryRow).profiles?.name ?? "—";
          return values.some((val) => name.toLowerCase().includes(String(val).toLowerCase()));
        }
      },
      {
        id: "repository",
        header: "Repository",
        accessorKey: "repository",
        cell: ({ row }) => (
          <HStack gap={2}>
            <Link href={`https://github.com/${row.original.repository}`} target="_blank">
              {row.original.repository}
            </Link>
            <Icon as={FaExternalLinkAlt} color="gray.500" />
          </HStack>
        ),
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const repo = (row.original as RepositoryRow).repository;
          return values.some((val) => repo.toLowerCase().includes(String(val).toLowerCase()));
        }
      },
      {
        id: "is_github_ready",
        header: "GitHub Ready",
        accessorKey: "is_github_ready",
        cell: ({ row }) => (
          <HStack>
            {row.original.is_github_ready ? (
              <>
                <Icon as={CheckIcon} color="green.500" />
                <Text color="green.600">Ready</Text>
              </>
            ) : (
              <>
                <Icon as={FaTimes} color="red.500" />
                <Text color="red.600">Not Ready</Text>
              </>
            )}
          </HStack>
        ),
        filterFn: (row, _id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = (row.original as RepositoryRow).is_github_ready ? "Yes" : "No";
          return values.includes(val);
        }
      }
    ],
    []
  );

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
    data
  } = useTableControllerTable({
    columns,
    tableController: repositories,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 50
      }
    }
  });

  const [pageCount, setPageCount] = useState(0);
  const nRows = getRowModel().rows.length;
  const pageSize = getState().pagination.pageSize;
  useEffect(() => {
    setPageCount(Math.ceil(nRows / pageSize) || 1);
  }, [nRows, pageSize]);

  const dataForOptions = useMemo(() => {
    const rows = (data as unknown as RepositoryRow[]) ?? [];
    const groupSet = new Set<string>();
    const studentSet = new Set<string>();
    const repoSet = new Set<string>();
    for (const r of rows) {
      groupSet.add(r.assignment_groups?.name ?? "—");
      studentSet.add(r.profiles?.name ?? "—");
      repoSet.add(r.repository);
    }
    return {
      groups: Array.from(groupSet.values()),
      students: Array.from(studentSet.values()),
      repos: Array.from(repoSet.values())
    };
  }, [data]);

  return (
    <VStack w="100%">
      <VStack paddingBottom="55px" w="100%">
        <Box overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto" w="100%">
          <Table.Root minW="0" w="100%">
            <Table.Header>
              {getHeaderGroups().map((headerGroup) => (
                <Table.Row key={headerGroup.id} bg="bg.subtle">
                  {headerGroup.headers.map((header) => (
                    <Table.ColumnHeader key={header.id}>
                      {header.isPlaceholder ? null : (
                        <>
                          <Text onClick={header.column.getToggleSortingHandler()}>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {{
                              asc: " 🔼",
                              desc: " 🔽"
                            }[header.column.getIsSorted() as string] ?? " 🔄"}
                          </Text>
                          {header.id === "group_name" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.groups.map((name) => ({ label: name, value: name }))}
                              placeholder="Filter by group..."
                            />
                          )}
                          {header.id === "profile_name" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.students.map((name) => ({ label: name, value: name }))}
                              placeholder="Filter by student..."
                            />
                          )}
                          {header.id === "repository" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={dataForOptions.repos.map((repo) => ({ label: repo, value: repo }))}
                              placeholder="Filter by repository..."
                            />
                          )}
                          {header.id === "is_github_ready" && (
                            <Select
                              isMulti={true}
                              id={header.id}
                              onChange={(e) => {
                                const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                                header.column.setFilterValue(values.length > 0 ? values : undefined);
                              }}
                              options={[
                                { label: "Yes", value: "Yes" },
                                { label: "No", value: "No" }
                              ]}
                              placeholder="Filter by readiness..."
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
              {getRowModel().rows.map((row) => (
                <Table.Row key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Box>

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
            <Button size="sm" onClick={() => setPageIndex(pageCount - 1)} disabled={!getCanNextPage()}>
              {">>"}
            </Button>
          </HStack>

          <HStack gap={2} alignItems="center">
            <Text whiteSpace="nowrap">
              Page{" "}
              <strong>
                {getState().pagination.pageIndex + 1} of {pageCount}
              </strong>
            </Text>
            <Text whiteSpace="nowrap">| Go to page:</Text>
            <Input
              type="number"
              defaultValue={getState().pagination.pageIndex + 1}
              min={1}
              max={pageCount}
              onChange={(e) => {
                const page = e.target.value ? Number(e.target.value) - 1 : 0;
                const newPageIndex = Math.max(0, Math.min(page, pageCount - 1));
                setPageIndex(newPageIndex);
              }}
              width="60px"
              textAlign="center"
            />
          </HStack>

          <NativeSelect.Root title="Select page size" aria-label="Select page size" width="120px">
            <NativeSelectField
              title="Select page size"
              aria-label="Select page size"
              value={getState().pagination.pageSize}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                setPageSize(Number(e.target.value));
              }}
            >
              {[25, 50, 100, 200, 500].map((pageSizeOption) => (
                <option key={pageSizeOption} value={pageSizeOption}>
                  Show {pageSizeOption}
                </option>
              ))}
            </NativeSelectField>
          </NativeSelect.Root>
        </HStack>
      </VStack>
    </VStack>
  );
}
