"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Card, Flex, Heading, HStack, Table, Text, VStack } from "@chakra-ui/react";
import { RefreshCw, Upload } from "lucide-react";

interface ContextLink {
  id: number;
  context_id: string;
  context_label: string | null;
  context_title: string | null;
  nrps_url: string | null;
  ags_lineitems_url: string | null;
  roster_sync_enabled: boolean;
  grade_sync_enabled: boolean;
  last_roster_sync_at: string | null;
  last_roster_sync_status: string | null;
  last_roster_sync_message: string | null;
}

interface AssignmentRow {
  id: number;
  title: string;
  gradebook_column_id: number | null;
}

export default function CourseLtiPage() {
  const params = useParams();
  const courseId = Number(params.course_id);
  const [links, setLinks] = useState<ContextLink[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pushingId, setPushingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    setLoading(true);
    try {
      const [{ data: linkData, error: linkErr }, { data: asgData, error: asgErr }] = await Promise.all([
        supabase
          .from("lti_context_links")
          .select(
            "id, context_id, context_label, context_title, nrps_url, ags_lineitems_url, roster_sync_enabled, grade_sync_enabled, last_roster_sync_at, last_roster_sync_status, last_roster_sync_message"
          )
          .eq("class_id", courseId),
        supabase.from("assignments").select("id, title, gradebook_column_id").eq("class_id", courseId).order("due_date")
      ]);
      if (linkErr) throw linkErr;
      if (asgErr) throw asgErr;
      setLinks((linkData as ContextLink[]) ?? []);
      setAssignments((asgData as AssignmentRow[]) ?? []);
    } catch (error) {
      toaster.create({
        title: "Error loading LTI status",
        description: error instanceof Error ? error.message : "Failed to load",
        type: "error"
      });
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    if (courseId) load();
  }, [courseId, load]);

  const toggle = useCallback(
    async (link: ContextLink, key: "roster_sync_enabled" | "grade_sync_enabled", value: boolean) => {
      const supabase = createClient();
      try {
        const { error } = await supabase
          .from("lti_context_links")
          .update({ [key]: value })
          .eq("id", link.id);
        if (error) throw error;
        setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, [key]: value } : l)));
      } catch (error) {
        toaster.create({
          title: "Update failed",
          description: error instanceof Error ? error.message : "Failed to update",
          type: "error"
        });
      }
    },
    []
  );

  const syncRoster = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/lti/sync-roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ class_id: courseId })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      const total = (json.results ?? []).reduce((s: number, r: { memberCount: number }) => s + r.memberCount, 0);
      toaster.create({ title: "Roster synced", description: `${total} members processed`, type: "success" });
      load();
    } catch (error) {
      toaster.create({
        title: "Roster sync failed",
        description: error instanceof Error ? error.message : "Failed",
        type: "error"
      });
    } finally {
      setSyncing(false);
    }
  }, [courseId, load]);

  const pushGrades = useCallback(
    async (assignmentId: number) => {
      setPushingId(assignmentId);
      try {
        const res = await fetch("/api/lti/push-grades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ class_id: courseId, assignment_id: assignmentId })
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Push failed");
        toaster.create({
          title: "Grades pushed",
          description: `${json.pushed} pushed, ${json.skipped} skipped, ${json.failures?.length ?? 0} failed`,
          type: json.failures?.length ? "warning" : "success"
        });
      } catch (error) {
        toaster.create({
          title: "Grade push failed",
          description: error instanceof Error ? error.message : "Failed",
          type: "error"
        });
      } finally {
        setPushingId(null);
      }
    },
    [courseId]
  );

  const linked = links.length > 0;

  return (
    <VStack align="stretch" gap={6} p={4}>
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">LMS (LTI) Sync</Heading>
          <Text color="fg.muted">Sync rosters from your LMS and push assignment grades back via LTI 1.3</Text>
        </VStack>
        <Button variant="outline" onClick={load} loading={loading}>
          <HStack gap={2}>
            <RefreshCw size={16} />
            <Text>Refresh</Text>
          </HStack>
        </Button>
      </Flex>

      {!linked ? (
        <Card.Root>
          <Card.Body>
            <VStack align="start" gap={2} py={4}>
              <Text fontWeight="medium">This course is not yet linked to an LMS context.</Text>
              <Text color="fg.muted" fontSize="sm">
                Launch Pawtograder from your LMS course (via the LTI tool) at least once. The launch records the LMS
                course context here, after which you can enable roster and grade sync.
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      ) : (
        <Card.Root>
          <Card.Header>
            <Flex justify="space-between" align="center">
              <Card.Title>Linked LMS contexts</Card.Title>
              <Button colorScheme="blue" onClick={syncRoster} loading={syncing}>
                <HStack gap={2}>
                  <RefreshCw size={16} />
                  <Text>Sync roster now</Text>
                </HStack>
              </Button>
            </Flex>
          </Card.Header>
          <Card.Body>
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Context</Table.ColumnHeader>
                  <Table.ColumnHeader>Roster sync</Table.ColumnHeader>
                  <Table.ColumnHeader>Grade sync</Table.ColumnHeader>
                  <Table.ColumnHeader>Last roster sync</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {links.map((link) => (
                  <Table.Row key={link.id}>
                    <Table.Cell>
                      <VStack align="start" gap={0}>
                        <Text fontWeight="medium">{link.context_title ?? link.context_label ?? link.context_id}</Text>
                        <Text fontSize="xs" color="fg.subtle">
                          {link.nrps_url ? "NRPS available" : "No NRPS"} ·{" "}
                          {link.ags_lineitems_url ? "AGS available" : "No AGS"}
                        </Text>
                      </VStack>
                    </Table.Cell>
                    <Table.Cell>
                      <Switch
                        aria-label={`Roster sync for ${link.context_title ?? link.context_label ?? link.context_id}`}
                        checked={link.roster_sync_enabled}
                        disabled={!link.nrps_url}
                        onCheckedChange={(e) => toggle(link, "roster_sync_enabled", e.checked)}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <Switch
                        aria-label={`Grade sync for ${link.context_title ?? link.context_label ?? link.context_id}`}
                        checked={link.grade_sync_enabled}
                        disabled={!link.ags_lineitems_url}
                        onCheckedChange={(e) => toggle(link, "grade_sync_enabled", e.checked)}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <VStack align="start" gap={1}>
                        <Text fontSize="sm" color="fg.muted">
                          {link.last_roster_sync_at ? new Date(link.last_roster_sync_at).toLocaleString() : "Never"}
                        </Text>
                        {link.last_roster_sync_status && (
                          <Badge
                            size="sm"
                            colorPalette={link.last_roster_sync_status === "success" ? "green" : "red"}
                            variant="subtle"
                          >
                            {link.last_roster_sync_status}
                          </Badge>
                        )}
                      </VStack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card.Body>
        </Card.Root>
      )}

      {linked && (
        <Card.Root>
          <Card.Header>
            <Card.Title>Push assignment grades</Card.Title>
            <Text color="fg.muted">
              Creates/updates the LMS line item and posts released grades for the assignment.
            </Text>
          </Card.Header>
          <Card.Body>
            {assignments.length === 0 ? (
              <Box textAlign="center" py={6}>
                <Text color="fg.subtle">No assignments in this course.</Text>
              </Box>
            ) : (
              <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Assignment</Table.ColumnHeader>
                    <Table.ColumnHeader>Gradebook column</Table.ColumnHeader>
                    <Table.ColumnHeader>Action</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {assignments.map((a) => (
                    <Table.Row key={a.id}>
                      <Table.Cell>
                        <Text fontWeight="medium">{a.title}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        {a.gradebook_column_id ? (
                          <Badge colorPalette="blue">linked</Badge>
                        ) : (
                          <Badge colorPalette="gray">none</Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!a.gradebook_column_id}
                          loading={pushingId === a.id}
                          onClick={() => pushGrades(a.id)}
                        >
                          <HStack gap={1}>
                            <Upload size={14} />
                            <Text>Push grades</Text>
                          </HStack>
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            )}
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
