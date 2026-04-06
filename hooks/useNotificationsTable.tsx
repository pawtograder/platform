"use client";

import { useMemo } from "react";
import { createClient } from "@/utils/supabase/client";
import { useQuery } from "@tanstack/react-query";
import {
  ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable
} from "@tanstack/react-table";
import { Notification } from "@/utils/supabase/DatabaseTypes";

export interface NotificationsTableProps {
  onDelete?: (id: number) => void;
}

export function useNotificationsTable({ onDelete }: NotificationsTableProps = {}) {
  const supabase = useMemo(() => createClient(), []);

  const {
    data = [],
    isLoading,
    error
  } = useQuery({
    queryKey: ["notifications", "system"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("body->>type", "system")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Notification[];
    },
    staleTime: 30_000
  });

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

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
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
    data,
    isLoading,
    error
  };
}
