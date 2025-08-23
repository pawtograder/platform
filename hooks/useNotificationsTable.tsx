"use client";

import { useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
import TableController from "@/lib/TableController";
import { useTableControllerTable } from "./useTableControllerTable";
import { ColumnDef } from "@tanstack/react-table";
import { Notification } from "@/utils/supabase/DatabaseTypes";

export function useNotificationsTableController() {
  const supabase = createClient();

  return useMemo(() => {
    const query = supabase
      .from("notifications")
      .select("*")
      .eq("body->>type", "system")
      .order("created_at", { ascending: false });

    return new TableController({
      query,
      client: supabase,
      table: "notifications"
    });
  }, [supabase]);
}

export interface NotificationsTableProps {
  onDelete?: (id: number) => void;
}

export function useNotificationsTable({ onDelete }: NotificationsTableProps = {}) {
  const tableController = useNotificationsTableController();

  const columns = useMemo<ColumnDef<Notification>[]>(
    () => [
      {
        id: "notification",
        header: "Notification",
        cell: ({ row }) => row.original,
        enableSorting: false
      },
      {
        id: "created_at",
        header: "Created",
        accessorKey: "created_at",
        enableSorting: true
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => ({
          notification: row.original,
          onDelete
        }),
        enableSorting: false
      }
    ],
    [onDelete]
  );

  const table = useTableControllerTable({
    columns,
    tableController,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 20
      },
      sorting: [
        {
          id: "created_at",
          desc: true
        }
      ]
    }
  });

  return {
    ...table,
    controller: tableController
  };
}
