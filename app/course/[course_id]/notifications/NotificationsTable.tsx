"use client";

import NotificationTeaser from "@/components/notifications/notification-teaser";
import { toaster } from "@/components/ui/toaster";
import { useNotifications } from "@/hooks/useNotifications";
import { Notification } from "@/utils/supabase/DatabaseTypes";
import { Badge, Box, Button, HStack, Icon, IconButton, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import * as Sentry from "@sentry/nextjs";
import { useParams } from "next/navigation";
import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    RowSelectionState,
    useReactTable
} from "@tanstack/react-table";
import { Select } from "chakra-react-select";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useMemo, useState } from "react";
import { FaSort, FaSortDown, FaSortUp, FaTrash } from "react-icons/fa";

function getType(n: Notification): string {
  const body = n.body && typeof n.body === "object" ? (n.body as { type?: string }) : undefined;
  return body?.type ?? "unknown";
}

// Keeping getSystemField around if we later reintroduce system columns
// function getSystemField<T extends string>(n: Notification, field: "display" | "severity"): T | undefined {
//   const body = n.body && typeof n.body === "object" ? (n.body as Record<string, unknown>) : undefined;
//   if (!body || body["type"] !== "system") return undefined;
//   return body[field] as T | undefined;
// }

export default function NotificationsTable() {
  const { notifications, set_read, dismiss } = useNotifications();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const { course_id } = useParams();

  const data = useMemo(() => notifications || [], [notifications]);

  function isHelpRequest(n: Notification): boolean {
    const body = n.body && typeof n.body === "object" ? (n.body as Record<string, unknown>) : undefined;
    return body?.["type"] === "help_request";
  }
  function isHelpRequestMessage(n: Notification): boolean {
    const body = n.body && typeof n.body === "object" ? (n.body as Record<string, unknown>) : undefined;
    return body?.["type"] === "help_request_message";
  }
  const getQueue = useCallback((n: Notification): string => {
    const body = (n.body || {}) as { help_queue_name?: string };
    return body.help_queue_name ?? "";
  }, []);
  const getWho = useCallback((n: Notification): string => {
    const body = (n.body || {}) as { creator_name?: string; author_name?: string };
    if (isHelpRequest(n)) return body.creator_name ?? "";
    if (isHelpRequestMessage(n)) return body.author_name ?? "";
    return "";
  }, []);
  const getAssignee = useCallback((n: Notification): string => {
    const body = (n.body || {}) as { assignee_name?: string };
    return body.assignee_name ?? "";
  }, []);
  const getStatus = useCallback((n: Notification): string => {
    const body = (n.body || {}) as { status?: string };
    return body.status ?? "";
  }, []);
  const getPreview = useCallback((n: Notification): string => {
    const body = (n.body || {}) as { request_preview?: string; request_subject?: string; message_preview?: string };
    if (isHelpRequest(n)) return body.request_preview ?? body.request_subject ?? "";
    if (isHelpRequestMessage(n)) return body.message_preview ?? "";
    return "";
  }, []);
  const openHelpRequest = useCallback((n: Notification) => {
    try {
      const body = (n.body || {}) as { help_request_id?: number | string; help_queue_name?: string };
      const popOutUrl = `/course/${course_id}/office-hours/request/${String(body.help_request_id ?? "")}?popout=true`;
      const newWindow = window.open(
        popOutUrl,
        `help-request-chat-${String(body.help_request_id ?? "")}`,
        "width=800,height=600,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=no,status=no"
      );
      if (newWindow) {
        newWindow.focus();
        newWindow.addEventListener("load", () => {
          const windowTitle = `Help Request #${String(body.help_request_id ?? "")} - ${String(body.help_queue_name ?? "")}`;
          newWindow.document.title = windowTitle;
        });
      } else {
        toaster.error({ title: "Pop-out blocked", description: "Enable pop-ups to open help request." });
      }
    } catch (e) {
      Sentry.captureException(e);
      toaster.error({ title: "Failed to open", description: e instanceof Error ? e.message : String(e) });
    }
  }, [course_id]);

  const columns = useMemo<ColumnDef<Notification>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => {
          const allPageSelected = table.getRowModel().rows.length > 0 && table.getRowModel().rows.every((r) => r.getIsSelected());
          const someSelected = table.getRowModel().rows.some((r) => r.getIsSelected());
          return (
            <HStack alignItems="center" gap={2}>
              <input
                title="Select all"
                type="checkbox"
                checked={allPageSelected}
                ref={(el) => {
                  if (el) (el as HTMLInputElement).indeterminate = !allPageSelected && someSelected;
                }}
                onChange={(e) => table.getRowModel().rows.forEach((r) => r.toggleSelected(!!e.target.checked))}
              />
              <Text>Select all</Text>
            </HStack>
          );
        },
        cell: ({ row }) => (
          <input title={`Select row ${row.id}`} type="checkbox" checked={row.getIsSelected()} onChange={row.getToggleSelectedHandler()} />
        ),
        enableSorting: false,
        enableColumnFilter: false,
        size: 24
      },
      {
        id: "content",
        header: "",
        cell: ({ row }) => {
          const n = row.original;
          if (isHelpRequest(n) || isHelpRequestMessage(n)) {
            return <></>;
          }
          return (
            <NotificationTeaser
              notification_id={n.id}
              markAsRead={() => set_read(n, true)}
              dismiss={() => dismiss(n)}
            />
          );
        },
        enableSorting: false
      },
      {
        id: "queue",
        header: "Queue",
        accessorFn: (row) => (isHelpRequest(row) || isHelpRequestMessage(row) ? getQueue(row) : ""),
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = (row.getValue(id) as string) || "";
          return values.includes(val);
        }
      },
      {
        id: "who",
        header: "Who",
        accessorFn: (row) => (isHelpRequest(row) || isHelpRequestMessage(row) ? getWho(row) : ""),
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = (row.getValue(id) as string) || "";
          return values.includes(val);
        }
      },
      {
        id: "assignee",
        header: "Assignee",
        accessorFn: (row) => (isHelpRequest(row) ? getAssignee(row) : ""),
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = (row.getValue(id) as string) || "";
          return values.includes(val) || (val === "" && values.includes("Unassigned"));
        }
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (row) => (isHelpRequest(row) ? getStatus(row) : ""),
        enableColumnFilter: true,
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = (row.getValue(id) as string) || "";
          return values.includes(val);
        }
      },
      {
        id: "preview",
        header: "Preview",
        accessorFn: (row) => (isHelpRequest(row) || isHelpRequestMessage(row) ? getPreview(row) : ""),
        enableColumnFilter: true,
        cell: ({ getValue }) => {
          const v = (getValue<string>() || "").trim();
          return v ? <Text lineClamp={2}>{v}</Text> : <Text color="fg.muted">—</Text>;
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || (Array.isArray(filterValue) && filterValue.length === 0)) return true;
          const values = Array.isArray(filterValue) ? filterValue : [filterValue];
          const val = ((row.getValue(id) as string) || "").toLowerCase();
          return values.some((x) => val.includes(String(x).toLowerCase()));
        }
      },
      {
        id: "category",
        header: "",
        accessorFn: (row) => getType(row),
        cell: ({ getValue, row }) => {
          const type = getValue<string>();
          const body = (row.original.body && typeof row.original.body === "object" ? (row.original.body as Record<string, unknown>) : undefined) || {};
          const action = (body.action as string | undefined) || undefined;
          const label =
            type === "help_request" && action === "assigned"
              ? "assigned"
              : type === "help_request" && action === "status_changed"
              ? "state change"
              : type === "discussion_thread"
              ? "mention"
              : "author";
          return (
            <Badge variant="subtle" colorPalette="gray" size="sm">
              {label}
            </Badge>
          );
        },
        enableSorting: false
      },
      {
        id: "created_at",
        header: "",
        accessorKey: "created_at",
        enableSorting: true,
        cell: ({ getValue }) => {
          const v = getValue<string | null>();
          return <Text color="fg.muted">{v ? formatDistanceToNow(new Date(v), { addSuffix: true }) : ""}</Text>;
        }
      },
      {
        id: "row_actions",
        header: "",
        cell: ({ row }) => (
          <HStack gap={2} justifyContent="flex-end">
            {(isHelpRequest(row.original) || isHelpRequestMessage(row.original)) && (
              <Button size="xs" variant="ghost" colorPalette="blue" onClick={() => openHelpRequest(row.original)}>
                Open
              </Button>
            )}
            {!row.original.viewed_at && (
              <Button size="xs" variant="subtle" colorPalette="green" onClick={() => set_read(row.original, true)}>
                Mark read
              </Button>
            )}
            <IconButton size="xs" variant="ghost" colorPalette="red" aria-label="Dismiss" onClick={() => dismiss(row.original)}>
              <Icon as={FaTrash} />
            </IconButton>
          </HStack>
        ),
        enableSorting: false
      }
    ],
    [dismiss, set_read, getQueue, getWho, getAssignee, getStatus, getPreview, openHelpRequest]
  );

  const table = useReactTable({
    data,
    columns,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageIndex: 0, pageSize: 100 },
      sorting: [{ id: "created_at", desc: true }]
    }
  });

  const isLoading = notifications === undefined;

  const selectedRows = table.getSelectedRowModel().rows;
  const targetRows = selectedRows.length > 0 ? selectedRows : table.getFilteredRowModel().rows;

  async function markBatchAsRead() {
    try {
      await Promise.all(
        targetRows
          .map((r) => r.original)
          .filter((n) => !n.viewed_at)
          .map((n) => set_read(n, true))
      );
      setRowSelection({});
    } catch (e) {
      Sentry.captureException(e);
      toaster.error({ title: "Failed to mark as read", description: e instanceof Error ? e.message : String(e) });
    }
  }

  async function dismissBatch() {
    try {
      await Promise.all(targetRows.map((r) => dismiss(r.original)));
      setRowSelection({});
    } catch (e) {
      Sentry.captureException(e);
      toaster.error({ title: "Failed to dismiss", description: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <VStack w="100%" align="stretch" gap={4} p={4}>
      <HStack justify="space-between" align="center">
        <Text fontSize="lg" fontWeight="semibold">
          Notifications
        </Text>
        <HStack gap={2}>
          <Button size="sm" variant="subtle" colorPalette="green" onClick={markBatchAsRead} disabled={isLoading}>
            Mark {selectedRows.length > 0 ? "selected" : "all (filtered)"} as read
          </Button>
          <Button size="sm" variant="ghost" colorPalette="red" onClick={dismissBatch} disabled={isLoading}>
            Dismiss {selectedRows.length > 0 ? "selected" : "all (filtered)"}
          </Button>
        </HStack>
      </HStack>

      <Box overflowX="auto">
        <Table.Root minW="0" w="100%">
          <Table.Header>
            {table.getHeaderGroups().map((headerGroup) => (
              <Table.Row key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Table.ColumnHeader key={header.id} bg="bg.muted">
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

                        {header.id === "type" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              table
                                .getRowModel()
                                .rows.reduce((set, row) => set.add(getType(row.original)), new Set<string>())
                            )
                              .filter((v) => v)
                              .map((v) => ({ label: v, value: v }))}
                            placeholder="Filter by type..."
                          />
                        )}
                        {header.id === "display" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={["default", "modal", "banner"].map((v) => ({ label: v, value: v }))}
                            placeholder="Filter by display..."
                          />
                        )}
                        {header.id === "severity" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={["info", "success", "warning", "error"].map((v) => ({ label: v, value: v }))}
                            placeholder="Filter by severity..."
                          />
                        )}
                        {header.id === "read" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={[
                              { label: "Read", value: "Read" },
                              { label: "Unread", value: "Unread" }
                            ]}
                            placeholder="Filter by read status..."
                          />
                        )}
                        {header.id === "queue" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              table
                                .getRowModel()
                                .rows.reduce((set, row) => set.add(getQueue(row.original)), new Set<string>())
                            )
                              .filter((v) => v)
                              .map((v) => ({ label: v, value: v }))}
                            placeholder="Filter by queue..."
                          />
                        )}
                        {header.id === "who" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              table
                                .getRowModel()
                                .rows.reduce((set, row) => set.add(getWho(row.original)), new Set<string>())
                            )
                              .filter((v) => v)
                              .map((v) => ({ label: v, value: v }))}
                            placeholder="Filter by person..."
                          />
                        )}
                        {header.id === "assignee" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={[
                              ...Array.from(
                                table
                                  .getRowModel()
                                  .rows.reduce((set, row) => set.add(getAssignee(row.original) || ""), new Set<string>())
                              )
                                .filter((v) => v)
                                .map((v) => ({ label: v, value: v })),
                              { label: "Unassigned", value: "Unassigned" }
                            ]}
                            placeholder="Filter by assignee..."
                          />
                        )}
                        {header.id === "status" && (
                          <Select
                            isMulti
                            id={header.id}
                            onChange={(e) => {
                              const values = Array.isArray(e) ? e.map((item) => item.value) : [];
                              header.column.setFilterValue(values.length > 0 ? values : undefined);
                            }}
                            options={Array.from(
                              table
                                .getRowModel()
                                .rows.reduce((set, row) => set.add(getStatus(row.original)), new Set<string>())
                            )
                              .filter((v) => v)
                              .map((v) => ({ label: v, value: v }))}
                            placeholder="Filter by status..."
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
            {isLoading ? (
              <Table.Row>
                <Table.Cell colSpan={table.getAllLeafColumns().length} bg="bg.subtle">
                  <VStack w="100%" alignItems="center" justifyContent="center" h="100%" p={12}>
                    <Spinner size="lg" />
                    <Text>Loading...</Text>
                  </VStack>
                </Table.Cell>
              </Table.Row>
            ) : (
              table.getRowModel().rows.map((row, idx) => (
                <Table.Row key={row.id} bg={idx % 2 === 0 ? "bg.subtle" : undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <Table.Cell key={cell.id} p={2} verticalAlign="top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Box>

      <HStack>
        <Button onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
          {"<<"}
        </Button>
        <Button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
          {"<"}
        </Button>
        <Button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
          {">"}
        </Button>
        <Button onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()}>
          {">>"}
        </Button>
        <VStack>
          <Text>Page</Text>
          <Text>
            {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
          </Text>
        </VStack>
        <VStack>
          <Text>Show</Text>
          <select
            title="Select page size"
            value={"" + table.getState().pagination.pageSize}
            onChange={(event) => table.setPageSize(Number(event.target.value))}
          >
            {[25, 50, 100, 200, 500, 1000].map((pageSize) => (
              <option key={pageSize} value={pageSize}>
                Show {pageSize}
              </option>
            ))}
          </select>
        </VStack>
      </HStack>
    </VStack>
  );
}


