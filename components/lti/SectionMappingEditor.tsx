"use client";

/**
 * Per-context LTI section mapping (docs/lti-section-mapping.md).
 *
 * Lets a user choose what a linked Canvas context represents and which
 * Pawtograder section(s) its members enroll into:
 *   - course_wide  → everyone, no section
 *   - lecture/lab + a context-level section (topology A)
 *   - split_by_member_section → map each Canvas section name to a Pawtograder
 *     section (topology B), discovered live via NRPS
 *
 * Writes go straight to lti_context_links (section columns are granted to
 * `authenticated`) and lti_context_section_map; RLS allows the bound class's
 * instructors and site admins, so this one component serves both the instructor
 * course page and the admin contexts page. Only sections with a SIS CRN are
 * selectable — the roster sync matches sections by `sis_crn`.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, HStack, NativeSelect, Table, Text } from "@chakra-ui/react";
import { Search } from "lucide-react";

type SectionRole = "lecture" | "lab" | "course_wide";

export interface SectionMappingEditorProps {
  contextLinkId: number;
  /** The Pawtograder class the context is bound to. */
  classId: number;
  sectionRole: SectionRole;
  classSectionId: number | null;
  labSectionId: number | null;
  splitByMemberSection: boolean;
  /** Whether the context captured an NRPS membership URL (gates "Discover"). */
  nrpsAvailable: boolean;
  /** Called after a successful write so the parent can refresh its row data. */
  onChanged?: () => void;
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

