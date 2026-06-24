"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Card, Flex, Heading, HStack, NativeSelect, Stack, Table, Text, VStack } from "@chakra-ui/react";
import { Link2, Layers, RefreshCw, Save, X } from "lucide-react";
import SectionMappingEditor from "@/components/lti/SectionMappingEditor";

// Shapes from the admin RPCs (see 20260624000000_lti_section_mapping.sql).
type LtiContext = {
  id: number;
  platform_id: number;
  platform_name: string;
  context_id: string;
  context_label: string | null;
  context_title: string | null;
  class_id: number | null;
  class_name: string | null;
  section_role: string;
  class_section_id: number | null;
  lab_section_id: number | null;
  split_by_member_section: boolean;
  roster_sync_enabled: boolean;
  grade_sync_enabled: boolean;
  last_roster_sync_at: string | null;
  last_roster_sync_status: string | null;
};

type ClassOption = { id: number; name: string; term: number; github_org_name: string };

type BindState = { contextLinkId: number; classId: number | null; sectionRole: string };

export default function LtiContextsPage() {
  const [contexts, setContexts] = useState<LtiContext[]>([]);
  const [classes, setClasses] = useState<ClassOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [bind, setBind] = useState<BindState | null>(null);
  const [saving, setSaving] = useState(false);
  const [mappingId, setMappingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    setIsLoading(true);
    try {
      const [{ data: ctx, error: ctxErr }, { data: cls, error: clsErr }] = await Promise.all([
        supabase.rpc("admin_list_lti_contexts"),
        supabase.rpc("admin_get_classes")
      ]);
      if (ctxErr) throw ctxErr;
      if (clsErr) throw clsErr;
      setContexts((ctx as LtiContext[]) ?? []);
      setClasses(
        ((cls as { id: number; name: string; term: number; github_org_name: string }[]) ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          term: c.term,
          github_org_name: c.github_org_name
        }))
      );
    } catch (error) {
      toaster.create({
        title: "Error loading LTI contexts",
        description: error instanceof Error ? error.message : "Failed to load data",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveBind = useCallback(async () => {
    if (!bind) return;
    const supabase = createClient();
    setSaving(true);
    try {
      // Omit p_class_id (defaults to NULL) to unbind; set it to bind.
      const args: { p_context_link_id: number; p_class_id?: number; p_section_role?: string } = {
        p_context_link_id: bind.contextLinkId
      };
      if (bind.classId != null) args.p_class_id = bind.classId;
      if (bind.sectionRole) args.p_section_role = bind.sectionRole;
      const { error } = await supabase.rpc("admin_bind_lti_context", args);
      if (error) throw error;
      toaster.create({ title: bind.classId ? "Context bound to class" : "Context unbound", type: "success" });
      setBind(null);
      load();
    } catch (error) {
      toaster.create({
        title: "Bind failed",
        description: error instanceof Error ? error.message : "Failed to bind context",
        type: "error"
      });
    } finally {
      setSaving(false);
    }
  }, [bind, load]);

  const unbind = useCallback(
    async (contextLinkId: number) => {
      if (!confirm("Unbind this context from its class? Roster/grade sync for it will stop until rebound.")) return;
      const supabase = createClient();
      try {
        const { error } = await supabase.rpc("admin_bind_lti_context", { p_context_link_id: contextLinkId });
        if (error) throw error;
        toaster.create({ title: "Context unbound", type: "success" });
        load();
      } catch (error) {
        toaster.create({
          title: "Unbind failed",
          description: error instanceof Error ? error.message : "Failed to unbind context",
          type: "error"
        });
      }
    },
    [load]
  );

  const ctxLabel = (c: LtiContext) => c.context_title || c.context_label || c.context_id;

  return (
    <VStack align="stretch" gap={6}>
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">LTI Course Contexts</Heading>
          <Text color="fg.muted">
            Bind Canvas courses (captured on launch) to Pawtograder classes. Only admins may bind; instructors then
            self-serve section mapping on their course&apos;s LTI settings page.
          </Text>
        </VStack>
        <Button variant="outline" onClick={load} loading={isLoading}>
          <HStack gap={2}>
            <RefreshCw size={16} />
            <Text>Refresh</Text>
          </HStack>
        </Button>
      </Flex>

      {bind && (
        <Card.Root borderColor="blue.emphasized" borderWidth="1px">
          <Card.Header>
            <Card.Title>Bind context to a class</Card.Title>
          </Card.Header>
          <Card.Body>
            <Stack gap={3}>
              <Box w="full">
                <Text fontSize="sm" fontWeight="medium" mb={1}>
                  Pawtograder class
                </Text>
                <NativeSelect.Root>
                  <NativeSelect.Field
                    aria-label="Pawtograder class"
                    value={bind.classId == null ? "" : String(bind.classId)}
                    onChange={(e) =>
                      setBind((prev) =>
                        prev ? { ...prev, classId: e.target.value ? Number(e.target.value) : null } : prev
                      )
                    }
                  >
                    <option value="">— Unbound —</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.term ? `(${c.term})` : ""}
                      </option>
                    ))}
                  </NativeSelect.Field>
                </NativeSelect.Root>
              </Box>
              <Box w="full">
                <Text fontSize="sm" fontWeight="medium" mb={1}>
                  Section role
                </Text>
                <NativeSelect.Root>
                  <NativeSelect.Field
                    aria-label="Section role"
                    value={bind.sectionRole}
                    onChange={(e) => setBind((prev) => (prev ? { ...prev, sectionRole: e.target.value } : prev))}
                  >
                    <option value="course_wide">Course-wide</option>
                    <option value="lecture">Lecture</option>
                    <option value="lab">Lab</option>
                  </NativeSelect.Field>
                </NativeSelect.Root>
                <Text fontSize="xs" color="fg.muted" mt={1}>
                  The instructor maps the specific section(s) on their course&apos;s LTI settings page.
                </Text>
              </Box>
              <HStack justify="flex-end" gap={2} pt={2}>
                <Button variant="ghost" onClick={() => setBind(null)}>
                  <HStack gap={1}>
                    <X size={14} />
                    <Text>Cancel</Text>
                  </HStack>
                </Button>
                <Button colorScheme="blue" onClick={saveBind} loading={saving}>
                  <HStack gap={1}>
                    <Save size={14} />
                    <Text>Save</Text>
                  </HStack>
                </Button>
              </HStack>
            </Stack>
          </Card.Body>
        </Card.Root>
      )}

      <Card.Root>
        <Card.Header>
          <Card.Title>Captured contexts</Card.Title>
        </Card.Header>
        <Card.Body>
          {isLoading ? (
            <Box textAlign="center" py={8}>
              <Text>Loading…</Text>
            </Box>
          ) : contexts.length === 0 ? (
            <Box textAlign="center" py={8}>
              <Text color="fg.subtle">
                No LTI contexts captured yet. They appear after the first launch from an LMS.
              </Text>
            </Box>
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Platform</Table.ColumnHeader>
                  <Table.ColumnHeader>Context</Table.ColumnHeader>
                  <Table.ColumnHeader>Bound class</Table.ColumnHeader>
                  <Table.ColumnHeader>Section role</Table.ColumnHeader>
                  <Table.ColumnHeader>Sync</Table.ColumnHeader>
                  <Table.ColumnHeader>Actions</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {contexts.map((c) => (
                  <Fragment key={c.id}>
                    <Table.Row>
                      <Table.Cell>
                        <Text fontSize="sm">{c.platform_name}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Text fontWeight="medium">{ctxLabel(c)}</Text>
                        <Text fontSize="xs" color="fg.muted" fontFamily="mono">
                          {c.context_id}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        {c.class_id ? (
                          <Text fontSize="sm">{c.class_name ?? `#${c.class_id}`}</Text>
                        ) : (
                          <Badge colorPalette="orange" variant="outline">
                            Unbound
                          </Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge variant="subtle">{c.section_role}</Badge>
                        {c.split_by_member_section && (
                          <Badge ml={1} colorPalette="purple" variant="subtle">
                            split
                          </Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap={1}>
                          <Badge colorPalette={c.roster_sync_enabled ? "green" : "gray"} variant="subtle">
                            roster
                          </Badge>
                          <Badge colorPalette={c.grade_sync_enabled ? "green" : "gray"} variant="subtle">
                            grades
                          </Badge>
                        </HStack>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap={2}>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setBind({ contextLinkId: c.id, classId: c.class_id, sectionRole: c.section_role })
                            }
                          >
                            <HStack gap={1}>
                              <Link2 size={14} />
                              <Text>{c.class_id ? "Rebind" : "Bind"}</Text>
                            </HStack>
                          </Button>
                          {c.class_id && (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Map sections for ${ctxLabel(c)}`}
                              onClick={() => setMappingId((prev) => (prev === c.id ? null : c.id))}
                            >
                              <HStack gap={1}>
                                <Layers size={14} />
                                <Text>{mappingId === c.id ? "Hide" : "Sections"}</Text>
                              </HStack>
                            </Button>
                          )}
                          {c.class_id && (
                            <Button
                              size="sm"
                              variant="outline"
                              colorPalette="red"
                              aria-label={`Unbind ${ctxLabel(c)}`}
                              onClick={() => unbind(c.id)}
                            >
                              Unbind
                            </Button>
                          )}
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                    {c.class_id && mappingId === c.id && (
                      <Table.Row>
                        <Table.Cell colSpan={6} bg="bg.subtle">
                          <Box p={2}>
                            <SectionMappingEditor
                              contextLinkId={c.id}
                              classId={c.class_id}
                              sectionRole={c.section_role as "lecture" | "lab" | "course_wide"}
                              classSectionId={c.class_section_id}
                              labSectionId={c.lab_section_id}
                              splitByMemberSection={c.split_by_member_section}
                              nrpsAvailable
                              onChanged={load}
                            />
                          </Box>
                        </Table.Cell>
                      </Table.Row>
                    )}
                  </Fragment>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
