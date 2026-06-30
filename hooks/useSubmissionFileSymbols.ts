"use client";

import { createClient } from "@/utils/supabase/client";
import type { CodeSymbol } from "@/supabase/functions/_shared/CodeSymbolParser";
import { useEffect, useState } from "react";

export type SubmissionFileSymbols = {
  /** submission_file_id -> parsed symbols for that file. */
  symbolsByFileId: Map<number, CodeSymbol[]>;
  /** Set of submission_file_ids that have an index row (i.e. have been indexed). */
  indexedFileIds: Set<number>;
  isLoading: boolean;
};

const EMPTY: SubmissionFileSymbols = {
  symbolsByFileId: new Map(),
  indexedFileIds: new Set(),
  isLoading: true
};

/**
 * Loads the server-side code-symbol index for a submission (one row per file in
 * `submission_file_symbol_index`). The index is static after ingestion, so this fetches once.
 * Files without a row are simply absent from `indexedFileIds`, which the editor uses to show a
 * graceful "not yet indexed" message instead of attempting go-to-definition.
 */
export function useSubmissionFileSymbols(submissionId: number | undefined): SubmissionFileSymbols {
  const [state, setState] = useState<SubmissionFileSymbols>(EMPTY);

  useEffect(() => {
    // Guard against a stale fetch: a slow request for a previous submissionId must not
    // resolve after a newer one and clobber state with the wrong submission's symbols.
    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true }));
    void (async () => {
      if (submissionId === undefined) {
        if (!cancelled) setState({ symbolsByFileId: new Map(), indexedFileIds: new Set(), isLoading: false });
        return;
      }
      const supabase = createClient();
      const { data, error } = await supabase
        .from("submission_file_symbol_index")
        .select("submission_file_id, symbols")
        .eq("submission_id", submissionId);

      const symbolsByFileId = new Map<number, CodeSymbol[]>();
      const indexedFileIds = new Set<number>();
      if (!error && data) {
        for (const row of data) {
          const symbols = (row.symbols as CodeSymbol[] | null) ?? [];
          symbolsByFileId.set(row.submission_file_id, symbols);
          indexedFileIds.add(row.submission_file_id);
        }
      }
      if (!cancelled) setState({ symbolsByFileId, indexedFileIds, isLoading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  return state;
}
