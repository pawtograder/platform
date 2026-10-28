"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toaster } from "@/components/ui/toaster";
import { useGradebookController } from "@/hooks/useGradebook";
import { createClient } from "@/utils/supabase/client";
import type { GradebookTopic } from "@/utils/supabase/DatabaseTypes";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Spinner,
  Text,
  VStack
} from "@chakra-ui/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LuEllipsisVertical, LuPencil, LuTrash } from "react-icons/lu";

export type TopicsContextValue = {
  /** The course has the gradebook-topics feature on. */
  enabled: boolean;
  topics: GradebookTopic[];
};

export const TopicsContext = createContext<TopicsContextValue>({ enabled: false, topics: [] });

export function useTopicsContext() {
  return useContext(TopicsContext);
}

export const STANDING_RULE_LABEL: Record<string, string> = {
  best: "best attempt",
  latest: "latest attempt"
};

/** Topic RPC wrappers. Each refetches columns and topics so the table updates without waiting for realtime. */
export function useTopicActions() {
  const gradebookController = useGradebookController();
  const supabase = useMemo(() => createClient(), []);

  const refresh = useCallback(async () => {
    await Promise.all([
      gradebookController.gradebook_columns.refetchAll(),
      gradebookController.gradebook_topics.refetchAll()
    ]);
  }, [gradebookController]);

  const run = useCallback(
    async <T,>(label: string, op: () => PromiseLike<{ data: T | null; error: { message: string } | null }>) => {
      const { data, error } = await op();
      if (error) {
        toaster.error({ title: label, description: error.message });
        throw new Error(error.message);
      }
      await refresh();
      return data;
    },
    [refresh]
  );

  return useMemo(
    () => ({
      createTopic: (name: string) =>
        run("Failed to create the topic", () =>
          supabase.rpc("gradebook_topic_create", { p_gradebook_id: gradebookController.gradebook_id, p_name: name })
        ),
      setTopic: (columnId: number, topicId: number | null, attemptNumber: number | null) =>
        run("Failed to change the column's topic", () =>
          // NULL topic clears; NULL attempt number means "the next one". The generated types have no `| null` for RPC args.
          supabase.rpc("gradebook_columns_set_topic", {
            p_column_id: columnId,
            p_topic_id: topicId as number,
            p_attempt_number: attemptNumber as number
          })
        ),
      setStanding: (topicId: number, standingColumnId: number | null, rule: "best" | "latest" | null) =>
        run("Failed to set the topic's standing", () =>
          supabase.rpc("gradebook_topic_set_standing", {
            p_topic_id: topicId,
            p_standing_column_id: standingColumnId as number,
            p_rule: rule as string
          })
        ),
      renameTopic: (topicId: number, name: string) =>
        run("Failed to rename the topic", () => supabase.from("gradebook_topics").update({ name }).eq("id", topicId)),
      deleteTopic: (topicId: number) =>
        run("Failed to delete the topic", () => supabase.from("gradebook_topics").delete().eq("id", topicId))
    }),
    [run, supabase, gradebookController]
  );
}

