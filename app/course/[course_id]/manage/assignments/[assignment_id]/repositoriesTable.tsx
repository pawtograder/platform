"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ServerFilter, useCustomTable } from "@/hooks/useCustomTable";
import { Repo } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, HStack, NativeSelect, Table, Text, VStack } from "@chakra-ui/react";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

export default function RepositoriesTable() {
  const { assignment_id, course_id } = useParams();
  const [search, setSearch] = useState("");
  const [ownerType, setOwnerType] = useState<"all" | "individual" | "group">("all");

  const columns = useMemo<ColumnDef<Database["public"]["Tables"]["repositories"]["Row"]>[]>(
    () => [
      { id: "id", header: "ID", accessorKey: "id" },
      {
        id: "repository",
        header: "Repository",
        accessorKey: "repository",
        cell: ({ getValue }) => {
          const full = String(getValue());
          return (
            <a href={`https://github.com/${full}`} target="_blank" rel="noreferrer">
              {full}
            </a>
          );
        }
      },
      {
        id: "owner",
        header: "Owner",
        cell: ({ row }) => {
          const r = row.original as Repo;
          if (r.assignment_group_id) return <Text>Group #{r.assignment_group_id}</Text>;
          if (r.profile_id) return <Text>Student</Text>;
          return <Text>-</Text>;
        }
      },
      { id: "synced_repo_sha", header: "Repo Head SHA", accessorKey: "synced_repo_sha" },
      { id: "synced_handout_sha", header: "Handout SHA", accessorKey: "synced_handout_sha" }
    ],
    []
  );

  const serverFilters = useMemo<ServerFilter[]>(() => {
    const filters: ServerFilter[] = [
      { field: "assignment_id", operator: "eq", value: Number(assignment_id) },
      { field: "class_id", operator: "eq", value: Number(course_id) }
    ];
    return filters;
  }, [assignment_id, course_id]);

  const { getHeaderGroups, getRowModel, isLoading } =
    useCustomTable<Database["public"]["Tables"]["repositories"]["Row"]>({
      columns,
      resource: "repositories",
      serverFilters,
      select: "*",
      initialState: {
        sorting: [{ id: "repository", desc: false }],
        pagination: { pageIndex: 0, pageSize: 100 }
      }
    });

  // Client-side filters for search and owner type
  const filteredRows = getRowModel().rows.filter((row) => {
    const r = row.original as Repo;
    const repoName = r.repository?.toLowerCase() || "";
    if (search && !repoName.includes(search.toLowerCase())) return false;
    if (ownerType === "individual" && !r.profile_id) return false;
    if (ownerType === "group" && !r.assignment_group_id) return false;
    return true;
  });

  return (
    <VStack w="100%" alignItems="stretch" gap={3} mt={3}>
      <HStack gap={3} wrap="wrap">
        <Field label="Search repos" helperText="Filter by repository full name (org/repo)">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="org/assignment-*" />
        </Field>
        <Field label="Owner type" helperText="Filter by individual or group repos">
          <NativeSelect.Root>
            <NativeSelect.Field value={ownerType} onChange={(e) => setOwnerType((e.target.value as "all" | "individual" | "group") || "all")}>
              <option value="all">All</option>
              <option value="individual">Individual</option>
              <option value="group">Group</option>
            </NativeSelect.Field>
          </NativeSelect.Root>
        </Field>
      </HStack>

      <Box overflowX="auto" maxW="100vw" maxH="100vh" overflowY="auto">
        <Table.Root minW="0">
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {isLoading && (
              <Table.Row>
                <Table.Cell colSpan={columns.length}>
                  <Text>Loading…</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {!isLoading && filteredRows.length === 0 && (
              <Table.Row>
                <Table.Cell colSpan={columns.length}>
                  <Text>No repositories found</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {filteredRows.map((row) => (
              <Table.Row key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <Table.Cell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell ?? ((info) => info.getValue()), cell.getContext())}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}
