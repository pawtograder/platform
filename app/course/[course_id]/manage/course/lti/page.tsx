"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import {
  Badge,
  Box,
  Card,
  Flex,
  Heading,
  HStack,
  NativeSelect,
  Separator,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { RefreshCw, Search, Upload } from "lucide-react";

type SectionRole = "lecture" | "lab" | "course_wide";

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
  section_role: SectionRole;
  class_section_id: number | null;
  lab_section_id: number | null;
  split_by_member_section: boolean;
}

interface AssignmentRow {
  id: number;
  title: string;
  gradebook_column_id: number | null;
}

interface SectionOption {
  id: number;
  name: string;
  sis_crn: number | null;
}

interface SectionMapRow {
  id: number;
  context_link_id: number;
  canvas_section_name: string;
  class_section_id: number | null;
  lab_section_id: number | null;
}

export default function CourseLtiPage() {
  const params = useParams();
  const courseId = Number(params.course_id);
  const [links, setLinks] = useState<ContextLink[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [classSections, setClassSections] = useState<SectionOption[]>([]);
  const [labSections, setLabSections] = useState<SectionOption[]>([]);
  const [sectionMap, setSectionMap] = useState<SectionMapRow[]>([]);
  const [discovered, setDiscovered] = useState<Record<number, string[]>>({});
  const [discoveringId, setDiscoveringId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pushingId, setPushingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    setLoading(true);
    try {
      const [{ data: linkData, error: linkErr }, { data: asgData, error: asgErr }, csRes, lsRes] = await Promise.all([
        supabase
          .from("lti_context_links")
          .select(
            "id, context_id, context_label, context_title, nrps_url, ags_lineitems_url, roster_sync_enabled, grade_sync_enabled, last_roster_sync_at, last_roster_sync_status, last_roster_sync_message, section_role, class_section_id, lab_section_id, split_by_member_section"
          )
          .eq("class_id", courseId),
        supabase
          .from("assignments")
          .select("id, title, gradebook_column_id")
          .eq("class_id", courseId)
          .order("due_date"),
        supabase.from("class_sections").select("id, name, sis_crn").eq("class_id", courseId).order("name"),
        supabase.from("lab_sections").select("id, name, sis_crn").eq("class_id", courseId).order("name")
      ]);
      if (linkErr) throw linkErr;
      if (asgErr) throw asgErr;
      if (csRes.error) throw csRes.error;
      if (lsRes.error) throw lsRes.error;
      const loadedLinks = (linkData as ContextLink[]) ?? [];
      setLinks(loadedLinks);
      setAssignments((asgData as AssignmentRow[]) ?? []);
      setClassSections((csRes.data as SectionOption[]) ?? []);
      setLabSections((lsRes.data as SectionOption[]) ?? []);

      // Section-name map rows for these contexts (topology B).
      const linkIds = loadedLinks.map((l) => l.id);
      if (linkIds.length > 0) {
        const { data: mapData, error: mapErr } = await supabase
          .from("lti_context_section_map")
          .select("id, context_link_id, canvas_section_name, class_section_id, lab_section_id")
          .in("context_link_id", linkIds);
        if (mapErr) throw mapErr;
        setSectionMap((mapData as SectionMapRow[]) ?? []);
      } else {
        setSectionMap([]);
      }
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

  // Update section-mapping columns on a context link (allowed by the instructor
  // column-level UPDATE grant; class_id is NOT updatable here — admin-only).
  const updateLink = useCallback(
    async (
      link: ContextLink,
      patch: Partial<
        Pick<ContextLink, "section_role" | "class_section_id" | "lab_section_id" | "split_by_member_section">
      >
    ) => {
      const supabase = createClient();
      try {
        const { error } = await supabase.from("lti_context_links").update(patch).eq("id", link.id);
        if (error) throw error;
        setLinks((prev) => prev.map((l) => (l.id === link.id ? { ...l, ...patch } : l)));
      } catch (error) {
        toaster.create({
          title: "Update failed",
          description: error instanceof Error ? error.message : "Failed to update section mapping",
          type: "error"
        });
      }
    },
    []
  );

  const discoverSections = useCallback(async (link: ContextLink) => {
    setDiscoveringId(link.id);
    try {
      const res = await fetch("/api/lti/context-sections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context_link_id: link.id })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Discovery failed");
      setDiscovered((prev) => ({ ...prev, [link.id]: (json.sections as string[]) ?? [] }));
    } catch (error) {
      toaster.create({
        title: "Section discovery failed",
        description: error instanceof Error ? error.message : "Failed",
        type: "error"
      });
    } finally {
      setDiscoveringId(null);
    }
  }, []);

  // Map a Canvas section name to a Pawtograder section (or clear it). `target`
  // selects which section type the role implies.
  const setMapTarget = useCallback(
    async (link: ContextLink, canvasName: string, sectionId: number | null) => {
      const supabase = createClient();
      const existing = sectionMap.find((m) => m.context_link_id === link.id && m.canvas_section_name === canvasName);
      try {
        if (sectionId === null) {
          if (existing) {
            const { error } = await supabase.from("lti_context_section_map").delete().eq("id", existing.id);
            if (error) throw error;
            setSectionMap((prev) => prev.filter((m) => m.id !== existing.id));
          }
          return;
        }
        const row = {
          context_link_id: link.id,
          canvas_section_name: canvasName,
          class_section_id: link.section_role === "lab" ? null : sectionId,
          lab_section_id: link.section_role === "lab" ? sectionId : null
        };
        const { data, error } = await supabase
          .from("lti_context_section_map")
          .upsert(row, { onConflict: "context_link_id,canvas_section_name" })
          .select("id, context_link_id, canvas_section_name, class_section_id, lab_section_id")
          .single();
        if (error) throw error;
        setSectionMap((prev) => [
          ...prev.filter(
            (m) =>
              m.id !== (data as SectionMapRow).id &&
              !(m.context_link_id === link.id && m.canvas_section_name === canvasName)
          ),
          data as SectionMapRow
        ]);
      } catch (error) {
        toaster.create({
          title: "Mapping failed",
          description: error instanceof Error ? error.message : "Failed to save section mapping",
          type: "error"
        });
      }
    },
    [sectionMap]
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
  // Only sections with a SIS CRN are mappable — sis_sync_enrollment matches on it.
  const usableClassSections = classSections.filter((s) => s.sis_crn != null);
  const usableLabSections = labSections.filter((s) => s.sis_crn != null);
  const crnlessCount =
    classSections.length - usableClassSections.length + (labSections.length - usableLabSections.length);

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
            <Card.Title>Section mapping</Card.Title>
            <Text color="fg.muted">
              Choose what each linked LMS context represents and which Pawtograder section(s) its members are enrolled
              into. Course-wide enrolls everyone without a section.
            </Text>
          </Card.Header>
          <Card.Body>
            {crnlessCount > 0 && (
              <Text fontSize="sm" color="orange.fg" mb={3}>
                {crnlessCount} section(s) have no SIS CRN and can&apos;t be mapped — set a CRN in course section
                settings first.
              </Text>
            )}
            <VStack align="stretch" gap={5}>
              {links.map((link, idx) => {
                const title = link.context_title ?? link.context_label ?? link.context_id;
                const role = link.section_role;
                const splitOptions = role === "lab" ? usableLabSections : usableClassSections;
                // Canvas section names to map: discovered (live) ∪ already-mapped.
                const mappedNames = sectionMap
                  .filter((m) => m.context_link_id === link.id)
                  .map((m) => m.canvas_section_name);
                const names = [...new Set([...(discovered[link.id] ?? []), ...mappedNames])].sort();
                return (
                  <Box key={link.id}>
                    {idx > 0 && <Separator mb={5} />}
                    <Text fontWeight="medium" mb={2}>
                      {title}
                    </Text>
                    <HStack gap={4} align="end" wrap="wrap">
                      <Box minW="180px">
                        <Text fontSize="sm" fontWeight="medium" mb={1}>
                          This context is a
                        </Text>
                        <NativeSelect.Root size="sm">
                          <NativeSelect.Field
                            aria-label={`Section role for ${title}`}
                            value={role}
                            onChange={(e) => updateLink(link, { section_role: e.target.value as SectionRole })}
                          >
                            <option value="course_wide">Course-wide (no section)</option>
                            <option value="lecture">Lecture section</option>
                            <option value="lab">Lab section</option>
                          </NativeSelect.Field>
                        </NativeSelect.Root>
                      </Box>

                      {role !== "course_wide" && (
                        <HStack gap={2} pb={1}>
                          <Switch
                            aria-label={`Split ${title} by member section`}
                            checked={link.split_by_member_section}
                            onCheckedChange={(e) => updateLink(link, { split_by_member_section: e.checked })}
                          />
                          <Text fontSize="sm">Split by member section</Text>
                        </HStack>
                      )}

                      {role === "lecture" && !link.split_by_member_section && (
                        <Box minW="220px">
                          <Text fontSize="sm" fontWeight="medium" mb={1}>
                            Lecture section
                          </Text>
                          <NativeSelect.Root size="sm">
                            <NativeSelect.Field
                              aria-label={`Lecture section for ${title}`}
                              value={link.class_section_id == null ? "" : String(link.class_section_id)}
                              onChange={(e) =>
                                updateLink(link, { class_section_id: e.target.value ? Number(e.target.value) : null })
                              }
                            >
                              <option value="">— Select —</option>
                              {usableClassSections.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} (CRN {s.sis_crn})
                                </option>
                              ))}
                            </NativeSelect.Field>
                          </NativeSelect.Root>
                        </Box>
                      )}

                      {role === "lab" && !link.split_by_member_section && (
                        <Box minW="220px">
                          <Text fontSize="sm" fontWeight="medium" mb={1}>
                            Lab section
                          </Text>
                          <NativeSelect.Root size="sm">
                            <NativeSelect.Field
                              aria-label={`Lab section for ${title}`}
                              value={link.lab_section_id == null ? "" : String(link.lab_section_id)}
                              onChange={(e) =>
                                updateLink(link, { lab_section_id: e.target.value ? Number(e.target.value) : null })
                              }
                            >
                              <option value="">— Select —</option>
                              {usableLabSections.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} (CRN {s.sis_crn})
                                </option>
                              ))}
                            </NativeSelect.Field>
                          </NativeSelect.Root>
                        </Box>
                      )}
                    </HStack>

                    {role !== "course_wide" && link.split_by_member_section && (
                      <Box mt={3}>
                        <HStack justify="space-between" mb={2}>
                          <Text fontSize="sm" color="fg.muted">
                            Map each Canvas section name to a Pawtograder {role === "lab" ? "lab" : "lecture"} section.
                          </Text>
                          <Button
                            size="xs"
                            variant="outline"
                            loading={discoveringId === link.id}
                            disabled={!link.nrps_url}
                            onClick={() => discoverSections(link)}
                          >
                            <HStack gap={1}>
                              <Search size={12} />
                              <Text>Discover sections</Text>
                            </HStack>
                          </Button>
                        </HStack>
                        {names.length === 0 ? (
                          <Text fontSize="sm" color="fg.subtle">
                            No Canvas sections discovered yet — click “Discover sections”.
                          </Text>
                        ) : (
                          <Table.Root size="sm">
                            <Table.Header>
                              <Table.Row>
                                <Table.ColumnHeader>Canvas section</Table.ColumnHeader>
                                <Table.ColumnHeader>Pawtograder section</Table.ColumnHeader>
                              </Table.Row>
                            </Table.Header>
                            <Table.Body>
                              {names.map((name) => {
                                const m = sectionMap.find(
                                  (x) => x.context_link_id === link.id && x.canvas_section_name === name
                                );
                                const current = role === "lab" ? m?.lab_section_id : m?.class_section_id;
                                const isMapped = current != null;
                                return (
                                  <Table.Row key={name}>
                                    <Table.Cell>
                                      <HStack gap={2}>
                                        <Text>{name}</Text>
                                        {!isMapped && (
                                          <Badge size="sm" colorPalette="orange" variant="subtle">
                                            unmapped
                                          </Badge>
                                        )}
                                      </HStack>
                                    </Table.Cell>
                                    <Table.Cell>
                                      <NativeSelect.Root size="sm" maxW="240px">
                                        <NativeSelect.Field
                                          aria-label={`Map ${name}`}
                                          value={current == null ? "" : String(current)}
                                          onChange={(e) =>
                                            setMapTarget(link, name, e.target.value ? Number(e.target.value) : null)
                                          }
                                        >
                                          <option value="">— Unmapped —</option>
                                          {splitOptions.map((s) => (
                                            <option key={s.id} value={s.id}>
                                              {s.name} (CRN {s.sis_crn})
                                            </option>
                                          ))}
                                        </NativeSelect.Field>
                                      </NativeSelect.Root>
                                    </Table.Cell>
                                  </Table.Row>
                                );
                              })}
                            </Table.Body>
                          </Table.Root>
                        )}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </VStack>
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
