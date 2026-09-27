import { createClient } from "@/utils/supabase/server";
import { Badge, Flex, Heading, Table, Text, VStack } from "@chakra-ui/react";
import Link from "next/link";

export const metadata = {
  title: "GitHub Orgs"
};

/**
 * Admin per-org dashboard: lists every GitHub org (configured rows plus any org
 * referenced by a class) with its default template repos and course count.
 */
export default async function GitHubOrgsPage() {
  const supabase = await createClient();
  const { data: orgs, error } = await supabase.rpc("admin_get_github_orgs");

  return (
    <VStack align="stretch" gap={6}>
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">GitHub Orgs</Heading>
          <Text color="fg.muted">
            Configure default handout and solution template repositories per GitHub org. Instructors can override these
            per class.
          </Text>
        </VStack>
      </Flex>

      {error && <Text color="fg.error">Failed to load orgs: {error.message}</Text>}

      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Org</Table.ColumnHeader>
            <Table.ColumnHeader>Courses</Table.ColumnHeader>
            <Table.ColumnHeader>Default handout template</Table.ColumnHeader>
            <Table.ColumnHeader>Default solution template</Table.ColumnHeader>
            <Table.ColumnHeader>Status</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {(orgs ?? []).map((org) => (
            <Table.Row key={org.org_name}>
              <Table.Cell>
                <Link href={`/admin/github-orgs/${encodeURIComponent(org.org_name)}`}>
                  <Text color="blue.fg" fontWeight="medium">
                    {org.org_name}
                  </Text>
                </Link>
              </Table.Cell>
              <Table.Cell>{org.course_count}</Table.Cell>
              <Table.Cell>
                <Text fontFamily="mono" fontSize="sm">
                  {org.default_handout_template_repo}
                </Text>
              </Table.Cell>
              <Table.Cell>
                <Text fontFamily="mono" fontSize="sm">
                  {org.default_solution_template_repo}
                </Text>
              </Table.Cell>
              <Table.Cell>
                {org.is_configured ? (
                  <Badge colorPalette="green">Configured</Badge>
                ) : (
                  <Badge colorPalette="gray">Using defaults</Badge>
                )}
              </Table.Cell>
            </Table.Row>
          ))}
          {(orgs ?? []).length === 0 && !error && (
            <Table.Row>
              <Table.Cell colSpan={5}>
                <Text color="fg.muted">No GitHub orgs found.</Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>
    </VStack>
  );
}
