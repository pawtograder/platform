"use client";

import { useSubmission } from "@/hooks/useSubmission";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourse } from "@/hooks/useCourseController";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Flex, HStack, Icon, Spinner, Table, Tabs, Text, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import {
  FaChartBar,
  FaCodeBranch,
  FaComment,
  FaDownload,
  FaExclamationCircle,
  FaGitAlt,
  FaList,
  FaSync
} from "react-icons/fa";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { AnalyticsChart } from "@/components/ui/repo-analytics-chart";

const TYPE_ICONS: Record<string, typeof FaGitAlt> = {
  commit: FaGitAlt,
  pr: FaCodeBranch,
  issue: FaExclamationCircle,
  issue_comment: FaComment,
  pr_review_comment: FaComment
};

const TYPE_COLORS: Record<string, string> = {
  commit: "blue",
  pr: "green",
  issue: "yellow",
  issue_comment: "purple",
  pr_review_comment: "orange"
};

const TYPE_LABELS: Record<string, string> = {
  commit: "Commit",
  pr: "Pull Request",
  issue: "Issue",
  issue_comment: "Issue Comment",
  pr_review_comment: "PR Review Comment"
};

type FilterSpec = { item_type: string; state?: string | null } | null;

const KPI_ITEM_TYPE_MAP: Record<string, { item_type: string; state?: string | null }> = {
  commits: { item_type: "commit" },
  prs: { item_type: "pr" },
  prs_opened: { item_type: "pr" },
  prs_closed: { item_type: "pr", state: "closed" },
  pr_review_comments: { item_type: "pr_review_comment" },
  issues: { item_type: "issue" },
  issues_opened: { item_type: "issue" },
  issues_closed: { item_type: "issue", state: "closed" },
  issue_comments: { item_type: "issue_comment" }
};

function computeFilterFromSearchParams(searchParams: URLSearchParams): FilterSpec {
  const kpi_category = searchParams.get("kpi_category");
  if (!kpi_category) return null;
  const spec = KPI_ITEM_TYPE_MAP[kpi_category];
  return spec ?? null;
}

function itemMatchesFilter(item: AnalyticsItem, activeFilter: FilterSpec): boolean {
  if (!activeFilter) return true;
  if (item.item_type !== activeFilter.item_type) return false;
  if (activeFilter.state !== undefined && activeFilter.state !== null) {
    return item.state === activeFilter.state;
  }
  return true;
}

type AnalyticsItem = {
  id: number;
  item_type: string;
  github_id: string;
  title: string | null;
  url: string;
  author: string | null;
  created_date: string;
  state: string | null;
};

type DailyRow = {
  date: string;
  issues_opened: number;
  issues_closed: number;
  issue_comments: number;
  prs_opened: number;
  pr_review_comments: number;
  commits: number;
};

type FetchStatus = {
  last_fetched_at: string | null;
  last_requested_at: string | null;
  status: string;
} | null;

