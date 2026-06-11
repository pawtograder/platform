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
  Button,
  CardBody,
  CardRoot,
  Collapsible,
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
  released?: boolean | string | null;
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
  tooltipBg,
  xLabel
}: {
  title: string;
  data: HistogramBin[];
  fill: string;
  tickColor: string;
  tooltipBg: string;
  xLabel?: string;
}) {
  return (
    <Box>
      <Heading size="sm" mb={2}>
        {title}
      </Heading>
      {data.length > 0 ? (
        <Box w="100%">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="name"
                tick={{ fill: tickColor }}
                label={{ value: xLabel ?? "Score", position: "insideBottom", offset: -5 }}
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
        <Text color="fg.muted">No data available.</Text>
      )}
    </Box>
  );
}

/** A tiny axis-less bar chart used as a sparkline inside the compact stat tiles. */
function Sparkbars({ data, fill }: { data: HistogramBin[]; fill: string }) {
  if (data.length === 0) {
    return (
      <Box h="40px" display="flex" alignItems="center">
        <Text fontSize="xs" color="fg.muted">
          no data
        </Text>
      </Box>
    );
  }
  return (
    <Box w="100%" h="40px">
      <ResponsiveContainer width="100%" height={40}>
        <BarChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <Bar dataKey="value" fill={fill} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}

/** Compact stat tile: label, average (big), min–max + n, and a sparkline. */
function StatTile({
  label,
  stats,
  data,
  fill
}: {
  label: string;
  stats: ScoreStats;
  data: HistogramBin[];
  fill: string;
}) {
  return (
    <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" px={3} py={2}>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
      <HStack align="baseline" gap={1.5} mb={1}>
        <Text fontSize="lg" fontWeight="semibold" lineHeight="1.1">
          {formatStat(stats.mean)}
        </Text>
        <Text fontSize="xs" color="fg.muted">
          avg · {formatStat(stats.min)}–{formatStat(stats.max)} · n={stats.count}
        </Text>
      </HStack>
      <Sparkbars data={data} fill={fill} />
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
  const [statsExpanded, setStatsExpanded] = useState(false);
  // Rubric breakdown is collapsed by default and only mounts (and hits its RPC) once opened.
  const [rubricOpen, setRubricOpen] = useState(false);
  const [rubricEverOpened, setRubricEverOpened] = useState(false);
  // Cohort pushed from the rubric report to filter the submissions table (button or drill-in).
  const [tableCohort, setTableCohort] = useState<{ ids: number[]; label: string } | null>(null);

  // Distinct section / lab names for the filter control.
  const { classSections, labSections } = useMemo(() => collectSectionOptions(rows), [rows]);

  // Rows matching the active section/lab filter.
  const filteredRows = useMemo(() => filterRowsBySection(rows, filter), [rows, filter]);

  const totalScoreStats = useMemo(() => computeScoreStats(filteredRows.map((r) => r.total_score)), [filteredRows]);
  const autograderStats = useMemo(() => computeScoreStats(filteredRows.map((r) => r.autograder_score)), [filteredRows]);
  const submissionStats = useMemo(() => computeScoreStats(filteredRows.map((r) => r.ordinal)), [filteredRows]);
  const totalHistogram = useMemo(() => buildScoreHistogram(filteredRows.map((r) => r.total_score)), [filteredRows]);
  const autograderHistogram = useMemo(
    () => buildScoreHistogram(filteredRows.map((r) => r.autograder_score)),
    [filteredRows]
  );
  const submissionHistogram = useMemo(() => buildScoreHistogram(filteredRows.map((r) => r.ordinal)), [filteredRows]);

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
        {/* Compact, single-row summary (sparklines). */}
        <SimpleGrid columns={{ base: 1, sm: 3 }} gap={3}>
          <StatTile label="Total score" stats={totalScoreStats} data={totalHistogram} fill="#8884d8" />
          <StatTile label="Autograder score" stats={autograderStats} data={autograderHistogram} fill="#82ca9d" />
          <StatTile label="Submissions / student" stats={submissionStats} data={submissionHistogram} fill="#f6ad55" />
        </SimpleGrid>

        <Collapsible.Root open={statsExpanded} onOpenChange={(e) => setStatsExpanded(e.open)}>
          <Collapsible.Trigger asChild>
            <Button size="xs" variant="ghost" mt={2}>
              {statsExpanded ? "Hide detailed distributions ▾" : "Show detailed distributions ▸"}
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <SimpleGrid columns={{ base: 1, md: 3 }} gap={4} mt={3}>
              <StatRow label="Total score" stats={totalScoreStats} />
              <StatRow label="Autograder score" stats={autograderStats} />
              <StatRow label="Submissions / student" stats={submissionStats} />
            </SimpleGrid>
            <SimpleGrid columns={{ base: 1, md: 3 }} gap={6} mt={6}>
              <ScoreHistogram
                title="Total score"
                data={totalHistogram}
                fill="#8884d8"
                tickColor={tickColor}
                tooltipBg={tooltipBg}
              />
              <ScoreHistogram
                title="Autograder score"
                data={autograderHistogram}
                fill="#82ca9d"
                tickColor={tickColor}
                tooltipBg={tooltipBg}
              />
              <ScoreHistogram
                title="Submissions per student"
                data={submissionHistogram}
                fill="#f6ad55"
                tickColor={tickColor}
                tooltipBg={tooltipBg}
                xLabel="# submissions"
              />
            </SimpleGrid>
          </Collapsible.Content>
        </Collapsible.Root>
      </Box>

      <CardRoot variant="subtle">
        <CardBody py={2.5}>
          <Collapsible.Root
            open={rubricOpen}
            onOpenChange={(e) => {
              setRubricOpen(e.open);
              if (e.open) setRubricEverOpened(true);
            }}
          >
            <Collapsible.Trigger asChild>
              <Button variant="ghost" size="sm" width="100%" justifyContent="space-between">
                <Text fontWeight="medium">Rubric breakdown</Text>
                <Text color="fg.muted">{rubricOpen ? "▾" : "▸"}</Text>
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              <Box pt={3}>
                {rubricEverOpened && (
                  <RubricReport
                    assignmentId={Number(assignment_id)}
                    classSections={classSections}
                    labSections={labSections}
                    onApplyCohort={(ids, label) => setTableCohort({ ids, label })}
                  />
                )}
              </Box>
            </Collapsible.Content>
          </Collapsible.Root>
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
        {tableCohort && (
          <HStack mb={3} p={2} px={3} borderRadius="md" bg="bg.info" justify="space-between" wrap="wrap" gap={2}>
            <Text fontSize="sm">
              Showing <strong>{tableCohort.ids.length}</strong> student{tableCohort.ids.length === 1 ? "" : "s"} —{" "}
              {tableCohort.label}.
            </Text>
            <Button size="xs" variant="outline" onClick={() => setTableCohort(null)}>
              Clear filter
            </Button>
          </HStack>
        )}
        <AssignmentsTable tableController={tableController} restrictRowIds={tableCohort?.ids ?? null} />
      </Box>
    </VStack>
  );
}
