"use client";

import { useColorModeValue } from "@/components/ui/color-mode";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "@/components/ui/recharts-wrapper";
import {
  ALL_SECTIONS_FILTER,
  buildScoreHistogram,
  collectSectionOptions,
  filterRowsBySection,
  type HistogramBin
} from "@/lib/assignmentDashboardStats";
import { computeScoreStats, formatStat, type ScoreStats } from "@/lib/scoreStats";
import TableController, { useIsTableControllerReady, useTableControllerTableValues } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  Box,
  CardBody,
  CardRoot,
  Heading,
  HStack,
  Link,
  NativeSelect,
  SimpleGrid,
  Spinner,
  Stat,
  Text,
  VStack
} from "@chakra-ui/react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import AssignmentsTable from "./assignmentsTable";
import GradingStatusPanel from "./GradingStatusPanel";
import RubricReport from "./RubricReport";

type AssignmentDashboardProps = {
  tableController: TableController<"submissions"> | null;
};

/** Subset of the submissions_with_grades_for_assignment_nice view used here. */
type DashboardRow = {
  total_score?: number | null;
  autograder_score?: number | null;
  completed_at?: string | null;
  released?: boolean | null;
  class_section_name?: string | null;
  lab_section_name?: string | null;
  ordinal?: number | null;
};

function StatRow({ label, stats }: { label: string; stats: ScoreStats }) {
  return (
    <CardRoot variant="subtle">
      <CardBody>
        <Text fontWeight="medium" mb={2}>
          {label}
        </Text>
        <HStack gap={8} wrap="wrap">
          <Stat.Root>
            <Stat.Label>Min</Stat.Label>
            <Stat.ValueText>{formatStat(stats.min)}</Stat.ValueText>
          </Stat.Root>
          <Stat.Root>
            <Stat.Label>Average</Stat.Label>
            <Stat.ValueText>{formatStat(stats.mean)}</Stat.ValueText>
          </Stat.Root>
          <Stat.Root>
            <Stat.Label>Max</Stat.Label>
            <Stat.ValueText>{formatStat(stats.max)}</Stat.ValueText>
          </Stat.Root>
          <Stat.Root>
            <Stat.Label>Graded</Stat.Label>
            <Stat.ValueText>{stats.count}</Stat.ValueText>
          </Stat.Root>
        </HStack>
      </CardBody>
    </CardRoot>
  );
}

function ScoreHistogram({
  title,
  data,
  fill,
  tickColor,
  tooltipBg
}: {
  title: string;
  data: HistogramBin[];
  fill: string;
  tickColor: string;
  tooltipBg: string;
}) {
  return (
    <Box>
      <Heading size="sm" mb={2}>
        {title}
      </Heading>
      {data.length > 0 ? (
        <Box w="100%">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="name"
                tick={{ fill: tickColor }}
                label={{ value: "Score", position: "insideBottom", offset: -5 }}
              />
              <YAxis tick={{ fill: tickColor }} label={{ value: "Students", angle: -90, position: "insideLeft" }} />
              <Tooltip
                contentStyle={{ backgroundColor: tooltipBg }}
                formatter={(value: number) => [value, "Students"]}
              />
              <Bar dataKey="value" fill={fill} />
            </BarChart>
          </ResponsiveContainer>
        </Box>
      ) : (
        <Text color="fg.muted">No score data available.</Text>
      )}
    </Box>
  );
}

export default function AssignmentDashboard({ tableController }: AssignmentDashboardProps) {
  const tickColor = useColorModeValue("black", "white");
  const tooltipBg = useColorModeValue("white", "#1A1A1A");
  const { course_id, assignment_id } = useParams();
  const supabase = useMemo(() => createClient(), []);

  const rawRows = useTableControllerTableValues(tableController ?? undefined);
  const rows = rawRows as DashboardRow[];
  const isReady = useIsTableControllerReady(tableController ?? undefined);

  const [filter, setFilter] = useState<string>(ALL_SECTIONS_FILTER);

  // Distinct section / lab names for the filter control.
  const { classSections, labSections } = useMemo(() => collectSectionOptions(rows), [rows]);

  // Rows matching the active section/lab filter.
  const filteredRows = useMemo(() => filterRowsBySection(rows, filter), [rows, filter]);

  const totalScoreStats = useMemo(() => computeScoreStats(filteredRows.map((r) => r.total_score)), [filteredRows]);
  const autograderStats = useMemo(() => computeScoreStats(filteredRows.map((r) => r.autograder_score)), [filteredRows]);
  const totalHistogram = useMemo(() => buildScoreHistogram(filteredRows.map((r) => r.total_score)), [filteredRows]);
  const autograderHistogram = useMemo(
    () => buildScoreHistogram(filteredRows.map((r) => r.autograder_score)),
    [filteredRows]
  );

  if (!isReady) {
    return <Spinner />;
  }

  const repositoriesHref = `/course/${course_id}/manage/assignments/${assignment_id}/repositories`;

  return (
    <VStack align="stretch" gap={8} p={4}>
      <GradingStatusPanel
        rows={rows}
        assignmentId={Number(assignment_id)}
        supabase={supabase}
        onChanged={() => tableController?.refetchAll()}
      />

      <Box>
        <HStack justify="space-between" align="center" mb={4} wrap="wrap" gap={3}>
          <Heading size="md">Score statistics</Heading>
          <HStack gap={2}>
            <Text fontSize="sm" color="fg.muted">
              Filter:
            </Text>
            <NativeSelect.Root size="sm" maxW="2xs" width="auto">
              <NativeSelect.Field value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value={ALL_SECTIONS_FILTER}>All students</option>
                {classSections.length > 0 && (
                  <optgroup label="Class section">
                    {classSections.map((name) => (
                      <option key={`class:${name}`} value={`class:${name}`}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {labSections.length > 0 && (
                  <optgroup label="Lab section">
                    {labSections.map((name) => (
                      <option key={`lab:${name}`} value={`lab:${name}`}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </HStack>
        </HStack>
        <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
          <StatRow label="Total score" stats={totalScoreStats} />
          <StatRow label="Autograder score" stats={autograderStats} />
        </SimpleGrid>
        <SimpleGrid columns={{ base: 1, md: 2 }} gap={6} mt={6}>
          <ScoreHistogram
            title="Total score distribution"
            data={totalHistogram}
            fill="#8884d8"
            tickColor={tickColor}
            tooltipBg={tooltipBg}
          />
          <ScoreHistogram
            title="Autograder score distribution"
            data={autograderHistogram}
            fill="#82ca9d"
            tickColor={tickColor}
            tooltipBg={tooltipBg}
          />
        </SimpleGrid>
      </Box>

      <CardRoot variant="subtle">
        <CardBody>
          <RubricReport assignmentId={Number(assignment_id)} classSections={classSections} labSections={labSections} />
        </CardBody>
      </CardRoot>

      <Box>
        <Heading size="md" mb={1}>
          Submissions
        </Heading>
        <Text fontSize="sm" color="fg.muted" mb={3}>
          Only students who have made a submission appear here. To see every student&apos;s repository, visit the{" "}
          <Link asChild color="fg.info">
            <NextLink href={repositoriesHref}>Repository Status</NextLink>
          </Link>{" "}
          page.
        </Text>
        <AssignmentsTable tableController={tableController} />
      </Box>
    </VStack>
  );
}
