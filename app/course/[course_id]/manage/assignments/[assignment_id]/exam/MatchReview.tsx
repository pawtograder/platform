"use client";

import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Button, Flex, Heading, HStack, NativeSelect, Table, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";

type Scanned = {
  id: number;
  exam_index: number;
  detected_name: string | null;
  detected_sis_id: string | null;
  matched_profile_id: string | null;
  match_confidence: number | null;
  match_status: string;
  submission_id: number | null;
};
type RosterStudent = { profile_id: string; name: string | null };

export default function MatchReview({ batchId, classId }: { batchId: number; classId: number }) {
  const [rows, setRows] = useState<Scanned[]>([]);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: scanned }, { data: students }] = await Promise.all([
      supabase
        .from("exam_scanned_submissions")
        .select(
          "id, exam_index, detected_name, detected_sis_id, matched_profile_id, match_confidence, match_status, submission_id"
        )
        .eq("batch_id", batchId)
        .order("exam_index"),
      supabase
        .from("user_roles")
        .select("private_profile_id, profiles!user_roles_private_profile_id_fkey(name)")
        .eq("class_id", classId)
        .eq("role", "student")
    ]);
    setRows((scanned ?? []) as Scanned[]);
    setRoster(
      (students ?? [])
        .filter((s) => s.private_profile_id)
        .map((s) => ({
          profile_id: s.private_profile_id as string,
          name: (s.profiles as unknown as { name: string | null } | null)?.name ?? null
        }))
    );
  }, [batchId, classId]);

  useEffect(() => {
    load();
  }, [load]);

  const setMatch = useCallback(
    async (id: number, profileId: string | null) => {
      const supabase = createClient();
      await supabase
        .from("exam_scanned_submissions")
        .update({
          matched_profile_id: profileId,
          match_status: profileId ? "confirmed" : "unmatched"
        })
        .eq("id", id);
      await load();
    },
    [load]
  );

  const confirm = useCallback(
    async (id: number) => {
      const row = rows.find((r) => r.id === id);
      if (!row?.matched_profile_id) {
        toaster.error({ title: "Pick a student first" });
        return;
      }
      const supabase = createClient();
      await supabase.from("exam_scanned_submissions").update({ match_status: "confirmed" }).eq("id", id);
      await load();
    },
    [rows, load]
  );

  const skip = useCallback(
    async (id: number) => {
      const supabase = createClient();
      await supabase.from("exam_scanned_submissions").update({ match_status: "skipped" }).eq("id", id);
      await load();
    },
    [load]
  );

  const createSubmissions = useCallback(async () => {
    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
      if (error) throw error;
      toaster.success({ title: `Queued ${data ?? 0} submission(s) for creation` });
    } catch (e) {
      toaster.error({ title: "Finalize failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [batchId]);

  const confirmedCount = rows.filter((r) => r.match_status === "confirmed" && !r.submission_id).length;

  return (
    <VStack align="stretch" gap={3}>
      <HStack justify="space-between">
        <Heading size="sm">Review matches ({rows.length} exams)</Heading>
        <Button
          size="sm"
          colorPalette="green"
          onClick={createSubmissions}
          loading={busy}
          disabled={confirmedCount === 0}
        >
          Create {confirmedCount} submission(s)
        </Button>
      </HStack>
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Exam</Table.ColumnHeader>
            <Table.ColumnHeader>Detected</Table.ColumnHeader>
            <Table.ColumnHeader>Match</Table.ColumnHeader>
            <Table.ColumnHeader>Student</Table.ColumnHeader>
            <Table.ColumnHeader>Actions</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>#{r.exam_index + 1}</Table.Cell>
              <Table.Cell>
                <Text fontSize="xs">{r.detected_name ?? "—"}</Text>
                <Text fontSize="xs" color="fg.muted">
                  SIS: {r.detected_sis_id ?? "—"}
                </Text>
              </Table.Cell>
              <Table.Cell>
                {r.submission_id ? (
                  <Badge colorPalette="blue">created</Badge>
                ) : r.match_status === "confirmed" ? (
                  <Badge colorPalette="green">confirmed</Badge>
                ) : r.match_status === "suggested" ? (
                  <Badge colorPalette="yellow">
                    suggested {r.match_confidence != null ? `(${Math.round(r.match_confidence * 100)}%)` : ""}
                  </Badge>
                ) : r.match_status === "skipped" ? (
                  <Badge>skipped</Badge>
                ) : (
                  <Badge colorPalette="red">unmatched</Badge>
                )}
              </Table.Cell>
              <Table.Cell>
                <NativeSelect.Root size="xs" width="200px" disabled={!!r.submission_id}>
                  <NativeSelect.Field
                    value={r.matched_profile_id ?? ""}
                    onChange={(e) => setMatch(r.id, e.target.value || null)}
                  >
                    <option value="">— none —</option>
                    {roster.map((s) => (
                      <option key={s.profile_id} value={s.profile_id}>
                        {s.name ?? s.profile_id}
                      </option>
                    ))}
                  </NativeSelect.Field>
                </NativeSelect.Root>
              </Table.Cell>
              <Table.Cell>
                <HStack gap={1}>
                  <Button size="xs" variant="outline" onClick={() => confirm(r.id)} disabled={!!r.submission_id}>
                    Confirm
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => skip(r.id)} disabled={!!r.submission_id}>
                    Skip
                  </Button>
                </HStack>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Flex>
        <Button size="xs" variant="ghost" onClick={load}>
          Refresh
        </Button>
      </Flex>
    </VStack>
  );
}
