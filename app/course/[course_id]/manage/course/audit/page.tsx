"use client";
import { Tooltip } from "@/components/ui/tooltip";
import { AuditEvent, UserRoleWithPrivateProfileAndUser } from "@/utils/supabase/DatabaseTypes";
import { useCustomTable } from "@/hooks/useCustomTable";
import {
  Box,
  Button,
  Container,
  DataList,
  Heading,
  HStack,
  Icon,
  Input,
  List,
  NativeSelect,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useList } from "@refinedev/core";
import { ColumnDef, flexRender } from "@tanstack/react-table";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { FaSort, FaSortUp, FaSortDown } from "react-icons/fa";

type JsonPrimitive = string | number | boolean | null;

function AuditEventDiff({
  oldValue,
  newValue
}: {
  oldValue: JsonPrimitive | undefined;
  newValue: JsonPrimitive | undefined;
}) {
  if (oldValue === true || oldValue === false) {
    oldValue = oldValue ? "True" : "False";
  }
  if (newValue === true || newValue === false) {
    newValue = newValue ? "True" : "False";
  }

  const formatValue = (value: JsonPrimitive | undefined | object) => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  if (!oldValue && newValue) {
    return (
      <Text textStyle="sm" color="text.muted">
        {formatValue(newValue)}
      </Text>
    );
  }
  if (oldValue && !newValue) {
    return (
      <Text textStyle="sm" color="text.muted">
        Removed
      </Text>
    );
  }
  return (
    <Box maxW="200px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
      <Text textStyle="sm" color="text.muted">
        Was: {formatValue(oldValue)}
      </Text>
      <Text textStyle="sm" color="text.muted">
        Now: {formatValue(newValue)}
      </Text>
    </Box>
  );
}
function JSONDiff({
  oldValue,
  newValue
}: {
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
}) {
  const propertiesChanged = useMemo(() => {
    const isDifferent = (a: unknown, b: unknown) => {
      if (typeof a === "string" || typeof b === "string") {
        return a !== b;
      }
      return JSON.stringify(a) !== JSON.stringify(b);
    };
    if (oldValue === null && newValue === null) {
      return [];
    }

    const oldProperties = typeof oldValue === "object" && oldValue !== null ? Object.keys(oldValue) : [];
    const newProperties = typeof newValue === "object" && newValue !== null ? Object.keys(newValue) : [];
    const properties = new Set([...oldProperties, ...newProperties]);

    return Array.from(properties).filter((property) => {
      const oldPropValue = oldValue?.[property];
      const newPropValue = newValue?.[property];
      const changed = isDifferent(oldPropValue, newPropValue);
      // Check if values are primitives (or null/undefined) before passing to AuditEventDiff
      const oldIsPrimitive = typeof oldPropValue !== "object" || oldPropValue === null;
      const newIsPrimitive = typeof newPropValue !== "object" || newPropValue === null;
      return (
        changed && (oldIsPrimitive || oldPropValue === undefined) && (newIsPrimitive || newPropValue === undefined)
      );
    });
  }, [oldValue, newValue]);
  return (
    <DataList.Root orientation="horizontal">
      {propertiesChanged.map((property) => {
        return (
          <Tooltip
            key={property}
            content={
              <Box>
                Was: <pre>{JSON.stringify(oldValue?.[property] ?? null)}</pre>
                Now: <pre>{JSON.stringify(newValue?.[property] ?? null)}</pre>
              </Box>
            }
          >
            <DataList.Item>
              <DataList.ItemLabel>{property}</DataList.ItemLabel>
              <DataList.ItemValue>
                <AuditEventDiff
                  oldValue={oldValue?.[property] as JsonPrimitive | undefined}
                  newValue={newValue?.[property] as JsonPrimitive | undefined}
                />
              </DataList.ItemValue>
            </DataList.Item>
          </Tooltip>
        );
      })}
    </DataList.Root>
  );
}
function AuditTable() {
  const { course_id } = useParams();
  const roster = useList<UserRoleWithPrivateProfileAndUser>({
    resource: "user_roles",
    meta: {
      select: "*,profiles!private_profile_id(*)"
    },
    filters: [
      {
        field: "class_id",
        operator: "eq",
        value: course_id as string
      }
    ]
  });

  // Memoize server filters to prevent unnecessary re-fetching
  const serverFilters = useMemo(
    () => [{ field: "class_id", operator: "eq" as const, value: Number(course_id) }],
    [course_id]
  );

  const columns = useMemo<ColumnDef<AuditEvent>[]>(
    () => [
      {
        id: "created_at",
        accessorKey: "created_at",
        header: "Date",
        enableColumnFilter: true,
        enableHiding: true,
        cell: (props) => {
          return <Text>{new Date(props.getValue() as string).toLocaleString()}</Text>;
        },
        filterFn: (row, id, filterValue) => {
          const date = new Date(row.original.created_at);
          const filterString = String(filterValue);
          return date.toLocaleString().toLowerCase().includes(filterString.toLowerCase());
        }
      },
      {
        id: "user_id",
        accessorKey: "user_id",
        header: "Student Name",
        enableColumnFilter: true,
        enableHiding: true,
        cell: (props) => {
          return (
            <Text>{roster.data?.data.find((r) => r.user_id === (props.getValue() as string))?.profiles?.name}</Text>
          );
        },
        filterFn: (row, id, filterValue) => {
          const name = roster.data?.data.find((r) => r.user_id === row.original.user_id)?.profiles?.name;
          const filterString = String(filterValue).toLowerCase();
          return name?.toLocaleLowerCase().includes(filterString) || false;
        }
      },
      {
        id: "ip_addr",
        accessorKey: "ip_addr",
        header: "IP Address",
        enableColumnFilter: true,
        enableHiding: true,
        filterFn: (row, id, filterValue) => {
          const ip = row.original.ip_addr;
          if (!ip) return false;
          const filterString = String(filterValue);
          return ip.includes(filterString);
        }
      },
      {
        id: "table",
        accessorKey: "table",
        header: "Table",
        enableColumnFilter: true,
        enableHiding: true,
        filterFn: (row, id, filterValue) => {
          const table = row.original.table;
          if (!table) return false;
          const filterString = String(filterValue).toLowerCase();
          return table.toLowerCase().includes(filterString);
        }
      },
      {
        id: "resource_id",
        accessorKey: "new.id",
        header: "Resource ID",
        enableColumnFilter: true,
        enableHiding: true,
        filterFn: (row, id, filterValue) => {
          let resourceId: string | number | undefined | null = null;
          if (typeof row.original.new === "object" && row.original.new !== null && "id" in row.original.new) {
            resourceId = row.original.new.id as string | number | undefined | null;
          }

          if (resourceId === null || resourceId === undefined) return false;
          const filterString = String(filterValue);
          return String(resourceId).includes(filterString);
        }
      },
      {
        id: "old",
        accessorKey: "old",
        header: "Change",
        enableColumnFilter: true,
        enableHiding: true,
        cell: (props) => {
          const oldValue = props.getValue();
          const newValue = props.row.original.new;
          const isOldObjectOrNull = typeof oldValue === "object" || oldValue === null;
          const isNewObjectOrNull = typeof newValue === "object" || newValue === null;

          if (isOldObjectOrNull && isNewObjectOrNull) {
            return (
              <JSONDiff
                oldValue={oldValue as Record<string, unknown> | null}
                newValue={newValue as Record<string, unknown> | null}
              />
            );
          } else {
            // Handle cases where one or both values are not objects (e.g., primitives directly)
            // Or provide a different display if needed.
            return (
              <Text textStyle="sm" color="text.muted">
                Change not displayable as object diff
              </Text>
            );
          }
        }
      }
    ],
    [roster.data?.data]
  );

  const {
    getHeaderGroups,
    getRowModel,
    getState,
    setPageIndex,
    getCanPreviousPage,
    getCanNextPage,
    getRowCount,
    nextPage,
    previousPage,
    setPageSize,
    getPrePaginationRowModel,
    isLoading,
    error
  } = useCustomTable({
    columns,
    resource: "audit",
    serverFilters,
    select: "*",
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 50
      },
      sorting: [{ id: "created_at", desc: true }]
    }
  });

  const nRows = getRowCount();
  const pageSize = getState().pagination.pageSize;
  const pageCount = Math.ceil(nRows / pageSize);

  if (isLoading) {
    return (
      <VStack>
        <Text>Loading audit data...</Text>
      </VStack>
    );
  }

  if (error) {
    return (
      <VStack>
        <Text color="red.500">Error loading audit data: {error.message}</Text>
      </VStack>
    );
  }

  return (
    <VStack>
      <VStack paddingBottom="55px">
        <Table.Root striped>
          <Table.Header>
            {getHeaderGroups().map((headerGroup) => (
              <Table.Row bg="bg.subtle" key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
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
                  );
                })}
              </Table.Row>
            ))}
          </Table.Header>
          <Table.Body>
            {getRowModel().rows.map((row) => {
              return (
                <Table.Row key={row.id}>
                  {row.getVisibleCells().map((cell) => {
                    return (
                      <Table.Cell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</Table.Cell>
                    );
                  })}
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
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
          <Button onClick={() => setPageIndex(pageCount - 1)} disabled={!getCanNextPage()}>
            {">>"}
          </Button>
          <VStack>
            <Text>Page</Text>
            <Text>
              {getState().pagination.pageIndex + 1} of {pageCount}
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
            <NativeSelect.Root>
              <NativeSelect.Field
                title="Select page size"
                value={"" + getState().pagination.pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                }}
              >
                {[25, 50, 100, 200, 500].map((pageSize) => (
                  <option key={pageSize} value={pageSize}>
                    Show {pageSize}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </VStack>
        </HStack>
        <div>{getPrePaginationRowModel().rows.length} Rows</div>
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
        <HStack></HStack>
      </Box>
    </VStack>
  );
}
export default function AuditPage() {
  return (
    <Container p={4}>
      <Heading size="lg">Audit Log</Heading>
      <Text textStyle="sm" color="text.muted">
        The audit log records all actions taken on the following resources:
      </Text>
      <List.Root pl={8} textStyle="sm">
        <List.Item>Assignments</List.Item>
        <List.Item>Assignment Due Date Exceptions</List.Item>
        <List.Item>Assignment Groups</List.Item>
        <List.Item>Discussion Threads</List.Item>
        <List.Item>Rubric Checks</List.Item>
        <List.Item>Rubric Criteria</List.Item>
        <List.Item>Rubric Parts</List.Item>
        <List.Item>Submissions</List.Item>
        <List.Item>Submission Reviews</List.Item>
        <List.Item>Submission Comments (both global comments and line annotations)</List.Item>
      </List.Root>
      <AuditTable />
    </Container>
  );
}