function sanitizeCell(value: unknown): string {
  let str = String(value ?? "");
  str = str.replace(/"/g, '""');
  if (/^[=+\-@\t]/.test(str)) {
    str = "'" + str;
  }
  return str;
}

const ITEM_TYPE_TO_KPI_CATEGORY: Record<string, string> = {
  commit: "commits",
  pr: "prs",
  issue: "issues",
  issue_comment: "issue_comments",
  pr_review_comment: "pr_review_comments"
};

export default function SubmissionRepoAnalyticsPage() {
  const submission = useSubmission();
  const isGraderOrInstructor = useIsGraderOrInstructor();
  const course = useCourse();
  const { course_id } = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const courseId = Number(course_id);
  const supabase = useMemo(() => createClient(), []);

  const activeFilter = useMemo(() => computeFilterFromSearchParams(searchParams), [searchParams]);

  const [items, setItems] = useState<AnalyticsItem[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState("items");

  const setFilterFromKpiCategory = useCallback(
    (kpi_category: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (kpi_category) {
        params.set("kpi_category", kpi_category);
      } else {
        params.delete("kpi_category");
      }
      const qs = params.toString();
      router.replace(pathname + (qs ? `?${qs}` : ""), { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const loadData = useCallback(async () => {
    if (!submission.repository_id) return;
    try {
      setLoading(true);
      const [itemsRes, dailyRes, statusRes] = await Promise.all([
        supabase
          .from("repository_analytics_items")
          .select("*")
          .eq("repository_id", submission.repository_id)
          .order("created_date", { ascending: false }),
        supabase
          .from("repository_analytics_daily")
          .select("*")
          .eq("repository_id", submission.repository_id)
          .order("date", { ascending: true }),
        supabase
          .from("repository_analytics_fetch_status")
          .select("*")
          .eq("assignment_id", submission.assignment_id)
          .eq("repository_id", submission.repository_id)
          .maybeSingle()
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (dailyRes.error) throw dailyRes.error;
      if (statusRes.error) throw statusRes.error;
      setItems(itemsRes.data ?? []);
      setDaily(dailyRes.data ?? []);
      setFetchStatus(statusRes.data ?? null);
    } catch (e) {
      toaster.error({ title: "Failed to load analytics", description: String(e) });
    } finally {
      setLoading(false);
    }
  }, [supabase, submission.repository_id, submission.assignment_id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = async () => {
    if (!course.github_org) {
      toaster.error({ title: "No GitHub org configured for this course" });
      return;
    }
    setRefreshing(true);
    try {
      const { error } = await supabase.rpc("enqueue_repo_analytics_fetch", {
        p_class_id: courseId,
        p_assignment_id: submission.assignment_id,
        p_org: course.github_org,
        p_repository_id: submission.repository_id
      });
      if (error) {
        if (error.message.includes("Rate limited")) {
          toaster.info({ title: "Rate limited", description: error.message });
        } else {
          toaster.error({ title: "Refresh failed", description: error.message });
        }
      } else {
        toaster.success({ title: "Analytics refresh has been queued" });
        setTimeout(() => loadData(), 5000);
      }
    } catch (e) {
      toaster.error({ title: "Refresh failed", description: String(e) });
    } finally {
      setRefreshing(false);
    }
  };

  const handleExportCsv = async () => {
    const csvHeaders = ["Type", "GitHub ID", "Title", "Author", "Date", "State", "URL"];
    const rows = items.map((item) => [
      TYPE_LABELS[item.item_type] || item.item_type,
      item.github_id,
      item.title || "",
      item.author || "",
      item.created_date,
      item.state || "",
      item.url
    ]);
    const csv =
      "\uFEFF" +
      [csvHeaders.map(sanitizeCell), ...rows.map((r) => r.map(sanitizeCell))]
        .map((row) => row.map((cell) => `"${cell}"`).join(","))
        .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `repo-analytics-${submission.repository.split("/").pop()}-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toaster.success({ title: "CSV exported" });
  };

  if (!isGraderOrInstructor) {
    return (
      <Box p={8} textAlign="center">
        <Text color="fg.muted">This tab is only available to instructors and graders.</Text>
      </Box>
    );
  }

  if (!submission.repository_id) {
    return (
      <Box p={8} textAlign="center">
        <Text color="fg.muted">No repository linked to this submission.</Text>
      </Box>
    );
  }

  const filteredItems = activeFilter ? items.filter((i) => itemMatchesFilter(i, activeFilter)) : items;

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Flex justify="space-between" align="center" wrap="wrap" gap={3}>
        <HStack gap={3}>
          <Button onClick={handleRefresh} loading={refreshing} variant="outline" size="sm">
            <Icon as={FaSync} mr={2} />
            Refresh
          </Button>
          <Button onClick={handleExportCsv} variant="outline" size="sm" disabled={items.length === 0}>
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
        <Flex justify="center" py={8}>
          <Spinner size="xl" />
        </Flex>
      ) : items.length === 0 ? (
        <Box textAlign="center" py={8}>
          <Text color="fg.muted">No analytics data yet. Click &quot;Refresh&quot; to fetch from GitHub.</Text>
        </Box>
      ) : (
        <Tabs.Root value={activeTab} onValueChange={(d) => setActiveTab(d.value)} variant="line">
          <Tabs.List>
            <Tabs.Trigger value="items">
              <HStack>
                <Icon as={FaList} />
                <Text>Items ({filteredItems.length})</Text>
              </HStack>
            </Tabs.Trigger>
            <Tabs.Trigger value="chart">
              <HStack>
                <Icon as={FaChartBar} />
                <Text>Activity Chart</Text>
              </HStack>
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="items">
            <Box pt={4}>
              <HStack gap={2} mb={4} flexWrap="wrap">
                <Button
                  size="xs"
                  variant={activeFilter === null ? "solid" : "outline"}
                  onClick={() => setFilterFromKpiCategory(null)}
                >
                  All ({items.length})
                </Button>
                {["commit", "pr", "issue", "issue_comment", "pr_review_comment"].map((type) => {
                  const kpiCategory = ITEM_TYPE_TO_KPI_CATEGORY[type];
                  const count = items.filter((i) =>
                    itemMatchesFilter(i, kpiCategory ? (KPI_ITEM_TYPE_MAP[kpiCategory] ?? null) : null)
                  ).length;
                  if (count === 0) return null;
                  const isActive =
                    activeFilter?.item_type === type &&
                    (activeFilter.state === undefined || activeFilter.state === null);
                  return (
                    <Button
                      key={type}
                      size="xs"
                      variant={isActive ? "solid" : "outline"}
                      onClick={() => setFilterFromKpiCategory(kpiCategory)}
                    >
                      {TYPE_LABELS[type]} ({count})
                    </Button>
                  );
                })}
              </HStack>

              <Box overflowX="auto">
                <Table.Root size="sm">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeader w="120px">Type</Table.ColumnHeader>
                      <Table.ColumnHeader>Title / Message</Table.ColumnHeader>
                      <Table.ColumnHeader w="120px">Author</Table.ColumnHeader>
                      <Table.ColumnHeader w="100px">Date</Table.ColumnHeader>
                      <Table.ColumnHeader w="80px">State</Table.ColumnHeader>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {filteredItems.length === 0 ? (
                      <Table.Row>
                        <Table.Cell colSpan={5}>
                          <Text textAlign="center" color="fg.muted" py={4}>
                            No items found
                          </Text>
                        </Table.Cell>
                      </Table.Row>
                    ) : (
                      filteredItems.map((item) => (
                        <Table.Row key={item.id}>
                          <Table.Cell>
                            <HStack>
                              <Icon as={TYPE_ICONS[item.item_type] || FaGitAlt} />
                              <Badge colorPalette={TYPE_COLORS[item.item_type] || "gray"} size="sm">
                                {TYPE_LABELS[item.item_type] || item.item_type}
                              </Badge>
                            </HStack>
                          </Table.Cell>
                          <Table.Cell>
                            <Link
                              href={item.url}
                              target="_blank"
                              color="blue.fg"
                              fontSize="sm"
                              display="block"
                              maxW="500px"
                              overflow="hidden"
                              textOverflow="ellipsis"
                              whiteSpace="nowrap"
                            >
                              {item.item_type === "commit"
                                ? `${item.github_id.substring(0, 7)} — ${item.title || "No message"}`
                                : item.item_type === "pr" || item.item_type === "issue"
                                  ? `#${item.github_id} — ${item.title || "No title"}`
                                  : item.title || "View on GitHub"}
                            </Link>
                          </Table.Cell>
                          <Table.Cell>
                            <Text fontSize="sm">{item.author || "—"}</Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Text fontSize="sm">{item.created_date}</Text>
                          </Table.Cell>
                          <Table.Cell>
                            {item.state && (
                              <Badge
                                size="sm"
                                colorPalette={
                                  item.state === "open" ? "green" : item.state === "closed" ? "red" : "gray"
                                }
                              >
                                {item.state}
                              </Badge>
                            )}
                          </Table.Cell>
                        </Table.Row>
                      ))
                    )}
                  </Table.Body>
                </Table.Root>
              </Box>
            </Box>
          </Tabs.Content>

          <Tabs.Content value="chart">
            <Box pt={4}>
              <AnalyticsChart data={daily} />
            </Box>
          </Tabs.Content>
        </Tabs.Root>
      )}
    </VStack>
  );
}
