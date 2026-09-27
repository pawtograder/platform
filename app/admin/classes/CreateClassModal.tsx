"use client";

import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TermSelector } from "@/components/ui/term-selector";
import { toaster } from "@/components/ui/toaster";
import { enrollmentAdd, listGitHubOrgs } from "@/lib/edgeFunctions";
import type { GitHubOrg } from "@/supabase/functions/_shared/FunctionTypes";
import { createClient } from "@/utils/supabase/client";
import { Box, HStack, IconButton, Link, NativeSelect, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { FaPlus, FaTrash } from "react-icons/fa";

interface CreateClassModalProps {
  children: React.ReactNode;
}

type InstructorRow = {
  // Stable identity so async lookups and row removal target the right row even
  // when the list is reordered/filtered (array index is not stable).
  id: string;
  email: string;
  name: string;
  // null = not yet looked up, true = matched existing user, false = no match
  matched: boolean | null;
  lookupLoading: boolean;
  // Set when the lookup itself failed (network/session/RPC error) as opposed to
  // a genuine "no such user". Kept distinct from matched=false so we never treat
  // a failed lookup as "create a brand-new user".
  lookupError: string | null;
};

function emptyInstructor(): InstructorRow {
  return { id: crypto.randomUUID(), email: "", name: "", matched: null, lookupLoading: false, lookupError: null };
}

const initialFormData = () => ({
  name: "",
  term: parseInt(`${new Date().getFullYear()}10`), // Default to current year + fall (10)
  description: "",
  canvas_course_id: "",
  github_org_name: "",
  github_template_prefix: ""
});

export default function CreateClassModal({ children }: CreateClassModalProps) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState(initialFormData());

  const [orgs, setOrgs] = useState<GitHubOrg[] | null>(null);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string>("https://github.com/settings/installations");

  const [instructors, setInstructors] = useState<InstructorRow[]>([emptyInstructor()]);

  const supabase = createClient();
  const router = useRouter();

  const loadOrgs = useCallback(async () => {
    setOrgsLoading(true);
    setOrgsError(null);
    try {
      const { orgs: fetched, installUrl: url } = await listGitHubOrgs(supabase);
      setOrgs(fetched);
      if (url) setInstallUrl(url);
    } catch (error) {
      setOrgs([]);
      setOrgsError(error instanceof Error ? error.message : "Failed to load GitHub organizations");
    } finally {
      setOrgsLoading(false);
    }
    // supabase is stable across renders for our purposes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    // Refetch the org list every time the dialog opens so a just-installed org
    // shows up (the in-form "install the app then reopen" recovery relies on this).
    if (nextOpen && !orgsLoading) {
      loadOrgs();
    }
  };

  const resetForm = () => {
    setFormData(initialFormData());
    setInstructors([emptyInstructor()]);
  };

  const handleInputChange = (field: string, value: string | number) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const updateInstructor = (id: string, patch: Partial<InstructorRow>) => {
    setInstructors((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addInstructorRow = () => setInstructors((prev) => [...prev, emptyInstructor()]);

  const removeInstructorRow = (id: string) =>
    setInstructors((prev) => (prev.length === 1 ? [emptyInstructor()] : prev.filter((row) => row.id !== id)));

  const lookupInstructor = async (id: string, email: string) => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      updateInstructor(id, { matched: null });
      return;
    }
    updateInstructor(id, { lookupLoading: true });
    // The email may change while this lookup is in flight; only apply the
    // result if the row still holds the email we looked up, but always clear
    // the loading flag so a stale lookup can't leave the spinner stuck.
    const settle = (patch: Partial<InstructorRow> | ((row: InstructorRow) => Partial<InstructorRow>)) =>
      setInstructors((prev) =>
        prev.map((row) => {
          if (row.id !== id) return row;
          if (row.email.trim().toLowerCase() !== trimmed) return { ...row, lookupLoading: false };
          const resolved = typeof patch === "function" ? patch(row) : patch;
          return { ...row, ...resolved, lookupLoading: false };
        })
      );
    try {
      const { data, error } = await supabase.rpc("admin_lookup_user_by_email", { p_email: trimmed });
      if (error) throw error;
      const match = Array.isArray(data) && data.length > 0 ? data[0] : null;
      if (match) {
        // Keep the admin-typed name if the matched user has no stored name,
        // otherwise pre-fill from the match.
        settle((row) => ({ matched: true, name: match.name || row.name, lookupError: null }));
      } else {
        // Genuine empty result: no such user, so the admin should type a name.
        settle({ matched: false, lookupError: null });
      }
    } catch (error) {
      // A thrown error (network, expired session, denied RPC) is NOT the same as
      // "user not found". Surface it and leave matched=null so we don't silently
      // proceed to create a brand-new user for someone who may already exist.
      const message = error instanceof Error ? error.message : "Lookup failed";
      settle({ matched: null, lookupError: message });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Validate required fields
      if (!formData.name.trim() || !formData.term) {
        throw new Error("Name and term are required");
      }
      if (!formData.github_org_name) {
        throw new Error("Please select a GitHub organization. Install the GitHub App if your org is not listed.");
      }
      if (!formData.github_template_prefix.trim()) {
        // The slug (template prefix) is required for GitHub team/repo operations;
        // without it, enrolling staff fails (sync_staff_github_team needs org+slug).
        throw new Error("Template prefix is required (used for GitHub repository names, e.g., hw).");
      }

      // Only rows where an email was entered count as instructors to add.
      const instructorsToAdd = instructors.filter((row) => row.email.trim());
      for (const row of instructorsToAdd) {
        if (!row.name.trim()) {
          throw new Error(`Enter a name for instructor ${row.email.trim()}`);
        }
      }

      const { data: classId, error } = await supabase.rpc("admin_create_class", {
        p_name: formData.name.trim(),
        p_term: formData.term,
        p_description: formData.description.trim() || undefined,
        p_github_org_name: formData.github_org_name,
        p_github_template_prefix: formData.github_template_prefix.trim() || undefined
      });

      if (error) throw error;

      // Enroll instructors via the existing enrollment edge function (handles
      // existing-vs-new users, profile creation, and notifications). The rows are
      // independent, so run them concurrently and collect per-row failures.
      const results = await Promise.allSettled(
        instructorsToAdd.map((row) =>
          enrollmentAdd(
            {
              courseId: Number(classId),
              // Normalize case so an existing user (auth emails are stored
              // lowercased) is matched instead of being re-created as a dup.
              email: row.email.trim().toLowerCase(),
              name: row.name.trim(),
              role: "instructor",
              notify: true
            },
            supabase
          )
        )
      );
      const failures: string[] = [];
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          const reason = result.reason;
          failures.push(
            `${instructorsToAdd[i].email.trim()}: ${reason instanceof Error ? reason.message : "failed to add"}`
          );
        }
      });

      if (failures.length > 0) {
        toaster.create({
          title: "Class created, but some instructors were not added",
          description: failures.join("; "),
          type: "warning"
        });
      } else {
        toaster.create({
          title: "Class Created",
          description: `${formData.name} has been created successfully.`,
          type: "success"
        });
      }

      resetForm();
      setOpen(false);

      // Soft-refresh the server-rendered class list so the new class shows up.
      // (A full window.location.reload() would tear down the toast above before
      // the admin could read which instructors, if any, failed to enroll.)
      router.refresh();
    } catch (error) {
      toaster.create({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create class",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={(e) => handleOpenChange(e.open)}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent maxW="600px">
        <DialogHeader>
          <DialogTitle>Create New Class</DialogTitle>
          <Text color="fg.muted">Add a new class to the system. Fill in the basic information below.</Text>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit}>
            <VStack gap={4}>
              <HStack gap={4} w="full">
                <VStack align="start" flex={1}>
                  <Label htmlFor="name">Class Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => handleInputChange("name", e.target.value)}
                    placeholder="e.g., CS 2500"
                    required
                  />
                </VStack>
                <VStack align="start" flex={1}>
                  <TermSelector
                    value={formData.term}
                    onChange={(value: number) => handleInputChange("term", value)}
                    label="Term"
                    required
                  />
                </VStack>
              </HStack>

              <VStack align="start" w="full">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    handleInputChange("description", e.target.value)
                  }
                  placeholder="Brief description of the course..."
                  rows={3}
                />
              </VStack>

              <VStack align="start" w="full">
                <Label htmlFor="canvas_course_id">Canvas Course ID</Label>
                <Input
                  id="canvas_course_id"
                  value={formData.canvas_course_id}
                  onChange={(e) => handleInputChange("canvas_course_id", e.target.value)}
                  placeholder="e.g., 12345"
                  type="number"
                />
              </VStack>

              <HStack gap={4} w="full" align="start">
                <VStack align="start" flex={1}>
                  <Label htmlFor="github_org_name">GitHub Organization *</Label>
                  {orgsLoading ? (
                    <HStack color="fg.muted" fontSize="sm">
                      <Spinner size="sm" /> <Text>Loading organizations…</Text>
                    </HStack>
                  ) : (
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        id="github_org_name"
                        value={formData.github_org_name}
                        onChange={(e) => handleInputChange("github_org_name", e.target.value)}
                      >
                        <option value="">Select an organization…</option>
                        {(orgs ?? []).map((org) => (
                          <option key={org.installationId} value={org.login}>
                            {org.login}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  )}
                  <Text fontSize="xs" color="fg.muted">
                    {orgsError ? (
                      <Text as="span" color="fg.error">
                        {orgsError}.{" "}
                      </Text>
                    ) : null}
                    Don&apos;t see your org?{" "}
                    <Link href={installUrl} target="_blank" rel="noopener noreferrer" colorPalette="blue">
                      Install the GitHub App
                    </Link>{" "}
                    then reopen this dialog.
                  </Text>
                </VStack>
                <VStack align="start" flex={1}>
                  <Label htmlFor="github_template_prefix">Template Prefix *</Label>
                  <Input
                    id="github_template_prefix"
                    value={formData.github_template_prefix}
                    onChange={(e) => handleInputChange("github_template_prefix", e.target.value)}
                    placeholder="e.g., hw"
                    required
                  />
                </VStack>
              </HStack>

              <VStack align="start" w="full" gap={2}>
                <Label>Instructors</Label>
                <Text fontSize="xs" color="fg.muted">
                  Add instructors by email. If the email matches an existing Pawtograder user, their name is filled in
                  automatically; otherwise enter their name manually.
                </Text>
                {instructors.map((row) => (
                  <Box key={row.id} w="full">
                    <HStack gap={2} w="full" align="start">
                      <VStack align="start" flex={1.2} gap={0.5}>
                        <Input
                          placeholder="instructor@northeastern.edu"
                          type="email"
                          value={row.email}
                          onChange={(e) =>
                            updateInstructor(row.id, { email: e.target.value, matched: null, lookupError: null })
                          }
                          onBlur={(e) => lookupInstructor(row.id, e.target.value)}
                        />
                        {row.lookupLoading ? (
                          <Text fontSize="xs" color="fg.muted">
                            Checking…
                          </Text>
                        ) : row.lookupError ? (
                          <Text fontSize="xs" color="fg.error">
                            Couldn&apos;t check this email ({row.lookupError}) — retry by editing the field.
                          </Text>
                        ) : row.matched === true ? (
                          <Text fontSize="xs" color="fg.success">
                            Matched existing user
                          </Text>
                        ) : row.matched === false ? (
                          <Text fontSize="xs" color="fg.muted">
                            No match — enter name manually
                          </Text>
                        ) : null}
                      </VStack>
                      <Input
                        placeholder="Full name"
                        flex={1}
                        value={row.name}
                        onChange={(e) => updateInstructor(row.id, { name: e.target.value })}
                      />
                      <IconButton
                        aria-label="Remove instructor"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeInstructorRow(row.id)}
                      >
                        <FaTrash />
                      </IconButton>
                    </HStack>
                  </Box>
                ))}
                <Button variant="outline" size="sm" onClick={addInstructorRow} type="button">
                  <FaPlus /> Add instructor
                </Button>
              </VStack>
            </VStack>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isLoading}>
            {isLoading ? "Creating..." : "Create Class"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
