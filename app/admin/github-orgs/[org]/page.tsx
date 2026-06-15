"use client";

import { EnterCourseAsInstructorButton } from "@/components/admin/EnterCourseAsInstructor";
import RepoFileEditor from "@/components/github/RepoFileEditor";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Card, Flex, Heading, Input, Spinner, Table, Tabs, Text, VStack } from "@chakra-ui/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

type OrgCourse = {
  id: number;
  name: string | null;
  term: number | null;
  archived: boolean;
  handout_template_repo: string | null;
  solution_template_repo: string | null;
  effective_handout_template_repo: string;
  effective_solution_template_repo: string;
};

/** Parse an exact "org/repo" string; returns null for anything else (extra segments, empty parts). */
function parseRepo(value: string): { org: string; repo: string } | null {
  const segments = value.split("/").map((s) => s.trim());
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { org: segments[0], repo: segments[1] };
}

export default function GitHubOrgDetailPage() {
  const params = useParams();
  const orgName = decodeURIComponent(params.org as string);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [handout, setHandout] = useState("");
  const [solution, setSolution] = useState("");
  const [courses, setCourses] = useState<OrgCourse[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    try {
      const [{ data: orgs, error: orgsError }, { data: orgCourses, error: coursesError }] = await Promise.all([
        supabase.rpc("admin_get_github_orgs"),
        supabase.rpc("admin_get_org_courses", { p_org_name: orgName })
      ]);
      if (orgsError) throw orgsError;
      if (coursesError) throw coursesError;
      const thisOrg = (orgs ?? []).find((o) => o.org_name === orgName);
      setHandout(thisOrg?.default_handout_template_repo ?? "");
      setSolution(thisOrg?.default_solution_template_repo ?? "");
      setCourses((orgCourses ?? []) as OrgCourse[]);
    } catch (err) {
      toaster.error({ title: "Failed to load org", description: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [orgName]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.rpc("admin_upsert_github_org", {
        p_org_name: orgName,
        p_handout: handout.trim() === "" ? undefined : handout.trim(),
        p_solution: solution.trim() === "" ? undefined : solution.trim()
      });
      if (error) throw error;
      toaster.success({ title: "Org defaults saved" });
      await load();
    } catch (err) {
      toaster.error({ title: "Failed to save org defaults", description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [orgName, handout, solution, load]);

  // A course in this org gives the edge function a valid auth/ownership context for
  // editing the org's template repos. (Writes are restricted to the course's own org.)
  const authCourseId = useMemo(() => courses[0]?.id, [courses]);

  // The edge function only allows writes to the course's own org, so editing requires the
  // template repo to live in this org.
  const handoutRepo = useMemo(() => parseRepo(handout), [handout]);
  const solutionRepo = useMemo(() => parseRepo(solution), [solution]);
  const canEditHandout = authCourseId !== undefined && handoutRepo !== null && handoutRepo.org === orgName;
  const canEditSolution = authCourseId !== undefined && solutionRepo !== null && solutionRepo.org === orgName;

  if (loading) {
    return <Spinner />;
  }

  return (
    <VStack align="stretch" gap={6}>
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">{orgName}</Heading>
          <Text color="fg.muted">
            <Link href="/admin/github-orgs">← All GitHub orgs</Link>
          </Text>
        </VStack>
      </Flex>

      <Card.Root>
        <Card.Header>
          <Card.Title>Default template repositories</Card.Title>
          <Text color="fg.muted" fontSize="sm">
            Used for new assignment repos in classes that don&apos;t override them.
          </Text>
        </Card.Header>
        <Card.Body>
          <VStack align="stretch" gap={4} maxW="2xl">
            <Field label="Default handout template repository">
              <Input value={handout} onChange={(e) => setHandout(e.target.value)} fontFamily="mono" />
            </Field>
            <Field label="Default solution (grader) template repository">
              <Input value={solution} onChange={(e) => setSolution(e.target.value)} fontFamily="mono" />
            </Field>
            <Button colorPalette="green" alignSelf="flex-start" onClick={handleSave} loading={saving}>
              Save defaults
            </Button>
          </VStack>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title>Courses in this org</Card.Title>
        </Card.Header>
        <Card.Body>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Course</Table.ColumnHeader>
                <Table.ColumnHeader>Handout template</Table.ColumnHeader>
                <Table.ColumnHeader>Solution template</Table.ColumnHeader>
                <Table.ColumnHeader>Actions</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {courses.map((c) => (
                <Table.Row key={c.id}>
                  <Table.Cell>
                    <Text fontWeight="medium">{c.name}</Text>
                    {c.archived && (
                      <Badge colorPalette="gray" size="sm">
                        Archived
                      </Badge>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontFamily="mono" fontSize="sm">
                      {c.effective_handout_template_repo}
                    </Text>
                    <Badge colorPalette={c.handout_template_repo ? "purple" : "gray"} size="sm">
                      {c.handout_template_repo ? "Override" : "Inherited"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Text fontFamily="mono" fontSize="sm">
                      {c.effective_solution_template_repo}
                    </Text>
                    <Badge colorPalette={c.solution_template_repo ? "purple" : "gray"} size="sm">
                      {c.solution_template_repo ? "Override" : "Inherited"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <EnterCourseAsInstructorButton classId={c.id} size="xs" variant="outline">
                      Manage as instructor
                    </EnterCourseAsInstructorButton>
                  </Table.Cell>
                </Table.Row>
              ))}
              {courses.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={4}>
                    <Text color="fg.muted">No courses in this org yet.</Text>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table.Root>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title>Edit template repo files</Card.Title>
          <Text color="fg.muted" fontSize="sm">
            Edit the config and GitHub Actions workflow files in this org&apos;s template repos, with live validation.
          </Text>
        </Card.Header>
        <Card.Body>
          {authCourseId === undefined ? (
            <Alert status="info" title="No course context">
              Editing template repo files requires at least one course in this org to authorize GitHub access.
            </Alert>
          ) : (
            <Tabs.Root defaultValue="handout" lazyMount unmountOnExit>
              <Tabs.List>
                <Tabs.Trigger value="handout">Handout template</Tabs.Trigger>
                <Tabs.Trigger value="solution">Solution template</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="handout">
                {canEditHandout ? (
                  <Box pt={2}>
                    <RepoFileEditor
                      courseId={authCourseId}
                      orgName={handoutRepo.org}
                      repoName={handoutRepo.repo}
                      path=".github/workflows/grade.yml"
                      paths={[
                        { label: ".github/workflows/grade.yml", path: ".github/workflows/grade.yml" },
                        { label: "pawtograder.yml", path: "pawtograder.yml" }
                      ]}
                    />
                  </Box>
                ) : (
                  <Text color="fg.muted" pt={2}>
                    Set a valid &quot;org/repo&quot; handout template in this org above to edit its files.
                  </Text>
                )}
              </Tabs.Content>
              <Tabs.Content value="solution">
                {canEditSolution ? (
                  <Box pt={2}>
                    <RepoFileEditor
                      courseId={authCourseId}
                      orgName={solutionRepo.org}
                      repoName={solutionRepo.repo}
                      path="pawtograder.yml"
                      paths={[
                        { label: "pawtograder.yml", path: "pawtograder.yml" },
                        { label: ".github/workflows/grade.yml", path: ".github/workflows/grade.yml" }
                      ]}
                    />
                  </Box>
                ) : (
                  <Text color="fg.muted" pt={2}>
                    Set a valid &quot;org/repo&quot; solution template in this org above to edit its files.
                  </Text>
                )}
              </Tabs.Content>
            </Tabs.Root>
          )}
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
