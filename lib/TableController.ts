import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { UnstableGetResult as GetResult, PostgrestFilterBuilder } from "@supabase/postgrest-js";
import { ClassRealTimeController } from "./ClassRealTimeController";

type DatabaseTableTypes = Database["public"]["Tables"];
type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

type ExtractIdType<T extends TablesThatHaveAnIDField> = DatabaseTableTypes[T]["Row"]["id"];

export type PossiblyTentativeResult<T> = T & {
  __db_pending?: boolean;
};

type BroadcastMessage = {
  type: "table_change" | "channel_created" | "system";
  operation?: "INSERT" | "UPDATE" | "DELETE";
  table?: TablesThatHaveAnIDField;
  row_id?: number | string;
  data?: Record<string, unknown>;
  submission_id?: number;
  class_id: number;
  target_audience?: "user" | "staff";
  timestamp: string;
};
export default class TableController<
  RelationName extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = ExtractIdType<RelationName>,
  ResultOne = GetResult<
    Database["public"],
    Database["public"]["Tables"][RelationName]["Row"],
    RelationName,
    Database["public"]["Tables"][RelationName]["Relationships"],
    Query
  >
> {
  private _rows: PossiblyTentativeResult<ResultOne>[] = [];
  private _client: SupabaseClient;
  private _query: PostgrestFilterBuilder<
    Database["public"],
    Database["public"]["Tables"][RelationName]["Row"],
    ResultOne[],
    RelationName,
    Database["public"]["Tables"][RelationName]["Relationships"]
  >;
  private _ready: boolean = false;
  private _readyPromise: Promise<void>;
  private _table: RelationName;
  private _temporaryIdCounter: number = -1;
  private _classRealTimeController: ClassRealTimeController | null = null;
  private _realtimeUnsubscribe: (() => void) | null = null;
  private _submissionId: number | null = null;

  private _listDataListeners: ((
    data: ResultOne[],
    { entered, left }: { entered: ResultOne[]; left: ResultOne[] }
  ) => void)[] = [];
  private _itemDataListeners: Map<IDType, ((data: PossiblyTentativeResult<ResultOne> | undefined) => void)[]> =
    new Map();

  get ready() {
    return this._ready;
  }
  get readyPromise() {
    return this._readyPromise;
  }

  async _fetchRow(id: IDType): Promise<ResultOne | undefined> {
    const { data, error } = await this._client.from(this._table).select("*").eq("id", id);
    if (error) {
      throw error;
    }
    if (!data || data.length === 0) {
      return undefined;
    }
    return data[0];
  }
  constructor({
    query,
    client,
    table,
    classRealTimeController,
    submissionId
  }: {
    query: PostgrestFilterBuilder<
      Database["public"],
      Database["public"]["Tables"][RelationName]["Row"],
      ResultOne[],
      RelationName,
      Database["public"]["Tables"][RelationName]["Relationships"]
    >;
    client: SupabaseClient<Database>;
    table: RelationName;
    classRealTimeController?: ClassRealTimeController;
    submissionId?: number;
  }) {
    this._rows = [];
    this._client = client;
    this._query = query;
    this._table = table;
    this._classRealTimeController = classRealTimeController || null;
    this._submissionId = submissionId || null;
    this._readyPromise = new Promise(async (resolve, reject) => {
      try {
        let page = 0;
        const pageSize = 1000;
        let nRows: number | undefined;

        // Set up realtime subscription if controller is provided
        if (this._classRealTimeController) {
          const messageHandler = (message: BroadcastMessage) => {
            console.log("Received broadcast message", JSON.stringify(message, null, 2));

            // Filter by table name
            if (message.table !== table) {
              return;
            }

            // Handle different message types
            switch (message.operation) {
              case "INSERT":
                this._handleInsert(message);
                break;
              case "UPDATE":
                this._handleUpdate(message);
                break;
              case "DELETE":
                this._handleDelete(message);
                break;
            }
          };

          // Subscribe to messages for this table, optionally filtered by submission
          if (this._submissionId) {
            this._realtimeUnsubscribe = this._classRealTimeController.subscribeToTableForSubmission(
              table,
              this._submissionId,
              messageHandler
            );
          } else {
            this._realtimeUnsubscribe = this._classRealTimeController.subscribeToTable(table, messageHandler);
          }
        }
        //Load initial data, do all of the pages.
        while (page * pageSize < (nRows ?? 1000)) {
          const { data, error } = await this._query.range(page * pageSize, (page + 1) * pageSize);
          if (error) {
            reject(error);
          }
          if (!data) {
            break;
          }
          this._rows = [
            ...this._rows,
            ...data.map((row) => ({
              ...row,
              __db_pending: false
            }))
          ];
          if (data.length < pageSize) {
            break;
          }
          page++;
        }
        this._ready = true;
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  close() {
    if (this._realtimeUnsubscribe) {
      console.log("Unsubscribing from realtime messages");
      this._realtimeUnsubscribe();
    }
  }

  private _handleInsert(message: BroadcastMessage) {
    if (message.data) {
      // Handle full data broadcasts
      const data = message.data as Record<string, unknown>;
      if (!this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id)) {
        this._addRow({
          ...data,
          __db_pending: false
        } as PossiblyTentativeResult<ResultOne>);
      }
    } else if (message.row_id) {
      // Handle ID-only broadcasts - fetch the data
      if (!this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id)) {
        this._fetchRow(message.row_id as IDType).then((row) => {
          if (!row) {
            return;
          }
          // One last check to see if we already have it
          if (this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id)) {
            return;
          }
          this._addRow({
            ...row,
            __db_pending: false
          });
        });
      }
    }
  }

  private _handleUpdate(message: BroadcastMessage) {
    if (message.data) {
      // Handle full data broadcasts
      const data = message.data as Record<string, unknown>;
      const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id);
      if (existingRow) {
        this._updateRow(data.id as IDType, { ...data, id: data.id } as ResultOne & { id: IDType }, false);
      } else {
        this._addRow({
          ...data,
          __db_pending: false
        } as PossiblyTentativeResult<ResultOne>);
      }
    } else if (message.row_id) {
      // Handle ID-only broadcasts - fetch the data
      this._fetchRow(message.row_id as IDType).then((row) => {
        if (!row) {
          return;
        }
        const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id);
        if (existingRow) {
          this._updateRow(message.row_id as IDType, row as ResultOne & { id: IDType }, false);
        } else {
          this._addRow({
            ...row,
            __db_pending: false
          });
        }
      });
    }
  }

  private _handleDelete(message: BroadcastMessage) {
    if (message.data) {
      const data = message.data as Record<string, unknown>;
      this._removeRow(data.id as IDType);
    } else if (message.row_id) {
      this._removeRow(message.row_id as IDType);
    }
  }

  getById(id: IDType, listener?: (data: PossiblyTentativeResult<ResultOne> | undefined) => void) {
    if (!listener) {
      return {
        data: this._rows.find(
          (row) => (row as ResultOne & { id: ExtractIdType<RelationName> }).id === id
        ) as PossiblyTentativeResult<ResultOne>,
        unsubscribe: () => {}
      };
    }
    this._itemDataListeners.set(id, [...(this._itemDataListeners.get(id) || []), listener]);
    return {
      data: this._rows.find(
        (row) => (row as ResultOne & { id: ExtractIdType<RelationName> }).id === id
      ) as PossiblyTentativeResult<ResultOne>,
      unsubscribe: () => {
        const listeners = this._itemDataListeners.get(id);
        if (listeners) {
          this._itemDataListeners.set(
            id,
            listeners.filter((l) => l !== listener)
          );
        }
      }
    };
  }

  list(listener?: (data: ResultOne[], { entered, left }: { entered: ResultOne[]; left: ResultOne[] }) => void) {
    if (!listener) {
      return {
        data: this._rows,
        unsubscribe: () => {}
      };
    }
    this._listDataListeners.push(listener);
    return {
      data: this._rows,
      unsubscribe: () => {
        this._listDataListeners = this._listDataListeners.filter((l) => l !== listener);
      }
    };
  }

  private _addRow(row: PossiblyTentativeResult<ResultOne>) {
    this._rows = [...this._rows, row];

    this._listDataListeners.forEach((listener) => listener(this._rows, { entered: [row], left: [] }));
    if ("id" in row) {
      //Should always be true, fix up types later...
      const listeners = this._itemDataListeners.get(row.id as IDType);
      if (listeners) {
        listeners.forEach((listener) => listener(row));
      }
    }
  }

  private _updateRow(id: IDType, newRow: ResultOne & { id: IDType }, is_pending: boolean = false) {
    const index = this._rows.findIndex((r) => (r as ResultOne & { id: IDType }).id === id);
    if (index === -1) {
      throw new Error("Row not found");
    }
    const oldRow = this._rows[index];
    this._rows[index] = {
      ...this._rows[index],
      ...newRow,
      __db_pending: is_pending
    };
    const listeners = this._itemDataListeners.get(id as IDType);
    if (listeners) {
      listeners.forEach((listener) => listener(this._rows[index]));
    }
    if (typeof newRow === "object" && "deleted_at" in newRow) {
      if (newRow.deleted_at && (!("deleted_at" in oldRow) || oldRow.deleted_at === null)) {
        this._listDataListeners.forEach((listener) => listener(this._rows, { entered: [], left: [] }));
      }
    }
  }

  private _removeRow(id: IDType) {
    const rowToRemove = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    if (!rowToRemove) {
      return;
    }
    this._rows = this._rows.filter((r) => (r as ResultOne & { id: IDType }).id !== id);
    this._listDataListeners.forEach((listener) =>
      listener(this._rows, { entered: [], left: [rowToRemove as ResultOne] })
    );
    const listeners = this._itemDataListeners.get(id);
    if (listeners) {
      listeners.forEach((listener) => listener(undefined));
    }
  }

  async create(
    row: Omit<ResultOne, "id" | "created_at" | "updated_at" | "deleted_at" | "edited_at" | "edited_by">
  ): Promise<ResultOne> {
    const newRow = {
      ...(row as ResultOne),
      created_at: new Date(),
      id: this._temporaryIdCounter--
    };
    const tentativeRow = {
      ...newRow,
      __db_pending: true
    };
    this._addRow(tentativeRow);
    const { data, error } = await this._client.from(this._table).insert(row).select("*").single();
    if (error) {
      this._rows = this._rows.filter((r) => r !== tentativeRow);
      this._removeRow(newRow.id as IDType);
      throw error;
    }
    tentativeRow.id = data.id;
    this._updateRow(data.id, data, false);
    return data;
  }

  async delete(id: ExtractIdType<RelationName>): Promise<void> {
    const existingRow = this._rows.find((r) => (r as ResultOne & { id: ExtractIdType<RelationName> }).id === id);
    if (!existingRow) {
      throw new Error("Row not found");
    }
    if (existingRow.__db_pending) {
      throw new Error("Row is pending");
    }
    this._removeRow(id as IDType);
    const { error } = await this._client
      .from(this._table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      this._addRow({ ...existingRow, __db_pending: false } as PossiblyTentativeResult<ResultOne>);
      throw error;
    }
    return;
  }
  async update(id: IDType, row: Partial<ResultOne>): Promise<ResultOne> {
    const oldRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    if (!oldRow) {
      throw new Error("Row not found");
    }
    this._updateRow(id, { ...oldRow, ...row, id, __db_pending: true }, true);
    const { data, error } = await this._client.from(this._table).update(row).eq("id", id).select("*").single();
    if (error) {
      this._updateRow(id, oldRow as ResultOne & { id: IDType }, false);
      throw error;
    }
    this._updateRow(id, data, false);
    return data;
  }

  get rows() {
    return this._rows;
  }

  get rowCount() {
    return this._rows.length;
  }
}
