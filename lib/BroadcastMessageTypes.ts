/**
 * Shared broadcast message types used by the cross-tab infrastructure
 * and realtime controllers.
 *
 * Extracted from TableController.ts so that the cross-tab modules
 * (createRealtimeBatchHandler, useRealtimeBridge) don't depend on
 * the full TableController module.
 */

import type { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import type { OfficeHoursBroadcastMessage } from "@/utils/supabase/DatabaseTypes";

type DatabaseTableTypes = Database["public"]["Tables"];

export type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

export type GradebookRowRecalcStateBroadcastMessage = {
  type: "gradebook_row_recalc_state";
  operation: "INSERT" | "UPDATE" | "DELETE";
  table: "gradebook_row_recalc_state";
  class_id: number;
  row_id: null;
  data: null;
  timestamp: string;
  affected_count: number;
  affected_rows: Array<{
    student_id: string;
    dirty: boolean;
    is_recalculating: boolean;
  }>; // Array of affected rows with their state (only private rows included)
  requires_refetch: false; // Always false since we include the data
};

export type BroadcastMessage =
  | {
      type: "table_change" | "channel_created" | "system" | "staff_data_change";
      operation?: "INSERT" | "UPDATE" | "DELETE" | "BULK_UPDATE";
      table?: TablesThatHaveAnIDField | "gradebook_row_recalc_state"; // Include gradebook_row_recalc_state which doesn't have an id field
      row_id?: number | string;
      row_ids?: (number | string)[]; // Array of IDs for bulk operations
      data?: Record<string, unknown>;
      submission_id?: number;
      help_request_id?: number;
      help_queue_id?: number;
      class_id: number;
      student_profile_id?: number;
      target_audience?: "user" | "staff";
      timestamp: string;
      affected_count?: number; // Number of rows affected in bulk operation
      requires_refetch?: boolean; // If true, trigger full refetch instead of refetching by IDs
    }
  | GradebookRowRecalcStateBroadcastMessage
  | OfficeHoursBroadcastMessage;
