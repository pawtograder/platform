"use client";

import { EnterCourseAsInstructorButton } from "@/components/admin/EnterCourseAsInstructor";
import RepoFileEditor from "@/components/github/RepoFileEditor";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { useRevalidateServerCaches } from "@/hooks/useRevalidateServerCaches";
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
  const revalidateServerCaches = useRevalidateServerCaches();
  // The org's OWN stored defaults, blank when it stores none and inherits the deployment's. Filled
  // from the raw override columns rather than the resolved ones on purpose: rendering the resolved
  // value here would make every save post it back as an explicit override, which is how an org that
  // was inheriting stopped inheriting the moment an admin opened this page to tick a checkbox.
  const [handout, setHandout] = useState("");
  const [solution, setSolution] = useState("");
  // What is actually in force, override or inherited. Shown as the inputs' placeholder, and the
  // file editor is gated on these: a repo in this org is editable whether it is pinned here or
  // inherited from the deployment default. Distinct from the live inputs so that typing doesn't
  // mount RepoFileEditor and fire GitHub fetches for a half-typed or not-yet-saved repo.
  const [savedHandout, setSavedHandout] = useState("");
  const [savedSolution, setSavedSolution] = useState("");
  // Held as the raw text the admin typed, not as a parsed array, so a half-typed entry doesn't
  // vanish from the box while they're still writing it. Parsed on save.
  const [exemptUsers, setExemptUsers] = useState("");
  const [excludedFromAutomation, setExcludedFromAutomation] = useState(false);
  // Whether admin_get_github_orgs actually returned this org. PostgREST caps that RPC at max_rows
  // (1000), so on a deployment with more orgs than that the target may simply be absent from the
  // response — and every field would then initialize to its empty value and be written back on the
  // next save, silently clearing a real exemption list or automation exclusion.
  // Starts FALSE. If either RPC throws, `load` reaches its catch before populating anything, and a
  // guard that defaulted to true left the page showing empty inputs and an enabled Save — which
  // would then write an empty exemption array, a false exclusion, and deployment-default templates
  // over whatever was actually stored. Saving is enabled only once the org has genuinely loaded.
  const [orgFound, setOrgFound] = useState(false);
  // What the exclusion was when this page loaded. The RPC reads `undefined` as "not supplied by
  // this caller" and keeps the stored value, so sending the checkbox only when it actually changed
  // lets two admins edit different fields without one silently reverting the other's. This flag is
  // the switch that stops background GitHub mutations, so losing an enable is the expensive
  // direction.
  const [loadedExcluded, setLoadedExcluded] = useState(false);
  const [courses, setCourses] = useState<OrgCourse[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setOrgFound(false);
    const supabase = createClient();
    try {
      const [{ data: orgs, error: orgsError }, { data: orgCourses, error: coursesError }] = await Promise.all([
        supabase.rpc("admin_get_github_orgs"),
        supabase.rpc("admin_get_org_courses", { p_org_name: orgName })
      ]);
      if (orgsError) throw orgsError;
      if (coursesError) throw coursesError;
      const thisOrg = (orgs ?? []).find((o) => o.org_name === orgName);
      setHandout(thisOrg?.override_handout_template_repo ?? "");
      setSolution(thisOrg?.override_solution_template_repo ?? "");
      setSavedHandout(thisOrg?.default_handout_template_repo ?? "");
      setSavedSolution(thisOrg?.default_solution_template_repo ?? "");
      setExemptUsers((thisOrg?.permission_sync_exempt_users ?? []).join(", "));
      setExcludedFromAutomation(thisOrg?.excluded_from_automation ?? false);
      setLoadedExcluded(thisOrg?.excluded_from_automation ?? false);
      setOrgFound(thisOrg !== undefined);
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
    if (!orgFound) {
      // Refuse rather than write defaults over whatever is actually stored.
      toaster.error({
        title: "Cannot save",
        description: "This org was not returned by the admin org list, so its current settings are unknown."
      });
      return;
    }
    setSaving(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.rpc("admin_upsert_github_org", {
        p_org_name: orgName,
        // Blank is sent as `undefined`, which the RPC stores as NULL: "this org pins nothing, use
        // the deployment default". For these two fields that is the admin's actual intent, because
        // the inputs render the stored override and nothing else.
        p_handout: handout.trim() === "" ? undefined : handout.trim(),
        p_solution: solution.trim() === "" ? undefined : solution.trim(),
        // Always sent, including as an empty array: `undefined` means "leave as-is" to the RPC, so
        // omitting it when the box is cleared would make clearing the list impossible.
        p_permission_sync_exempt_users: exemptUsers
          .split(/[\s,]+/)
          .map((u) => u.trim())
          .filter((u) => u !== ""),
        // Sent only when this page changed it. Always sending would have one admin's unrelated
        // template or exemption save silently revert an exclusion another admin enabled after this
        // page loaded. Ticking and unticking both still send, so the box remains usable.
        p_excluded_from_automation: excludedFromAutomation === loadedExcluded ? undefined : excludedFromAutomation
      });
      if (error) throw error;
      toaster.success({ title: "Org defaults saved" });
      await load();
      // /admin/github-orgs lists these defaults from a server component; drop the browser's
      // cached render of it so returning via the back link does not show the old values.
      await revalidateServerCaches();
    } catch (err) {
      toaster.error({ title: "Failed to save org defaults", description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [
    orgName,
    handout,
    solution,
    exemptUsers,
    excludedFromAutomation,
    loadedExcluded,
    orgFound,
    load,
    revalidateServerCaches
  ]);

  // A course in this org gives the edge function a valid auth/ownership context for editing the
  // org's template repos. (Writes are restricted to the course's own org.) Prefer a non-archived
  // course so the auth context isn't an arbitrary archived one.
  const authCourseId = useMemo(() => (courses.find((c) => !c.archived) ?? courses[0])?.id, [courses]);

  // Gate on the *saved* defaults, not the live inputs: the edge function only allows writes to
  // the course's own org, and we don't want RepoFileEditor mounting (and fetching from GitHub)
  // for whatever is currently typed.
  const handoutRepo = useMemo(() => parseRepo(savedHandout), [savedHandout]);
  const solutionRepo = useMemo(() => parseRepo(savedSolution), [savedSolution]);
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
            <Field
              label="Default handout template repository"
              helperText={`Leave blank to follow this deployment's default (${savedHandout}).`}
            >
              <Input
                value={handout}
                onChange={(e) => setHandout(e.target.value)}
                fontFamily="mono"
                placeholder={savedHandout}
              />
            </Field>
            <Field
              label="Default solution (grader) template repository"
              helperText={`Leave blank to follow this deployment's default (${savedSolution}).`}
            >
              <Input
                value={solution}
                onChange={(e) => setSolution(e.target.value)}
                fontFamily="mono"
                placeholder={savedSolution}
              />
            </Field>
            <Field
              label="Permission sync exemptions"
              helperText="GitHub usernames, comma separated. Repository permission sync removes anyone who is not on the course roster or the staff team; these accounts are left alone. Use for access that is intentional but that the roster cannot explain — institutional IT, an integration account, or faculty carried on repos directly."
            >
              <Input
                value={exemptUsers}
                onChange={(e) => setExemptUsers(e.target.value)}
                fontFamily="mono"
                placeholder="octocat, some-ops-account"
              />
            </Field>
            <Field
              label="Exclude from background automation"
              helperText="Stops the reconciler creating missing handout and solution repos for assignments in this org. For test, dev, and demo orgs. It does NOT stop student-repo reconciliation (reconcile_stuck_repo_creations), and instructor-initiated actions are unaffected."
            >
              <Checkbox
                checked={excludedFromAutomation}
                onCheckedChange={(e) => setExcludedFromAutomation(!!e.checked)}
              >
                Excluded from automation
              </Checkbox>
            </Field>
            {!orgFound && (
              <Alert status="warning">
                This org was not returned by the admin org list, so its stored settings could not be read. Saving is
                disabled to avoid overwriting them.
              </Alert>
            )}
            <Button
              colorPalette="green"
              alignSelf="flex-start"
              onClick={handleSave}
              loading={saving}
              disabled={!orgFound}
            >
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
                    Save a valid &quot;org/repo&quot; handout template in this org above to edit its files.
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
                    Save a valid &quot;org/repo&quot; solution template in this org above to edit its files.
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
