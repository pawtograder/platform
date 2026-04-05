/**
 * Mock implementation of PawtograderRealTimeController for unit tests.
 * Captures subscribeToTable callbacks so tests can fire synthetic broadcast events.
 */

import { PawtograderRealTimeController, ConnectionStatus } from "@/lib/PawtograderRealTimeController";
import { BroadcastMessage } from "@/lib/TableController";

export class MockClassRealTimeController implements PawtograderRealTimeController {
  /** Map from table name to the set of active callbacks. */
  private tableCallbacks = new Map<string, Set<(message: BroadcastMessage) => void>>();

  /** Callbacks listening for connection status changes. */
  private statusCallbacks = new Set<(status: ConnectionStatus) => void>();

  subscribeToTable(table: string, callback: (message: BroadcastMessage) => void): () => void {
    if (!this.tableCallbacks.has(table)) {
      this.tableCallbacks.set(table, new Set());
    }
    this.tableCallbacks.get(table)!.add(callback);

    return () => {
      this.tableCallbacks.get(table)?.delete(callback);
    };
  }

  subscribeToStatus(callback: (status: ConnectionStatus) => void): () => void {
    this.statusCallbacks.add(callback);
    return () => {
      this.statusCallbacks.delete(callback);
    };
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      overall: "connected",
      channels: [],
      lastUpdate: new Date()
    };
  }

  // ---- Test helpers ----

  /** Fire a synthetic broadcast to all subscribers of the given table. */
  simulateBroadcast(table: string, message: BroadcastMessage): void {
    const callbacks = this.tableCallbacks.get(table);
    if (callbacks) {
      for (const cb of callbacks) {
        cb(message);
      }
    }
  }

  /** Return the set of table names that currently have active subscriptions. */
  getActiveSubscriptions(): string[] {
    return Array.from(this.tableCallbacks.entries())
      .filter(([, cbs]) => cbs.size > 0)
      .map(([table]) => table);
  }

  /** Return the number of active callbacks for a given table. */
  getSubscriberCount(table: string): number {
    return this.tableCallbacks.get(table)?.size ?? 0;
  }
}
