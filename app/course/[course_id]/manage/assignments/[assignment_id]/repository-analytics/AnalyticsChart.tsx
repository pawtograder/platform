"use client";

import { Box, Text } from "@chakra-ui/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from "@/components/ui/recharts-wrapper";

type DailyData = {
  date: string;
  issues_opened: number;
  issues_closed: number;
  issue_comments: number;
  prs_opened: number;
  pr_review_comments: number;
  commits: number;
};

export function AnalyticsChart({ data }: { data: DailyData[] }) {
  if (data.length === 0) {
    return (
      <Box textAlign="center" py={8}>
        <Text color="fg.muted">No data to display</Text>
      </Box>
    );
  }

  return (
    <Box w="100%" h="400px">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" fontSize={12} />
          <YAxis />
          <Tooltip />
          <Legend />
          <Bar dataKey="commits" name="Commits" fill="#3182CE" stackId="a" />
          <Bar dataKey="prs_opened" name="PRs Opened" fill="#38A169" stackId="a" />
          <Bar dataKey="issues_opened" name="Issues Opened" fill="#D69E2E" stackId="a" />
          <Bar dataKey="issues_closed" name="Issues Closed" fill="#E53E3E" stackId="a" />
          <Bar dataKey="issue_comments" name="Issue Comments" fill="#805AD5" stackId="a" />
          <Bar dataKey="pr_review_comments" name="PR Reviews" fill="#DD6B20" stackId="a" />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
