"use client";

import React from "react";
import { useSubmission } from "@/hooks/useSubmission";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { useCourse, useUserRolesWithProfiles } from "@/hooks/useCourseController";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Flex, HStack, Icon, Spinner, Table, Tabs, Text, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { Tooltip } from "@/components/ui/tooltip";
import {
  FaChartBar,
  FaChevronDown,
  FaChevronRight,
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

type FileChange = { filename: string; additions?: number; deletions?: number; status?: string };

type AnalyticsItemData = {
  files?: FileChange[];
  labels?: string[];
  body_preview?: string | null;
  assignees?: string[];
  closed_at?: string | null;
  state_reason?: string | null;
};

type AnalyticsItem = {
  id: number;
  item_type: string;
  github_id: string;
  title: string | null;
  url: string;
  author: string | null;
  created_date: string;
  state: string | null;
  data?: AnalyticsItemData | null;
};

function formatFilesSummary(data: AnalyticsItemData | null | undefined): string | null {
  const files = data?.files;
  if (!files?.length) return null;
  const add = files.reduce((s, f) => s + (f.additions ?? 0), 0);
  const del = files.reduce((s, f) => s + (f.deletions ?? 0), 0);
  return `${files.length} files (+${add} -${del})`;
}

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

/** Ordered so adjacent indices are ~150° apart on the color wheel for maximum contrast. */
const USER_PASTEL_COLORS = [
  "orange.subtle",
  "cyan.subtle",
  "amber.subtle",
  "blue.subtle",
  "yellow.subtle",
  "indigo.subtle",
  "green.subtle",
  "purple.subtle",
  "teal.subtle",
  "pink.subtle"
] as const;

const COLOR_STEP = 7; // Coprime to 10; spreads hash so similar authors get contrasting colors

/** Deterministic color from author string so the same author always gets the same color. */
function getAuthorColor(author: string): string {
  let h = 0;
  const s = author.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  const idx = (Math.abs(h) * COLOR_STEP) % USER_PASTEL_COLORS.length;
  return USER_PASTEL_COLORS[idx];
}

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
  const [submissionsBySha, setSubmissionsBySha] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState("items");
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((id: number) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const userRoles = useUserRolesWithProfiles();
  const githubToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of userRoles) {
      const gh = role.users?.github_username;
      const name = role.profiles?.name;
      if (gh && name) {
        map.set(gh.toLowerCase(), name);
      }
    }
    return map;
  }, [userRoles]);

  const contributionsByUser = useMemo(() => {
    const contributionsByUser = new Map<
      string,
      {
        displayName: string;
        commits: number;
        prs: number;
        issues: number;
        issueComments: number;
        prReviewComments: number;
      }
    >();
    for (const item of items) {
      const key = item.author ?? "—";
      const existing = contributionsByUser.get(key);
      const displayName = key === "—" ? "Unknown" : githubToName.get(key.toLowerCase()) || key;
      const delta = {
        commits: item.item_type === "commit" ? 1 : 0,
        prs: item.item_type === "pr" ? 1 : 0,
        issues: item.item_type === "issue" ? 1 : 0,
        issueComments: item.item_type === "issue_comment" ? 1 : 0,
        prReviewComments: item.item_type === "pr_review_comment" ? 1 : 0
      };
      if (existing) {
        existing.commits += delta.commits;
        existing.prs += delta.prs;
        existing.issues += delta.issues;
        existing.issueComments += delta.issueComments;
        existing.prReviewComments += delta.prReviewComments;
      } else {
        contributionsByUser.set(key, {
          displayName,
          commits: delta.commits,
          prs: delta.prs,
          issues: delta.issues,
          issueComments: delta.issueComments,
          prReviewComments: delta.prReviewComments
        });
      }
    }
    return contributionsByUser;
  }, [items, githubToName]);

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
      const [itemsRes, dailyRes, statusRes, submissionsRes] = await Promise.all([
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
          .maybeSingle(),
        supabase
          .from("submissions")
          .select("id, sha")
          .eq("repository_id", submission.repository_id)
          .eq("assignment_id", submission.assignment_id)
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (dailyRes.error) throw dailyRes.error;
      if (statusRes.error) throw statusRes.error;
      if (submissionsRes.error) throw submissionsRes.error;
      setItems(itemsRes.data?.map((item) => ({
        ...item,
        data: item.data as AnalyticsItemData | null | undefined
      })) ?? []);
      setDaily(dailyRes.data ?? []);
      setFetchStatus(statusRes.data ?? null);
      const shaMap = new Map<string, number>();
      for (const s of submissionsRes.data ?? []) {
        if (s.sha) shaMap.set(s.sha, s.id);
      }
      setSubmissionsBySha(shaMap);
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
        p_repository_id: submission.repository_id || undefined
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
    const csvHeaders = [
      "Type",
      "GitHub ID",
      "Title",
      "Author",
      "Date",
      "State",
      "Files/Changes",
      "Labels",
      "Body Preview",
      "URL"
    ];
    const rows = items.map((item) => [
      TYPE_LABELS[item.item_type] || item.item_type,
      item.github_id,
      item.title || "",
      item.author || "",
      item.created_date,
      item.state || "",
      formatFilesSummary(item.data) || "",
      (item.data?.labels ?? []).join("; ") || "",
      item.data?.body_preview || "",
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
              {contributionsByUser.size > 0 && (
                <Box mb={4}>
                  <Text fontWeight="semibold" mb={2} fontSize="sm">
                    Contributions by user
                  </Text>
                  <Box overflowX="auto">
                    <Table.Root size="sm">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeader w="140px">User</Table.ColumnHeader>
                          <Table.ColumnHeader w="70px" textAlign="right">
                            Commits
                          </Table.ColumnHeader>
                          <Table.ColumnHeader w="70px" textAlign="right">
                            PRs
                          </Table.ColumnHeader>
                          <Table.ColumnHeader w="70px" textAlign="right">
                            Issues
                          </Table.ColumnHeader>
                          <Table.ColumnHeader w="90px" textAlign="right">
                            Issue cmts
                          </Table.ColumnHeader>
                          <Table.ColumnHeader w="90px" textAlign="right">
                            PR cmts
                          </Table.ColumnHeader>
                          <Table.ColumnHeader w="70px" textAlign="right">
                            Total
                          </Table.ColumnHeader>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {[...contributionsByUser.entries()]
                          .sort(([, a], [, b]) => {
                            const totalA = a.commits + a.prs + a.issues + a.issueComments + a.prReviewComments;
                            const totalB = b.commits + b.prs + b.issues + b.issueComments + b.prReviewComments;
                            return totalB - totalA;
                          })
                          .map(([authorKey, stats]) => {
                            const total =
                              stats.commits + stats.prs + stats.issues + stats.issueComments + stats.prReviewComments;
                            const bg = authorKey === "—" ? "bg.subtle" : getAuthorColor(authorKey);
                            return (
                              <Table.Row key={authorKey} bg={bg}>
                                <Table.Cell fontWeight="medium">{stats.displayName}</Table.Cell>
                                <Table.Cell textAlign="right">{stats.commits}</Table.Cell>
                                <Table.Cell textAlign="right">{stats.prs}</Table.Cell>
                                <Table.Cell textAlign="right">{stats.issues}</Table.Cell>
                                <Table.Cell textAlign="right">{stats.issueComments}</Table.Cell>
                                <Table.Cell textAlign="right">{stats.prReviewComments}</Table.Cell>
                                <Table.Cell textAlign="right" fontWeight="semibold">
                                  {total}
                                </Table.Cell>
                              </Table.Row>
                            );
                          })}
                      </Table.Body>
                    </Table.Root>
                  </Box>
                </Box>
              )}
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
                      filteredItems.map((item) => {
                        const rowBg = !item.author ? "bg.subtle" : getAuthorColor(item.author);
                        const hasFiles =
                          (item.item_type === "commit" || item.item_type === "pr") && item.data?.files?.length;
                        const hasIssueData =
                          item.item_type === "issue" &&
                          (item.data?.labels?.length || item.data?.body_preview || item.data?.assignees?.length);
                        const hasExpandable = hasFiles || hasIssueData;
                        const isExpanded = expandedItems.has(item.id);
                        return (
                          <React.Fragment key={item.id}>
                            <Table.Row bg={rowBg}>
                              <Table.Cell>
                                <HStack>
                                  {hasExpandable && (
                                    <Box
                                      as="button"
                                      onClick={() => toggleExpanded(item.id)}
                                      cursor="pointer"
                                      p={0}
                                      lineHeight={1}
                                      aria-label={isExpanded ? "Collapse" : "Expand"}
                                    >
                                      <Icon
                                        as={isExpanded ? FaChevronDown : FaChevronRight}
                                        fontSize="xs"
                                        color="fg.muted"
                                      />
                                    </Box>
                                  )}
                                  <Icon as={TYPE_ICONS[item.item_type] || FaGitAlt} />
                                  <Badge colorPalette={TYPE_COLORS[item.item_type] || "gray"} size="sm">
                                    {TYPE_LABELS[item.item_type] || item.item_type}
                                  </Badge>
                                </HStack>
                              </Table.Cell>
                              <Table.Cell>
                                <VStack align="stretch" gap={1}>
                                  <HStack gap={2} align="center" flexWrap="nowrap">
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
                                    {item.item_type === "commit" && submissionsBySha.has(item.github_id) && (
                                      <Link
                                        href={`/course/${courseId}/assignments/${submission.assignment_id}/submissions/${submissionsBySha.get(item.github_id)}`}
                                        fontSize="xs"
                                        color="blue.fg"
                                        whiteSpace="nowrap"
                                      >
                                        View submission →
                                      </Link>
                                    )}
                                  </HStack>
                                  {hasFiles && (
                                    <Badge size="sm" colorPalette="gray" fontWeight="normal">
                                      {formatFilesSummary(item.data)}
                                    </Badge>
                                  )}
                                  {item.item_type === "issue" && item.data?.labels?.length ? (
                                    <HStack gap={1} flexWrap="wrap">
                                      {item.data.labels.map((l) => (
                                        <Badge key={l} size="sm" colorPalette="blue">
                                          {l}
                                        </Badge>
                                      ))}
                                    </HStack>
                                  ) : null}
                                  {item.item_type === "issue" && item.data?.assignees?.length ? (
                                    <Text fontSize="xs" color="fg.muted">
                                      Assignees: {item.data.assignees.join(", ")}
                                    </Text>
                                  ) : null}
                                </VStack>
                              </Table.Cell>
                              <Table.Cell>
                                <Tooltip
                                  content={item.author ? `GitHub: @${item.author}` : undefined}
                                  disabled={!item.author}
                                >
                                  <Text fontSize="sm" cursor={item.author ? "help" : undefined}>
                                    {item.author ? githubToName.get(item.author.toLowerCase()) || item.author : "—"}
                                  </Text>
                                </Tooltip>
                              </Table.Cell>
                              <Table.Cell>
                                <Tooltip
                                  content={new Date(item.created_date + "T00:00:00").toLocaleString(undefined, {
                                    dateStyle: "full",
                                    timeStyle: "medium"
                                  })}
                                >
                                  <Text fontSize="sm" cursor="help">
                                    {item.created_date}
                                  </Text>
                                </Tooltip>
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
                            {hasExpandable && isExpanded && (
                              <Table.Row key={`${item.id}-detail`} bg={rowBg}>
                                <Table.Cell colSpan={5} py={2} pl={12}>
                                  {hasFiles && item.data?.files?.length ? (
                                    <Box mb={hasIssueData ? 3 : 0}>
                                      <Text fontSize="xs" fontWeight="semibold" mb={2} color="fg.muted">
                                        Files changed
                                      </Text>
                                      <Box as="ul" listStyleType="none" m={0} p={0} fontSize="xs" fontFamily="mono">
                                        {item.data.files.map((f, idx) => (
                                          <Box key={idx} as="li" py={0.5}>
                                            {f.filename}{" "}
                                            <Text as="span" color="green.600">
                                              +{f.additions ?? 0}
                                            </Text>{" "}
                                            <Text as="span" color="red.600">
                                              -{f.deletions ?? 0}
                                            </Text>
                                          </Box>
                                        ))}
                                      </Box>
                                    </Box>
                                  ) : null}
                                  {hasIssueData && item.data?.body_preview ? (
                                    <Box>
                                      <Text fontSize="xs" fontWeight="semibold" mb={2} color="fg.muted">
                                        Body preview
                                      </Text>
                                      <Text fontSize="sm" whiteSpace="pre-wrap" color="fg.muted">
                                        {item.data.body_preview}
                                        {item.data.body_preview.length >= 400 ? "…" : ""}
                                      </Text>
                                    </Box>
                                  ) : null}
                                </Table.Cell>
                              </Table.Row>
                            )}
                          </React.Fragment>
                        );
                      })
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
