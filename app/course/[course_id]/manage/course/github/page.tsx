"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useClassProfiles, useIsInstructor } from "@/hooks/useClassProfiles";
import { createClient } from "@/utils/supabase/client";
import { Box, Card, Heading, Input, Spinner, Text, VStack } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const DEFAULT_HANDOUT = "pawtograder/template-assignment-handout";
const DEFAULT_SOLUTION = "pawtograder/template-assignment-grader";

/**
 * Course-level GitHub template settings. Lets instructors set per-class overrides for the
 * handout and solution template repos (NULL = inherit org default, then the hardcoded
 * constant) and shows the effective resolved templates.
 */
export default function CourseGitHubSettingsPage() {
  const { course_id } = useParams();
  const courseIdNum = Number.parseInt(course_id as string, 10);
  const isInstructor = useIsInstructor();
  const { role } = useClassProfiles();
  const githubOrg = (role.classes as { github_org?: string | null }).github_org ?? null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [handout, setHandout] = useState("");
  const [solution, setSolution] = useState("");
  const [effective, setEffective] = useState<{ handout: string; solution: string } | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    try {
      const [{ data: classRow }, { data: resolved }] = await Promise.all([
        supabase.from("classes").select("handout_template_repo,solution_template_repo").eq("id", courseIdNum).single(),
        supabase.rpc("resolve_class_template_repos", { p_class_id: courseIdNum })
      ]);
      setHandout(classRow?.handout_template_repo ?? "");
      setSolution(classRow?.solution_template_repo ?? "");
      const row = Array.isArray(resolved) ? resolved[0] : resolved;
      if (row) {
        setEffective({ handout: row.handout_template_repo, solution: row.solution_template_repo });
      }
    } catch (err) {
      toaster.error({ title: "Failed to load GitHub settings", description: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [courseIdNum]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.rpc("set_class_template_overrides", {
        p_class_id: courseIdNum,
        p_handout: handout.trim() === "" ? undefined : handout.trim(),
        p_solution: solution.trim() === "" ? undefined : solution.trim()
      });
      if (error) throw error;
      toaster.success({ title: "GitHub template settings saved" });
      await loadConfig();
    } catch (err) {
      toaster.error({ title: "Failed to save settings", description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [courseIdNum, handout, solution, loadConfig]);

  if (!isInstructor) {
    return (
      <Alert status="error" title="Access denied">
        Only instructors can manage GitHub template settings.
      </Alert>
    );
  }

  return (
    <VStack align="stretch" gap={6} maxW="3xl">
      <Box>
        <Heading size="lg">GitHub Templates</Heading>
        <Text color="fg.muted" fontSize="sm">
          Override the handout and solution (grader) template repositories used when creating new assignment repos.
          Leave a field blank to inherit the default for your GitHub org
          {githubOrg ? ` (${githubOrg})` : ""}, then the Pawtograder default.
        </Text>
      </Box>

      <Card.Root>
        <Card.Header>
          <Card.Title>Class template overrides</Card.Title>
        </Card.Header>
        <Card.Body>
          {loading ? (
            <Spinner size="sm" />
          ) : (
            <VStack align="stretch" gap={4}>
              <Field
                label="Handout template repository"
                helperText={`Blank inherits the org / Pawtograder default. e.g. ${DEFAULT_HANDOUT}`}
              >
                <Input
                  value={handout}
                  onChange={(e) => setHandout(e.target.value)}
                  placeholder={effective?.handout ?? DEFAULT_HANDOUT}
                />
              </Field>
              <Field
                label="Solution (grader) template repository"
                helperText={`Blank inherits the org / Pawtograder default. e.g. ${DEFAULT_SOLUTION}`}
              >
                <Input
                  value={solution}
                  onChange={(e) => setSolution(e.target.value)}
                  placeholder={effective?.solution ?? DEFAULT_SOLUTION}
                />
              </Field>
              <Button colorPalette="green" alignSelf="flex-start" onClick={handleSave} loading={saving}>
                Save
              </Button>
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      {effective && (
        <Card.Root>
          <Card.Header>
            <Card.Title>Effective templates</Card.Title>
            <Text color="fg.muted" fontSize="sm">
              Resolved as: class override → org default → Pawtograder default.
            </Text>
          </Card.Header>
          <Card.Body>
            <VStack align="stretch" gap={2}>
              <Text fontSize="sm">
                <Text as="span" fontWeight="medium">
                  Handout:
                </Text>{" "}
                <Text as="span" data-testid="effective-handout">
                  {effective.handout}
                </Text>
              </Text>
              <Text fontSize="sm">
                <Text as="span" fontWeight="medium">
                  Solution:
                </Text>{" "}
                <Text as="span" data-testid="effective-solution">
                  {effective.solution}
                </Text>
              </Text>
            </VStack>
          </Card.Body>
        </Card.Root>
      )}
    </VStack>
  );
}