export default function SectionMappingEditor(props: SectionMappingEditorProps) {
  const { contextLinkId, classId, nrpsAvailable, onChanged } = props;

  // Local mirror of the link's section fields so the UI updates immediately;
  // re-synced if the parent passes new values.
  const [role, setRole] = useState<SectionRole>(props.sectionRole);
  const [classSectionId, setClassSectionId] = useState<number | null>(props.classSectionId);
  const [labSectionId, setLabSectionId] = useState<number | null>(props.labSectionId);
  const [split, setSplit] = useState<boolean>(props.splitByMemberSection);

  const [classSections, setClassSections] = useState<SectionOption[]>([]);
  const [labSections, setLabSections] = useState<SectionOption[]>([]);
  const [sectionMap, setSectionMap] = useState<SectionMapRow[]>([]);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    setRole(props.sectionRole);
    setClassSectionId(props.classSectionId);
    setLabSectionId(props.labSectionId);
    setSplit(props.splitByMemberSection);
  }, [props.sectionRole, props.classSectionId, props.labSectionId, props.splitByMemberSection]);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [cs, ls, mapRes] = await Promise.all([
      supabase.from("class_sections").select("id, name, sis_crn").eq("class_id", classId).order("name"),
      supabase.from("lab_sections").select("id, name, sis_crn").eq("class_id", classId).order("name"),
      supabase
        .from("lti_context_section_map")
        .select("id, context_link_id, canvas_section_name, class_section_id, lab_section_id")
        .eq("context_link_id", contextLinkId)
    ]);
    if (!cs.error) setClassSections((cs.data as SectionOption[]) ?? []);
    if (!ls.error) setLabSections((ls.data as SectionOption[]) ?? []);
    if (!mapRes.error) setSectionMap((mapRes.data as SectionMapRow[]) ?? []);
  }, [classId, contextLinkId]);

  useEffect(() => {
    load();
  }, [load]);

  const updateLink = useCallback(
    async (
      patch: Partial<{
        section_role: SectionRole;
        class_section_id: number | null;
        lab_section_id: number | null;
        split_by_member_section: boolean;
      }>
    ) => {
      const supabase = createClient();
      const { error } = await supabase.from("lti_context_links").update(patch).eq("id", contextLinkId);
      if (error) {
        toaster.create({
          title: "Update failed",
          description: error.message,
          type: "error"
        });
        return false;
      }
      onChanged?.();
      return true;
    },
    [contextLinkId, onChanged]
  );

  const onRoleChange = useCallback(
    async (next: SectionRole) => {
      setRole(next);
      await updateLink({ section_role: next });
    },
    [updateLink]
  );

  const onSplitChange = useCallback(
    async (next: boolean) => {
      setSplit(next);
      await updateLink({ split_by_member_section: next });
    },
    [updateLink]
  );

  const onContextSectionChange = useCallback(
    async (kind: "class" | "lab", id: number | null) => {
      if (kind === "class") {
        setClassSectionId(id);
        await updateLink({ class_section_id: id });
      } else {
        setLabSectionId(id);
        await updateLink({ lab_section_id: id });
      }
    },
    [updateLink]
  );

  const discover = useCallback(async () => {
    setDiscovering(true);
    try {
      const res = await fetch("/api/lti/context-sections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context_link_id: contextLinkId })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Discovery failed");
      setDiscovered((json.sections as string[]) ?? []);
    } catch (e) {
      toaster.create({
        title: "Section discovery failed",
        description: e instanceof Error ? e.message : "Failed",
        type: "error"
      });
    } finally {
      setDiscovering(false);
    }
  }, [contextLinkId]);

  const setMapTarget = useCallback(
    async (canvasName: string, sectionId: number | null) => {
      const supabase = createClient();
      const existing = sectionMap.find((m) => m.canvas_section_name === canvasName);
      if (sectionId === null) {
        if (existing) {
          const { error } = await supabase.from("lti_context_section_map").delete().eq("id", existing.id);
          if (error) {
            toaster.create({ title: "Mapping failed", description: error.message, type: "error" });
            return;
          }
          setSectionMap((prev) => prev.filter((m) => m.id !== existing.id));
        }
        return;
      }
      const row = {
        context_link_id: contextLinkId,
        canvas_section_name: canvasName,
        class_section_id: role === "lab" ? null : sectionId,
        lab_section_id: role === "lab" ? sectionId : null
      };
      const { data, error } = await supabase
        .from("lti_context_section_map")
        .upsert(row, { onConflict: "context_link_id,canvas_section_name" })
        .select("id, context_link_id, canvas_section_name, class_section_id, lab_section_id")
        .single();
      if (error) {
        toaster.create({ title: "Mapping failed", description: error.message, type: "error" });
        return;
      }
      setSectionMap((prev) => [...prev.filter((m) => m.canvas_section_name !== canvasName), data as SectionMapRow]);
    },
    [contextLinkId, role, sectionMap]
  );

  const usableClass = classSections.filter((s) => s.sis_crn != null);
  const usableLab = labSections.filter((s) => s.sis_crn != null);
  const splitOptions = role === "lab" ? usableLab : usableClass;
  const crnlessCount = classSections.length - usableClass.length + (labSections.length - usableLab.length);

  const mappedNames = sectionMap.map((m) => m.canvas_section_name);
  const names = [...new Set([...discovered, ...mappedNames])].sort();

  return (
    <Box>
      <HStack gap={4} align="end" wrap="wrap">
        <Box minW="190px">
          <Text fontSize="sm" fontWeight="medium" mb={1}>
            This context is a
          </Text>
          <NativeSelect.Root size="sm">
            <NativeSelect.Field
              aria-label="Section role"
              value={role}
              onChange={(e) => onRoleChange(e.target.value as SectionRole)}
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
              aria-label="Split by member section"
              checked={split}
              onCheckedChange={(e) => onSplitChange(e.checked)}
            />
            <Text fontSize="sm">Split by member section</Text>
          </HStack>
        )}

        {role === "lecture" && !split && (
          <Box minW="220px">
            <Text fontSize="sm" fontWeight="medium" mb={1}>
              Lecture section
            </Text>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field
                aria-label="Lecture section"
                value={classSectionId == null ? "" : String(classSectionId)}
                onChange={(e) => onContextSectionChange("class", e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— Select —</option>
                {usableClass.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (CRN {s.sis_crn})
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </Box>
        )}

        {role === "lab" && !split && (
          <Box minW="220px">
            <Text fontSize="sm" fontWeight="medium" mb={1}>
              Lab section
            </Text>
            <NativeSelect.Root size="sm">
              <NativeSelect.Field
                aria-label="Lab section"
                value={labSectionId == null ? "" : String(labSectionId)}
                onChange={(e) => onContextSectionChange("lab", e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— Select —</option>
                {usableLab.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (CRN {s.sis_crn})
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </Box>
        )}
      </HStack>

      {crnlessCount > 0 && (
        <Text fontSize="xs" color="orange.fg" mt={2}>
          {crnlessCount} section(s) have no SIS CRN and aren&apos;t selectable — set a CRN in the class&apos;s section
          settings.
        </Text>
      )}

      {role !== "course_wide" && split && (
        <Box mt={3}>
          <HStack justify="space-between" mb={2}>
            <Text fontSize="sm" color="fg.muted">
              Map each Canvas section name to a Pawtograder {role === "lab" ? "lab" : "lecture"} section.
            </Text>
            <Button size="xs" variant="outline" loading={discovering} disabled={!nrpsAvailable} onClick={discover}>
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
                  const m = sectionMap.find((x) => x.canvas_section_name === name);
                  const current = role === "lab" ? m?.lab_section_id : m?.class_section_id;
                  return (
                    <Table.Row key={name}>
                      <Table.Cell>
                        <HStack gap={2}>
                          <Text>{name}</Text>
                          {current == null && (
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
                            onChange={(e) => setMapTarget(name, e.target.value ? Number(e.target.value) : null)}
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
}
