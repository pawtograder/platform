"use client";

import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Button, Dialog, HStack, Portal, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useEffect, useMemo, useState } from "react";

/** Shape returned by `gradebook_columns_auto_group_preview`. */
export type AutoGroupPlan = {
  groups: { name: string; column_ids: number[] }[];
  null_sort_order_column_ids: number[];
  changes: {
    column_id: number;
    slug: string;
    reason: "null-sort-order" | "membership" | "name";
    before: string | null;
    after: string | null;
    before_size: number;
    after_size: number;
  }[];
};

const REASON_LABEL: Record<AutoGroupPlan["changes"][number]["reason"], string> = {
  "null-sort-order": "had no position; moves to the end",
  membership: "joins a different set of columns",
  name: "header renamed"
};

/** "Quizzes (4)": the header and how many columns sit under it. */
function headerLabel(name: string | null, size: number) {
  return name == null ? "(no header)" : `${name} (${size})`;
}

/**
 * Shows what auto-grouping a gradebook would create, and every column whose header would differ
 * from what the gradebook shows today, before anything is written. `onConfirm` does the write
 * (auto-group, or enabling the course feature, which auto-groups on first use).
 */
export function AutoGroupPreviewDialog({
  open,
  gradebookId,
  title,
  confirmLabel,
  onConfirm,
  onClose,
  compareWithLegacy = true
}: {
  open: boolean;
  /** List columns whose header differs from the slug-guessed groups (true when the course still shows those). */
  compareWithLegacy?: boolean;
  gradebookId: number | null;
  title: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [plan, setPlan] = useState<AutoGroupPlan | null>(null);
  const [columnNames, setColumnNames] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open || gradebookId == null) return;
    let cancelled = false;
    setPlan(null);
    setError(null);
    (async () => {
      const [{ data, error: planError }, { data: cols }] = await Promise.all([
        supabase.rpc("gradebook_columns_auto_group_preview", { p_gradebook_id: gradebookId }),
        supabase.from("gradebook_columns").select("id, name").eq("gradebook_id", gradebookId)
      ]);
      if (cancelled) return;
      if (planError) {
        setError(planError.message);
        return;
      }
      setPlan(data as unknown as AutoGroupPlan);
      setColumnNames(new Map((cols ?? []).map((c) => [c.id, c.name])));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, gradebookId, supabase]);

  const confirm = async () => {
    setIsSaving(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toaster.error({ title: "Could not apply groups", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()} size="lg" lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {error && <Text color="fg.error">{error}</Text>}
              {!error && !plan && <Spinner />}
              {plan && (
                <VStack align="stretch" gap={4}>
                  {plan.groups.length === 0 ? (
                    <Text>
                      No columns would be grouped: no two adjacent ungrouped columns share a slug prefix. You can still
                      create groups yourself from a column&apos;s menu.
                    </Text>
                  ) : (
                    <Box>
                      <Text fontWeight="semibold" mb={2}>
                        {plan.groups.length} {plan.groups.length === 1 ? "group" : "groups"} will be created
                      </Text>
                      <VStack align="stretch" gap={1}>
                        {plan.groups.map((g) => (
                          <HStack key={g.name} align="baseline" gap={2}>
                            <Badge>{g.name}</Badge>
                            <Text fontSize="sm" color="fg.muted" truncate>
                              {g.column_ids.map((id) => columnNames.get(id) ?? `#${id}`).join(", ")}
                            </Text>
                          </HStack>
                        ))}
                      </VStack>
                    </Box>
                  )}
                  {!compareWithLegacy ? null : plan.changes.length > 0 ? (
                    <Box>
                      <Text fontWeight="semibold" mb={2}>
                        {plan.changes.length} {plan.changes.length === 1 ? "column looks" : "columns look"} different
                        from today
                      </Text>
                      <Table.Root size="sm">
                        <Table.Header>
                          <Table.Row>
                            <Table.ColumnHeader>Column</Table.ColumnHeader>
                            <Table.ColumnHeader>Currently</Table.ColumnHeader>
                            <Table.ColumnHeader>After</Table.ColumnHeader>
                            <Table.ColumnHeader>Why</Table.ColumnHeader>
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {plan.changes.map((c) => (
                            <Table.Row key={c.column_id}>
                              <Table.Cell>{columnNames.get(c.column_id) ?? c.slug}</Table.Cell>
                              <Table.Cell>{headerLabel(c.before, c.before_size)}</Table.Cell>
                              <Table.Cell>{headerLabel(c.after, c.after_size)}</Table.Cell>
                              <Table.Cell>{REASON_LABEL[c.reason]}</Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Root>
                    </Box>
                  ) : (
                    plan.groups.length > 0 && <Text>Every column keeps the header it has today.</Text>
                  )}
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button colorPalette="green" onClick={confirm} loading={isSaving} disabled={!plan}>
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
