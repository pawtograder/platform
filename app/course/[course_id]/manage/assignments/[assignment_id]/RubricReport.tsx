"use client";

import { useRubric, useRubricChecksByRubric, useRubricCriteriaByRubric } from "@/hooks/useAssignment";
import { useRubricReport, useRubricReportBySection, type RubricReportData } from "@/lib/rubricReport/useRubricReport";
import { useAssignmentDashboardView, type DashboardViewConfig } from "@/lib/rubricReport/useAssignmentDashboardView";
import type { RubricFilter } from "@/lib/rubricReport/filterSchema";
import { toaster } from "@/components/ui/toaster";
import type { RubricChecksDataType } from "@/utils/supabase/DatabaseTypes";
import {
  Box,
  Button,
  ButtonGroup,
  Collapsible,
  HStack,
  Heading,
  Popover,
  Progress,
  Spinner,
  Table,
  Text,
  VStack
} from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import RubricReportFilterBuilder, { type CheckOption } from "./RubricReportFilterBuilder";

type GroupNode = { op: "and" | "or" | "not"; args: RubricFilter[] };
type Viz = "bars" | "options" | "table" | "section";

const asGroup = (f: RubricFilter | null | undefined): GroupNode =>
  f && "op" in f ? (f as GroupNode) : f ? { op: "and", args: [f] } : { op: "and", args: [] };

const EMPTY_FILTER: GroupNode = { op: "and", args: [] };

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

/** A horizontal labeled application-rate bar. */
function RateBar({
  label,
  count,
  total,
  colorPalette = "blue"
}: {
  label: string;
  count: number;
  total: number;
  colorPalette?: string;
}) {
  return (
    <Box>
      <HStack justify="space-between" mb={0.5}>
        <Text fontSize="sm">{label}</Text>
        <Text fontSize="xs" color="fg.muted">
          {count}/{total} ({pct(count, total)}%)
        </Text>
      </HStack>
      <Progress.Root value={pct(count, total)} colorPalette={colorPalette} size="sm">
        <Progress.Track>
          <Progress.Range />
        </Progress.Track>
      </Progress.Root>
    </Box>
  );
}