/** Set a column's topic and attempt number from its header menu. */
export function ColumnTopicDialog({
  columnId,
  columnName,
  currentTopicId,
  currentAttempt,
  onClose
}: {
  columnId: number;
  columnName: string;
  currentTopicId: number | null;
  currentAttempt: number | null;
  onClose: () => void;
}) {
  const { topics } = useTopicsContext();
  const actions = useTopicActions();
  const [choice, setChoice] = useState<string>(currentTopicId == null ? "none" : String(currentTopicId));
  const [newName, setNewName] = useState("");
  const [attempt, setAttempt] = useState<string>(currentAttempt == null ? "" : String(currentAttempt));
  const [isSaving, setIsSaving] = useState(false);
  const sorted = useMemo(() => [...topics].sort((a, b) => a.name.localeCompare(b.name)), [topics]);

  const save = async () => {
    setIsSaving(true);
    try {
      const attemptNumber = attempt.trim() === "" ? null : Number(attempt);
      if (choice === "none") {
        if (currentTopicId != null) await actions.setTopic(columnId, null, null);
      } else {
        const topicId = choice === "new" ? await actions.createTopic(newName.trim()) : Number(choice);
        if (topicId != null) await actions.setTopic(columnId, topicId, attemptNumber);
      }
      onClose();
    } catch {
      // toasted by the action (a duplicate attempt number is the usual cause)
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(d) => !d.open && onClose()} size="sm" placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Topic for &ldquo;{columnName}&rdquo;</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <NativeSelect.Root>
                  <NativeSelect.Field aria-label="Topic" value={choice} onChange={(e) => setChoice(e.target.value)}>
                    <option value="none">Not an attempt at a topic</option>
                    {sorted.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    <option value="new">New topic…</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
                {choice === "new" && (
                  <Input
                    aria-label="New topic name"
                    placeholder="Topic name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                )}
                {choice !== "none" && (
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      Attempt number
                    </Text>
                    <Input
                      aria-label="Attempt number"
                      type="number"
                      min={1}
                      placeholder="Next attempt"
                      value={attempt}
                      onChange={(e) => setAttempt(e.target.value)}
                    />
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                colorPalette="green"
                onClick={save}
                loading={isSaving}
                disabled={choice === "new" && newName.trim() === ""}
              >
                Save
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Menu on a topic's header: standing rule, rename, delete. */
export function TopicHeaderMenu({ topic }: { topic: GradebookTopic }) {
  const actions = useTopicActions();
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState(topic.name);
  const setRule = (rule: "best" | "latest" | null) =>
    actions.setStanding(topic.id, topic.standing_column_id, rule).catch(() => {});

  return (
    <Box onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <MenuRoot>
        <MenuTrigger asChild>
          <IconButton variant="ghost" size="2xs" aria-label={`Topic options for ${topic.name}`}>
            <LuEllipsisVertical />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          <MenuItem value="best" onClick={() => setRule("best")} disabled={topic.standing_rule === "best"}>
            Standing: best attempt
          </MenuItem>
          <MenuItem value="latest" onClick={() => setRule("latest")} disabled={topic.standing_rule === "latest"}>
            Standing: latest attempt
          </MenuItem>
          {topic.standing_column_id != null && (
            <MenuItem value="custom" onClick={() => setRule(null)} disabled={topic.standing_rule == null}>
              Standing: keep the column&apos;s own expression
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem value="rename" onClick={() => setIsRenaming(true)}>
            <LuPencil /> Rename topic
          </MenuItem>
          <MenuItem value="delete" color="fg.error" onClick={() => actions.deleteTopic(topic.id).catch(() => {})}>
            <LuTrash /> Delete topic (columns stay)
          </MenuItem>
        </MenuContent>
      </MenuRoot>
      {isRenaming && (
        <Dialog.Root open onOpenChange={(d) => !d.open && setIsRenaming(false)} size="sm" placement="center">
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <Dialog.Content>
                <Dialog.Header>
                  <Dialog.Title>Rename topic</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <Input aria-label="Topic name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Dialog.Body>
                <Dialog.Footer>
                  <Button variant="outline" onClick={() => setIsRenaming(false)}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette="green"
                    disabled={name.trim() === "" || name.trim() === topic.name}
                    onClick={() =>
                      actions
                        .renameTopic(topic.id, name.trim())
                        .then(() => setIsRenaming(false))
                        .catch(() => {})
                    }
                  >
                    Rename
                  </Button>
                </Dialog.Footer>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
    </Box>
  );
}

type Suggestion = {
  topics: {
    name: string;
    standing_column_id: number | null;
    attempts: { column_id: number; attempt_number: number; source: "name" | "order" | "orphan-name" }[];
  }[];
  conflicts: { topic: string; attempt_number: number; column_ids: number[] }[];
};

const SOURCE_LABEL: Record<Suggestion["topics"][number]["attempts"][number]["source"], string> = {
  name: "from its name",
  order: "from its position",
  "orphan-name": "not read by the standing; matched by name"
};

/**
 * Proposes topics from the gradebook's existing columns and creates only what the instructor
 * keeps checked. Duplicate attempt numbers are shown, and Apply stays disabled until each one is
 * resolved by unchecking a column.
 */
export function SuggestTopicsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const gradebookController = useGradebookController();
  const supabase = useMemo(() => createClient(), []);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excludedTopics, setExcludedTopics] = useState<Set<number>>(new Set());
  const [excludedColumns, setExcludedColumns] = useState<Set<number>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const columnName = useCallback(
    (id: number) => gradebookController.gradebook_columns.rows.find((c) => c.id === id)?.name ?? `#${id}`,
    [gradebookController]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSuggestion(null);
    setError(null);
    setExcludedTopics(new Set());
    setExcludedColumns(new Set());
    supabase
      .rpc("gradebook_topics_suggest", { p_gradebook_id: gradebookController.gradebook_id })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else setSuggestion(data as unknown as Suggestion);
      });
    return () => {
      cancelled = true;
    };
  }, [open, supabase, gradebookController]);

  const kept = useMemo<Suggestion["topics"]>(() => {
    if (!suggestion) return [];
    return suggestion.topics
      .filter((_, i) => !excludedTopics.has(i))
      .map((t) => ({ ...t, attempts: t.attempts.filter((a) => !excludedColumns.has(a.column_id)) }));
  }, [suggestion, excludedTopics, excludedColumns]);

  const remainingConflicts = useMemo(() => {
    const out: string[] = [];
    for (const t of kept) {
      const seen = new Map<number, number>();
      for (const a of t.attempts) seen.set(a.attempt_number, (seen.get(a.attempt_number) ?? 0) + 1);
      for (const [n, count] of seen) if (count > 1) out.push(`${t.name}: attempt ${n}`);
    }
    return out;
  }, [kept]);

  const conflictColumns = useMemo(
    () => new Set((suggestion?.conflicts ?? []).flatMap((c) => c.column_ids)),
    [suggestion]
  );

  const toggle = (set: Set<number>, value: number, update: (s: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };

  const apply = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase.rpc("gradebook_topics_apply_suggestion", {
        p_gradebook_id: gradebookController.gradebook_id,
        p_suggestion: { topics: kept.filter((t) => t.attempts.length > 0) }
      });
      if (error) throw new Error(error.message);
      await Promise.all([
        gradebookController.gradebook_columns.refetchAll(),
        gradebookController.gradebook_topics.refetchAll()
      ]);
      toaster.success({ title: "Topics created" });
      onClose();
    } catch (e) {
      toaster.error({ title: "Could not create topics", description: e instanceof Error ? e.message : String(e) });
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
              <Dialog.Title>Suggest topics</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body maxH="70vh" overflowY="auto">
              {error && <Text color="fg.error">{error}</Text>}
              {!error && !suggestion && <Spinner />}
              {suggestion && suggestion.topics.length === 0 && (
                <Text>
                  No topics found. A topic is proposed when a computed column reads only manual columns that nothing
                  else reads, such as a &ldquo;Topic Max Score&rdquo; column over its attempts.
                </Text>
              )}
              {suggestion && suggestion.topics.length > 0 && (
                <VStack align="stretch" gap={4}>
                  <Text fontSize="sm" color="fg.muted">
                    Each topic keeps its standing column&apos;s current expression, so no grade changes. You can switch
                    a topic to a generated &ldquo;best&rdquo; or &ldquo;latest&rdquo; standing afterwards.
                  </Text>
                  {suggestion.topics.map((t, i) => (
                    <Box key={`${t.name}-${i}`} borderWidth="1px" borderRadius="md" p={3}>
                      <Checkbox
                        checked={!excludedTopics.has(i)}
                        onCheckedChange={() => toggle(excludedTopics, i, setExcludedTopics)}
                      >
                        <Text fontWeight="semibold">{t.name}</Text>
                      </Checkbox>
                      {t.standing_column_id != null && (
                        <Text fontSize="sm" color="fg.muted" ml={7}>
                          Standing: {columnName(t.standing_column_id)}
                        </Text>
                      )}
                      <VStack align="stretch" gap={1} ml={7} mt={2}>
                        {t.attempts.map((a) => (
                          <HStack key={a.column_id} gap={2}>
                            <Checkbox
                              size="sm"
                              checked={!excludedTopics.has(i) && !excludedColumns.has(a.column_id)}
                              disabled={excludedTopics.has(i)}
                              onCheckedChange={() => toggle(excludedColumns, a.column_id, setExcludedColumns)}
                            >
                              <Text fontSize="sm">
                                Attempt {a.attempt_number}: {columnName(a.column_id)}
                              </Text>
                            </Checkbox>
                            {a.source !== "name" && (
                              <Text fontSize="xs" color="fg.muted">
                                ({SOURCE_LABEL[a.source]})
                              </Text>
                            )}
                            {conflictColumns.has(a.column_id) && <Badge colorPalette="red">duplicate attempt</Badge>}
                          </HStack>
                        ))}
                      </VStack>
                    </Box>
                  ))}
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              {remainingConflicts.length > 0 && (
                <Text fontSize="sm" color="fg.error" mr="auto">
                  Uncheck one column for: {remainingConflicts.join("; ")}
                </Text>
              )}
              <Button variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button
                colorPalette="green"
                onClick={apply}
                loading={isSaving}
                disabled={!suggestion || kept.length === 0 || remainingConflicts.length > 0}
              >
                Create topics
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
