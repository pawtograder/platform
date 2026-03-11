"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Box, Flex, Heading, HStack, Icon, Spinner, Table, Tabs, Text, VStack, Badge } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import { FaChartBar, FaDownload, FaGithub, FaSync, FaTable } from "react-icons/fa";
import { toaster } from "@/components/ui/toaster";
import { getRepositoryAnalytics, requestAnalyticsRefresh, getAnalyticsCsvData } from "./actions";
import { RepositoryDetailView } from "./RepositoryDetailView";
import { AnalyticsChart } from "./AnalyticsChart";

function sanitizeCell(value: unknown): string {
  let str = String(value ?? "");
  str = str.replace(/"/g, '""');
  if (/^[=+\-@\t]/.test(str)) {
    str = "'" + str;
  }
  return str;
}

type RepositorySummary = {
  repository_id: number;
  repository_name: string;
  owner_name: string | null;
  group_name: string | null;
  issues_opened: number;
  issues_closed: number;
  issue_comments: number;
  prs_opened: number;
  pr_review_comments: number;
  commits: number;
  daily: Array<{
    date: string;
    issues_opened: number;
    issues_closed: number;
    issue_comments: number;
    prs_opened: number;
    pr_review_comments: number;
    commits: number;
  }>;
};

type FetchStatus = {
  last_fetched_at: string | null;
  last_requested_at: string | null;
  status: string;
  error_message: string | null;
} | null;

export default function RepositoryAnalyticsPage() {
  const { course_id, assignment_id } = useParams();
  const courseId = Number(course_id);
  const assignmentId = Number(assignment_id);

  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("table");

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getRepositoryAnalytics(courseId, assignmentId);
      setRepositories(data.repositories);
      setFetchStatus(data.fetchStatus);
    } catch (e) {
      toaster.error({ title: "Failed to load analytics", description: String(e) });
    } finally {
      setLoading(false);
    }
  }, [courseId, assignmentId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await requestAnalyticsRefresh(courseId, assignmentId);
      if (result.success) {
        toaster.success({ title: result.message });
        setTimeout(() => loadData(), 5000);
      } else {
        toaster.info({ title: "Rate limited", description: result.message });
      }
    } catch (e) {
      toaster.error({ title: "Refresh failed", description: String(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const data = await getAnalyticsCsvData(courseId, assignmentId);

      // Build daily summary CSV
      const dailyHeaders = [
        "Repository",
        "Owner/Group",
        "Date",
        "Issues Opened",
        "Issues Closed",
        "Issue Comments",
        "PRs Opened",
        "PR Review Comments",
        "Commits"
      ];

      const dailyRows = data.dailyStats.map((row: Record<string, unknown>) => {
        const repo = row.repositories as Record<string, unknown>;
        const profiles = repo?.profiles as Record<string, string> | null;
        const groups = repo?.assignment_groups as Record<string, string> | null;
        return [
          repo?.repository,
          profiles?.name || groups?.name || "",
          row.date,
          row.issues_opened,
          row.issues_closed,
          row.issue_comments,
          row.prs_opened,
          row.pr_review_comments,
          row.commits
        ];
      });

      const dailyCsv = [dailyHeaders.map(sanitizeCell), ...dailyRows.map((r: unknown[]) => r.map(sanitizeCell))]
        .map((row) => row.map((cell: string) => `"${cell}"`).join(","))
        .join("\n");

      // Build items CSV
      const itemHeaders = ["Repository", "Owner/Group", "Type", "GitHub ID", "Title", "Author", "Date", "State", "URL"];

      const itemRows = data.items.map((row: Record<string, unknown>) => {
        const repo = row.repositories as Record<string, unknown>;
        const profiles = repo?.profiles as Record<string, string> | null;
        const groups = repo?.assignment_groups as Record<string, string> | null;
        return [
          repo?.repository,
          profiles?.name || groups?.name || "",
          row.item_type,
          row.github_id,
          row.title || "",
          row.author || "",
          row.created_date,
          row.state || "",
          row.url
        ];
      });

      const itemsCsv = [itemHeaders.map(sanitizeCell), ...itemRows.map((r: unknown[]) => r.map(sanitizeCell))]
        .map((row) => row.map((cell: string) => `"${cell}"`).join(","))
        .join("\n");

      const fullCsv = "\uFEFF" + "DAILY SUMMARY\n" + dailyCsv + "\n\nDETAILED ITEMS\n" + itemsCsv;

      const blob = new Blob([fullCsv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `repository-analytics-${assignmentId}-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toaster.success({ title: "CSV exported" });
    } catch (e) {
      toaster.error({ title: "Export failed", description: String(e) });
    } finally {
      setExporting(false);
    }
  };

  // Aggregate daily data across all repos for chart
  const aggregatedDaily = (() => {
    const dayMap = new Map<
      string,
      {
        date: string;
        issues_opened: number;
        issues_closed: number;
        issue_comments: number;
        prs_opened: number;
        pr_review_comments: number;
        commits: number;
      }
    >();
    for (const repo of repositories) {
      for (const d of repo.daily) {
        const existing = dayMap.get(d.date) || {
          date: d.date,
          issues_opened: 0,
          issues_closed: 0,
          issue_comments: 0,
          prs_opened: 0,
          pr_review_comments: 0,
          commits: 0
        };
        existing.issues_opened += d.issues_opened;
        existing.issues_closed += d.issues_closed;
        existing.issue_comments += d.issue_comments;
        existing.prs_opened += d.prs_opened;
        existing.pr_review_comments += d.pr_review_comments;
        existing.commits += d.commits;
        dayMap.set(d.date, existing);
      }
    }
    return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  if (selectedRepoId) {
    const repo = repositories.find((r) => r.repository_id === selectedRepoId);
    return (
      <RepositoryDetailView
        courseId={courseId}
        repositoryId={selectedRepoId}
        repositoryName={repo?.repository_name || ""}
        ownerName={repo?.owner_name || repo?.group_name || ""}
        onBack={() => setSelectedRepoId(null)}
      />
    );
  }

  return (
    <VStack align="stretch" gap={6} p={4}>
      <Box>
        <Heading size="lg" mb={2}>
          <HStack>
            <Icon as={FaGithub} />
            <Text>Repository Analytics</Text>
          </HStack>
        </Heading>
        <Text color="fg.muted">
          GitHub activity analytics per repository. Track issues, PRs, and commits to audit individual contributions.
        </Text>
      </Box>

      <Flex justify="space-between" align="center" wrap="wrap" gap={3}>
        <HStack gap={3}>
          <Button onClick={handleRefresh} loading={refreshing} variant="outline" size="sm">
            <Icon as={FaSync} mr={2} />
            Refresh Data
          </Button>
          <Button
            onClick={handleExportCsv}
            loading={exporting}
            variant="outline"
            size="sm"
            disabled={repositories.length === 0}
          >
            <Icon as={FaDownload} mr={2} />
            Export CSV
          </Button>
        </HStack>
        {fetchStatus && (
          <HStack gap={2} fontSize="sm" color="fg.muted">
            <Badge
              colorPalette={
                fetchStatus.status === "completed"
                  ? "green"
                  : fetchStatus.status === "fetching"
                    ? "blue"
                    : fetchStatus.status === "error"
                      ? "red"
                      : "gray"
              }
            >
              {fetchStatus.status}
            </Badge>
            {fetchStatus.last_fetched_at && (
              <Text>Last fetched: {new Date(fetchStatus.last_fetched_at).toLocaleString()}</Text>
            )}
          </HStack>
        )}
      </Flex>

      {loading ? (
        <Flex justify="center" py={12}>
          <Spinner size="xl" />
        </Flex>
      ) : repositories.length === 0 ? (
        <Box textAlign="center" py={12}>
          <Text color="fg.muted" fontSize="lg">
            No analytics data yet.
          </Text>
          <Text color="fg.muted" fontSize="sm" mt={2}>
            Click &quot;Refresh Data&quot; to fetch analytics from GitHub.
          </Text>
        </Box>
      ) : (
        <Tabs.Root value={activeTab} onValueChange={(details) => setActiveTab(details.value)} variant="line">
          <Tabs.List>
            <Tabs.Trigger value="table">
              <HStack>
                <Icon as={FaTable} />
                <Text>Repository Table</Text>
              </HStack>
            </Tabs.Trigger>
            <Tabs.Trigger value="chart">
              <HStack>
                <Icon as={FaChartBar} />
                <Text>Activity Chart</Text>
              </HStack>
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="table">
            <Box pt={4} overflowX="auto">
              <Table.Root size="sm" striped>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Repository</Table.ColumnHeader>
                    <Table.ColumnHeader>Owner / Group</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Issues Opened</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Issues Closed</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Issue Comments</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">PRs Opened</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">PR Reviews</Table.ColumnHeader>
                    <Table.ColumnHeader textAlign="right">Commits</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {repositories.map((repo) => (
                    <Table.Row
                      key={repo.repository_id}
                      cursor="pointer"
                      _hover={{ bg: "bg.muted" }}
                      onClick={() => setSelectedRepoId(repo.repository_id)}
                    >
                      <Table.Cell>
                        <Text fontWeight="medium" color="blue.fg" textDecoration="underline">
                          {repo.repository_name.split("/").pop()}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>{repo.owner_name || repo.group_name || "—"}</Table.Cell>
                      <Table.Cell textAlign="right">{repo.issues_opened}</Table.Cell>
                      <Table.Cell textAlign="right">{repo.issues_closed}</Table.Cell>
                      <Table.Cell textAlign="right">{repo.issue_comments}</Table.Cell>
                      <Table.Cell textAlign="right">{repo.prs_opened}</Table.Cell>
                      <Table.Cell textAlign="right">{repo.pr_review_comments}</Table.Cell>
                      <Table.Cell textAlign="right">{repo.commits}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          </Tabs.Content>

          <Tabs.Content value="chart">
            <Box pt={4}>
              <AnalyticsChart data={aggregatedDaily} />
            </Box>
          </Tabs.Content>
        </Tabs.Root>
      )}
    </VStack>
  );
}
