"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Badge, Flex, Heading, HStack, Icon, Spinner, Table, Tabs, Text, VStack } from "@chakra-ui/react";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import {
  FaArrowLeft,
  FaCodeBranch,
  FaComment,
  FaExclamationCircle,
  FaGitAlt,
  FaChartBar,
  FaList
} from "react-icons/fa";
import { toaster } from "@/components/ui/toaster";
import { getRepositoryAnalyticsDetail } from "./actions";
import { AnalyticsChart } from "./AnalyticsChart";

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

export function RepositoryDetailView({
  courseId,
  repositoryId,
  repositoryName,
  ownerName,
  onBack
}: {
  courseId: number;
  repositoryId: number;
  repositoryName: string;
  ownerName: string;
  onBack: () => void;
}) {
  const [items, setItems] = useState<AnalyticsItem[]>([]);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("items");

  const loadDetail = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getRepositoryAnalyticsDetail(courseId, repositoryId);
      setItems(data.items);
      setDaily(data.daily);
    } catch (e) {
      toaster.error({ title: "Failed to load details", description: String(e) });
    } finally {
      setLoading(false);
    }
  }, [courseId, repositoryId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const filteredItems = filterType ? items.filter((i) => i.item_type === filterType) : items;

  const repoShortName = repositoryName.split("/").pop() || repositoryName;
  const githubUrl = `https://github.com/${repositoryName}`;

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Box>
        <Button variant="ghost" size="sm" onClick={onBack} mb={2}>
          <Icon as={FaArrowLeft} mr={2} />
          Back to Overview
        </Button>
        <Heading size="lg">
          <HStack>
            <Link href={githubUrl} target="_blank" color="blue.fg">
              {repoShortName}
            </Link>
          </HStack>
        </Heading>
        {ownerName && (
          <Text color="fg.muted" fontSize="sm">
            {ownerName}
          </Text>
        )}
      </Box>

      {loading ? (
        <Flex justify="center" py={12}>
          <Spinner size="xl" />
        </Flex>
      ) : (
        <Tabs.Root value={activeTab} onValueChange={(details) => setActiveTab(details.value)} variant="line">
          <Tabs.List>
            <Tabs.Trigger value="items">
              <HStack>
                <Icon as={FaList} />
                <Text>All Items ({filteredItems.length})</Text>
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
                  variant={filterType === null ? "solid" : "outline"}
                  onClick={() => setFilterType(null)}
                >
                  All ({items.length})
                </Button>
                {["commit", "pr", "issue", "issue_comment", "pr_review_comment"].map((type) => {
                  const count = items.filter((i) => i.item_type === type).length;
                  if (count === 0) return null;
                  return (
                    <Button
                      key={type}
                      size="xs"
                      variant={filterType === type ? "solid" : "outline"}
                      onClick={() => setFilterType(type)}
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
                              <Icon
                                as={TYPE_ICONS[item.item_type] || FaGitAlt}
                                color={`${TYPE_COLORS[item.item_type] || "gray"}.fg`}
                              />
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