export default function RubricReport({
  assignmentId,
  classSections,
  labSections
}: {
  assignmentId: number;
  classSections: string[];
  labSections: string[];
}) {
  const gradingRubric = useRubric("grading-review");
  const criteria = useRubricCriteriaByRubric(gradingRubric?.id);
  const checks = useRubricChecksByRubric(gradingRubric?.id);

  const [viz, setViz] = useState<Viz>("bars");
  const [filter, setFilter] = useState<GroupNode>(EMPTY_FILTER);

  // Shared, per-assignment saved default view.
  const { saved, save } = useAssignmentDashboardView(assignmentId);
  const [isSaving, setIsSaving] = useState(false);
  const appliedSavedRef = useRef(false);

  // Apply the saved default once, on first load, as the initial "what I'm seeing".
  // Subsequent local edits are ephemeral until the instructor saves them as the default.
  useEffect(() => {
    if (saved && !appliedSavedRef.current) {
      appliedSavedRef.current = true;
      setViz(saved.config.viz);
      setFilter(asGroup(saved.config.filter));
    }
  }, [saved]);

  const applyConfig = (config: DashboardViewConfig) => {
    setViz(config.viz);
    setFilter(asGroup(config.filter));
  };

  const saveAsDefault = async () => {
    setIsSaving(true);
    const result = await save({ viz, filter });
    setIsSaving(false);
    if (result.ok) {
      toaster.success({ title: "Shared default view saved", description: "All staff will see this view by default." });
    } else {
      toaster.error({ title: "Couldn't save default view", description: result.error ?? "Unknown error" });
    }
  };

  // Build display metadata for each check: name, criterion, and option labels.
  const checkOptions: CheckOption[] = useMemo(() => {
    const criterionName = new Map(criteria.map((c) => [c.id, c.name]));
    return [...checks]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((c) => {
        const data = c.data as RubricChecksDataType | null;
        const options = (data?.options ?? []).map((o, index) => ({ index, label: o.label ?? `Option ${index + 1}` }));
        return {
          id: Number(c.id),
          name: c.name,
          criterionName: criterionName.get(c.rubric_criteria_id) ?? "Ungrouped",
          options
        };
      });
  }, [checks, criteria]);

  const { data, isLoading, error } = useRubricReport(assignmentId, filter);

  // Section comparison data (only fetched when that view is active and sections exist).
  const sectionParams = useMemo(
    () => (viz === "section" ? classSections.map((s) => ({ key: s, filter: { section: s } as RubricFilter })) : []),
    [viz, classSections]
  );
  const { byKey: bySection, isLoading: sectionLoading } = useRubricReportBySection(assignmentId, sectionParams);

  const statById = useMemo(() => new Map((data?.checks ?? []).map((c) => [c.rubric_check_id, c])), [data]);
  const cohortTotal = data?.cohort_total ?? 0;

  // Quick filter: jump straight to a criterion (OR of its checks) or a single check.
  const onQuickFilter = (value: string) => {
    if (value === "none") return setFilter(EMPTY_FILTER);
    const [kind, idStr] = value.split(":");
    const id = Number(idStr);
    if (kind === "criterion") {
      const ids = checkOptions
        .filter((c) => criteria.find((cr) => cr.id === id && cr.name === c.criterionName))
        .map((c) => c.id);
      const memberIds = checks.filter((c) => c.rubric_criteria_id === id).map((c) => Number(c.id));
      const useIds = memberIds.length > 0 ? memberIds : ids;
      setFilter({ op: "or", args: useIds.map((cid) => ({ checkApplied: cid })) });
    } else if (kind === "check") {
      setFilter({ op: "and", args: [{ checkApplied: id }] });
    }
  };

  if (!gradingRubric) {
    return (
      <Box>
        <Heading size="md" mb={1}>
          Rubric breakdown
        </Heading>
        <Text color="fg.muted" fontSize="sm">
          This assignment has no grading rubric yet.
        </Text>
      </Box>
    );
  }

  // Group checks by criterion for the bar view.
  const byCriterion = checkOptions.reduce<Record<string, CheckOption[]>>((acc, c) => {
    (acc[c.criterionName] ??= []).push(c);
    return acc;
  }, {});

  return (
    <Box>
      <HStack justify="space-between" align="center" mb={2} wrap="wrap" gap={3}>
        <Text fontSize="sm" color="fg.muted">
          {cohortTotal} submission{cohortTotal === 1 ? "" : "s"} in cohort
        </Text>
        <HStack gap={2} wrap="wrap">
          <NativeQuickFilter criteria={criteria} checks={checkOptions} onChange={onQuickFilter} />
          <ButtonGroup size="xs" variant="outline" attached>
            {(["bars", "options", "table", "section"] as Viz[]).map((v) => (
              <Button key={v} onClick={() => setViz(v)} variant={viz === v ? "solid" : "outline"}>
                {v === "bars" ? "Bars" : v === "options" ? "Options" : v === "table" ? "Table" : "By section"}
              </Button>
            ))}
          </ButtonGroup>
        </HStack>
      </HStack>

      <HStack justify="space-between" align="center" mb={2} wrap="wrap" gap={2}>
        <Text fontSize="xs" color="fg.muted">
          {saved
            ? `Shared default saved by ${saved.savedByName ?? "staff"} · ${new Date(saved.updatedAt).toLocaleString()}`
            : "No shared default saved yet — you're viewing an unsaved view."}
        </Text>
        <HStack gap={2}>
          {saved && (
            <Button size="xs" variant="ghost" onClick={() => applyConfig(saved.config)}>
              Reset to default
            </Button>
          )}
          <Popover.Root>
            <Popover.Trigger asChild>
              <Button size="xs" variant="subtle" colorPalette="blue" loading={isSaving}>
                Save as default
              </Button>
            </Popover.Trigger>
            <Popover.Positioner>
              <Popover.Content>
                <Popover.Arrow>
                  <Popover.ArrowTip />
                </Popover.Arrow>
                <Popover.Header>Update the shared default view?</Popover.Header>
                <Popover.Body>
                  <VStack align="stretch" gap={3}>
                    <Text fontSize="sm">
                      This is a <strong>shared</strong> view. Saving changes the default that every instructor and
                      grader sees for this assignment.
                    </Text>
                    <HStack justify="flex-end">
                      <Popover.CloseTrigger asChild>
                        <Button size="xs" variant="ghost">
                          Cancel
                        </Button>
                      </Popover.CloseTrigger>
                      <Popover.CloseTrigger asChild>
                        <Button size="xs" colorPalette="blue" onClick={saveAsDefault}>
                          Save as default
                        </Button>
                      </Popover.CloseTrigger>
                    </HStack>
                  </VStack>
                </Popover.Body>
              </Popover.Content>
            </Popover.Positioner>
          </Popover.Root>
        </HStack>
      </HStack>

      <Collapsible.Root>
        <Collapsible.Trigger asChild>
          <Button size="xs" variant="ghost" mb={2}>
            Advanced filter ▾
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Box mb={3}>
            <RubricReportFilterBuilder
              value={filter}
              onChange={setFilter}
              checks={checkOptions}
              sections={classSections}
              labs={labSections}
            />
          </Box>
        </Collapsible.Content>
      </Collapsible.Root>

      {error && (
        <Text color="fg.error" fontSize="sm">
          {error}
        </Text>
      )}
      {isLoading && <Spinner size="sm" />}

      {!isLoading && !error && cohortTotal === 0 && (
        <Text color="fg.muted" fontSize="sm">
          No submissions match the current filter.
        </Text>
      )}

      {!isLoading && !error && cohortTotal > 0 && viz === "bars" && (
        <VStack align="stretch" gap={4}>
          {Object.entries(byCriterion).map(([criterion, criterionChecks]) => (
            <Box key={criterion}>
              <Text fontWeight="medium" fontSize="sm" mb={1}>
                {criterion}
              </Text>
              <VStack align="stretch" gap={2}>
                {criterionChecks.map((c) => (
                  <RateBar
                    key={c.id}
                    label={c.name}
                    count={statById.get(c.id)?.applied_count ?? 0}
                    total={cohortTotal}
                  />
                ))}
              </VStack>
            </Box>
          ))}
        </VStack>
      )}

      {!isLoading && !error && cohortTotal > 0 && viz === "options" && (
        <VStack align="stretch" gap={4}>
          {checkOptions.filter((c) => c.options.length > 0).length === 0 && (
            <Text color="fg.muted" fontSize="sm">
              No choice-style checks in this rubric.
            </Text>
          )}
          {checkOptions
            .filter((c) => c.options.length > 0)
            .map((c) => {
              const stat = statById.get(c.id);
              const optCount = (idx: number) => stat?.options.find((o) => o.option_index === idx)?.count ?? 0;
              return (
                <Box key={c.id}>
                  <Text fontWeight="medium" fontSize="sm" mb={1}>
                    {c.name}
                  </Text>
                  <VStack align="stretch" gap={2}>
                    {c.options.map((o) => (
                      <RateBar
                        key={o.index}
                        label={o.label}
                        count={optCount(o.index)}
                        total={cohortTotal}
                        colorPalette="purple"
                      />
                    ))}
                  </VStack>
                </Box>
              );
            })}
        </VStack>
      )}

      {!isLoading && !error && cohortTotal > 0 && viz === "table" && (
        <Table.Root size="sm" variant="outline" striped>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Criterion</Table.ColumnHeader>
              <Table.ColumnHeader>Check</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="right">Applied</Table.ColumnHeader>
              <Table.ColumnHeader textAlign="right">%</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {checkOptions.map((c) => {
              const applied = statById.get(c.id)?.applied_count ?? 0;
              return (
                <Table.Row key={c.id}>
                  <Table.Cell color="fg.muted">{c.criterionName}</Table.Cell>
                  <Table.Cell>{c.name}</Table.Cell>
                  <Table.Cell textAlign="right">
                    {applied}/{cohortTotal}
                  </Table.Cell>
                  <Table.Cell textAlign="right">{pct(applied, cohortTotal)}%</Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      )}

      {viz === "section" && (
        <SectionComparison
          checks={checkOptions}
          sections={classSections}
          bySection={bySection}
          isLoading={sectionLoading}
        />
      )}
    </Box>
  );
}

/** Quick-filter dropdown: None / a criterion / a specific check. */
function NativeQuickFilter({
  criteria,
  checks,
  onChange
}: {
  criteria: { id: number; name: string }[];
  checks: CheckOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Box>
      <select
        aria-label="Quick filter"
        style={{ fontSize: "0.8rem", padding: "2px 6px", borderRadius: 6 }}
        onChange={(e) => onChange(e.target.value)}
        defaultValue="none"
      >
        <option value="none">Quick filter: none</option>
        <optgroup label="By criterion">
          {criteria.map((c) => (
            <option key={`criterion:${c.id}`} value={`criterion:${c.id}`}>
              {c.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="By check">
          {checks.map((c) => (
            <option key={`check:${c.id}`} value={`check:${c.id}`}>
              {c.name}
            </option>
          ))}
        </optgroup>
      </select>
    </Box>
  );
}

/** Heatmap-ish matrix comparing application rate per check across class sections. */
function SectionComparison({
  checks,
  sections,
  bySection,
  isLoading
}: {
  checks: CheckOption[];
  sections: string[];
  bySection: Record<string, RubricReportData>;
  isLoading: boolean;
}) {
  if (sections.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm">
        No class sections to compare.
      </Text>
    );
  }
  if (isLoading) return <Spinner size="sm" />;

  const cellColor = (p: number) => {
    if (p >= 75) return "red.subtle";
    if (p >= 50) return "orange.subtle";
    if (p >= 25) return "yellow.subtle";
    if (p > 0) return "green.subtle";
    return undefined;
  };

  return (
    <Box overflowX="auto">
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Check</Table.ColumnHeader>
            {sections.map((s) => {
              const total = bySection[s]?.cohort_total ?? 0;
              return (
                <Table.ColumnHeader key={s} textAlign="right">
                  {s} ({total})
                </Table.ColumnHeader>
              );
            })}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {checks.map((c) => (
            <Table.Row key={c.id}>
              <Table.Cell>{c.name}</Table.Cell>
              {sections.map((s) => {
                const report = bySection[s];
                const total = report?.cohort_total ?? 0;
                const applied = report?.checks.find((x) => x.rubric_check_id === c.id)?.applied_count ?? 0;
                const p = pct(applied, total);
                return (
                  <Table.Cell key={s} textAlign="right" bg={cellColor(p)}>
                    {total > 0 ? `${p}%` : "—"}
                  </Table.Cell>
                );
              })}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
