import { Alert } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Box, Button, Heading, Link, List, Spinner, Table, Text } from "@chakra-ui/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import yaml from "yaml";

import { EdgeFunctionError, repositoryGetFile } from "@/lib/edgeFunctions";
import { GradedUnit, MutationTestUnit, PawtograderConfig, RegularTestUnit } from "@/utils/PawtograderYml";
import { createClient } from "@/utils/supabase/client";
import { Assignment, AutograderRegressionTest, Repository } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
import { toaster } from "@/components/ui/toaster";
import { useAssignmentController } from "@/hooks/useAssignment";

// Type guard to check if a unit is a mutation test unit
export function isMutationTestUnit(unit: GradedUnit): unit is MutationTestUnit {
  return "locations" in unit && "breakPoints" in unit;
}

// Type guard to check if a unit is a regular test unit
export function isRegularTestUnit(unit: GradedUnit): unit is RegularTestUnit {
  return "tests" in unit && "testCount" in unit;
}

/**
 * Validates that a parsed YAML object conforms to the expected PawtograderConfig structure.
 *
 * @param config - The parsed YAML object to validate
 * @returns An object with isValid boolean and error message if invalid
 */
function validatePawtograderConfig(config: unknown): { isValid: boolean; error?: string } {
  if (!config || typeof config !== "object") {
    return { isValid: false, error: "Configuration file is empty or not a valid YAML object" };
  }

  const obj = config as Record<string, unknown>;

  if (!obj["gradedParts"]) {
    return { isValid: false, error: "Missing required field: gradedParts" };
  }

  if (!Array.isArray(obj["gradedParts"])) {
    return { isValid: false, error: "gradedParts must be an array" };
  }

  if (!obj["submissionFiles"]) {
    return { isValid: false, error: "Missing required field: submissionFiles" };
  }

  const submissionFiles = obj["submissionFiles"] as Record<string, unknown>;
  if (!submissionFiles["files"] || !Array.isArray(submissionFiles["files"])) {
    return { isValid: false, error: "submissionFiles.files must be an array" };
  }

  if (!submissionFiles["testFiles"] || !Array.isArray(submissionFiles["testFiles"])) {
    return { isValid: false, error: "submissionFiles.testFiles must be an array" };
  }

  // Validate gradedParts structure
  const gradedParts = obj["gradedParts"] as unknown[];
  for (let i = 0; i < gradedParts.length; i++) {
    const part = gradedParts[i];
    if (!part || typeof part !== "object") {
      return { isValid: false, error: `gradedParts[${i}] must be an object` };
    }

    const partObj = part as Record<string, unknown>;
    if (!partObj["name"] || typeof partObj["name"] !== "string") {
      return { isValid: false, error: `gradedParts[${i}].name must be a string` };
    }

    if (!partObj["gradedUnits"] || !Array.isArray(partObj["gradedUnits"])) {
      return { isValid: false, error: `gradedParts[${i}].gradedUnits must be an array` };
    }

    // Validate gradedUnits structure
    const gradedUnits = partObj["gradedUnits"] as unknown[];
    for (let j = 0; j < gradedUnits.length; j++) {
      const unit = gradedUnits[j];
      if (!unit || typeof unit !== "object") {
        return { isValid: false, error: `gradedParts[${i}].gradedUnits[${j}] must be an object` };
      }

      const unitObj = unit as Record<string, unknown>;
      if (!unitObj["name"] || typeof unitObj["name"] !== "string") {
        return { isValid: false, error: `gradedParts[${i}].gradedUnits[${j}].name must be a string` };
      }

      // Check if it's a mutation test unit or regular test unit
      const hasMutationFields = "locations" in unitObj && "breakPoints" in unitObj;
      const hasRegularFields = "tests" in unitObj && "points" in unitObj;

      if (!hasMutationFields && !hasRegularFields) {
        return {
          isValid: false,
          error: `gradedParts[${i}].gradedUnits[${j}] must have either (locations and breakPoints) for mutation testing or (tests and points) for regular testing`
        };
      }

      if (hasMutationFields) {
        if (!Array.isArray(unitObj["breakPoints"]) || (unitObj["breakPoints"] as unknown[]).length === 0) {
          return { isValid: false, error: `gradedParts[${i}].gradedUnits[${j}].breakPoints must be a non-empty array` };
        }

        const firstBreakPoint = (unitObj["breakPoints"] as unknown[])[0] as Record<string, unknown>;
        if (!firstBreakPoint || typeof firstBreakPoint["pointsToAward"] !== "number") {
          return {
            isValid: false,
            error: `gradedParts[${i}].gradedUnits[${j}].breakPoints[0].pointsToAward must be a number`
          };
        }
      }

      if (hasRegularFields && typeof unitObj["points"] !== "number") {
        return { isValid: false, error: `gradedParts[${i}].gradedUnits[${j}].points must be a number` };
      }
    }
  }

  return { isValid: true };
}

/**
 * Safely calculates total points from a validated PawtograderConfig.
 *
 * @param config - The validated PawtograderConfig object
 * @returns The total points, or 0 if calculation fails
 */
function safelyCalculateTotalPoints(config: PawtograderConfig): number {
  try {
    return config.gradedParts.reduce(
      (acc, part) =>
        acc +
        part.gradedUnits.reduce(
          (unitAcc, unit) =>
            unitAcc +
            (isMutationTestUnit(unit)
              ? (unit.breakPoints?.[0]?.pointsToAward ?? 0)
              : isRegularTestUnit(unit)
                ? (unit.points ?? 0)
                : 0),
          0
        ),
      0
    );
  } catch (error) {
    toaster.error({
      title: "Error calculating total points",
      description: error instanceof Error ? error.message : "Unknown error"
    });
    return 0;
  }
}

export default function AutograderConfiguration({ graderRepo }: { graderRepo: string }) {
  const { assignment } = useAssignmentController();
  const [autograderConfig, setAutograderConfig] = useState<PawtograderConfig>();
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);

  const [error, setError] = useState<string>();
  const { course_id, assignment_id } = useParams();
  const { mutateAsync: createRegressionTest } = useCreate<AutograderRegressionTest>({
    resource: "autograder_regression_test"
  });
  const { mutateAsync: updateAssignment } = useUpdate<Assignment>({ resource: "assignments" });
  const { mutateAsync: deleteRegressionTest } = useDelete<AutograderRegressionTest>({});
  const [saveLoading, setSaveLoading] = useState(false);
  const { data: repos, isLoading: reposLoading } = useList<Repository>({
    resource: "repositories",
    meta: { select: "*" },
    pagination: { pageSize: 1000 },
    filters: [{ field: "assignment_id", operator: "eq", value: Number(assignment_id) }]
  });
  const { data: regressionTestRepos, isLoading: regressionTestReposLoading } = useList<AutograderRegressionTest>({
    resource: "autograder_regression_test",
    meta: { select: "*" },
    pagination: { pageSize: 1000 },
    filters: [{ field: "autograder_id", operator: "eq", value: Number(assignment_id) }]
  });
  useEffect(() => {
    async function fetchAutograderConfig() {
      if (!graderRepo) {
        return;
      }
      const supabase = createClient();
      repositoryGetFile(
        {
          courseId: Number(course_id),
          orgName: graderRepo.split("/")[0],
          repoName: graderRepo.split("/")[1],
          path: "pawtograder.yml"
        },
        supabase
      )
        .then(async (res) => {
          if ("content" in res) {
            try {
              const parsedConfig = yaml.parse(res.content) as PawtograderConfig;
              const validationResult = validatePawtograderConfig(parsedConfig);
              if (validationResult.isValid) {
                setAutograderConfig(parsedConfig);
                setError(undefined);
                // Calculate the total points for the autograder
                const points = safelyCalculateTotalPoints(parsedConfig);
                if (assignment && assignment.autograder_points !== points) {
                  await updateAssignment({
                    resource: "assignments",
                    id: assignment.id,
                    values: { autograder_points: points }
                  });
                }
              } else {
                setError(`Invalid pawtograder.yml structure: ${validationResult.error}`);
                setAutograderConfig(undefined);
              }
            } catch (parseError) {
              setError(
                `Failed to parse pawtograder.yml: ${parseError instanceof Error ? parseError.message : "Invalid YAML syntax"}`
              );
              setAutograderConfig(undefined);
            }
          }
        })
        .catch((err) => {
          if ((err as EdgeFunctionError).message === "Not Found") {
            setError(
              `Autograder configuration file not found in ${graderRepo}. Please create a pawtograder.yml file in the root of the repository.`
            );
            setAutograderConfig(undefined);
          } else {
            console.log("Error fetching autograder configuration", err);
            // throw err;
          }
        });
    }
    fetchAutograderConfig();
    // Note: updateAssignment is intentionally omitted from deps to avoid re-running
    // when the function reference changes (which happens on every render)
    // We should really get rid of refine.dev!!
  }, [graderRepo, assignment, course_id]); // eslint-disable-line react-hooks/exhaustive-deps


  const saveRegressionTests = useCallback(async () => {
    setSaveLoading(true);
    const additions = selectedRepos.filter((r) => !regressionTestRepos?.data.some((rt) => rt.repository === r));
    const deletions = regressionTestRepos?.data
      .filter((rt) => !selectedRepos.includes(rt.repository))
      .map((rt) => rt.id);
    async function saveAdditions() {
      return Promise.all(
        additions.map(async (repo) => {
          await createRegressionTest({ values: { autograder_id: Number(assignment_id), repository: repo } });
        })
      );
    }
    async function saveDeletions() {
      if (deletions)
        return Promise.all(
          deletions.map(async (id) => {
            await deleteRegressionTest({ resource: "autograder_regression_test", id: id });
          })
        );
    }
    await Promise.all([saveAdditions(), saveDeletions()]);
    setSaveLoading(false);
  }, [selectedRepos, regressionTestRepos, assignment_id, createRegressionTest, deleteRegressionTest]);
  const toggleRepo = useCallback(
    (repo: string) => {
      setSelectedRepos((oldRepos) => {
        if (oldRepos.includes(repo)) {
          return oldRepos.filter((r) => r !== repo);
        } else {
          return [...oldRepos, repo];
        }
      });
    },
    [setSelectedRepos]
  );
  useEffect(() => {
    if (regressionTestRepos?.data) {
      setSelectedRepos(regressionTestRepos.data.map((r) => r.repository));
    }
  }, [regressionTestRepos?.data]);
  if (regressionTestReposLoading || reposLoading) {
    return <Spinner />;
  }
  const allRepos = new Set<string>(
    (repos?.data.map((r) => r.repository) ?? []).concat(regressionTestRepos?.data.map((r) => r.repository) ?? [])
  );
  const allReposArray = Array.from(allRepos);
  allReposArray.sort();
  return (
    <div>
      {error && <Alert status="error">{error}</Alert>}
      <Heading as="h2">Autograder Configuration</Heading>
      This is the current configuration for the autograder, as defined in the autograder repository:
      <Box>
        <Heading size="sm">Submission source files</Heading>
        <Text fontSize="sm" color="fg.muted">
          These files will be submitted to the autograder for grading, and will be graded against the instructor&apos;s
          tests.
        </Text>
        <List.Root as="ul" pl={4}>
          {autograderConfig?.submissionFiles.files.map((file) => (
            <List.Item fontSize="sm" color="fg.muted" key={file}>
              {file}
            </List.Item>
          ))}
        </List.Root>
        <Heading size="sm">Submission test files</Heading>
        <Text fontSize="sm" color="fg.muted">
          These tests will be submitted to the autograder for grading.
        </Text>
        <List.Root as="ul" pl={4}>
          {autograderConfig?.submissionFiles.testFiles.map((file) => (
            <List.Item fontSize="sm" color="fg.muted" key={file}>
              {file}
            </List.Item>
          ))}
        </List.Root>
      </Box>
      <Heading size="sm">Graded parts</Heading>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Name</Table.ColumnHeader>
            <Table.ColumnHeader>Points</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {autograderConfig?.gradedParts.map((part) => (
            <Table.Row key={part.name}>
              <Table.Cell>{part.name}</Table.Cell>
              <Table.Cell>
                {part.gradedUnits.reduce(
                  (acc, unit) => acc + (isMutationTestUnit(unit) ? unit.breakPoints[0].pointsToAward : unit.points),
                  0
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Heading as="h2">Regression Testing</Heading>
      <Alert status="info">
        Automatically run a smoke test of the autograder on a selection of student submissions. If enabled, a new
        autograder won&apos;t be published until the smoke test passes.
      </Alert>
      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Enabled</Table.ColumnHeader>
            <Table.ColumnHeader>Repository</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {allReposArray.map((repo) => (
            <Table.Row key={repo}>
              <Table.Cell>
                <Checkbox checked={selectedRepos.includes(repo)} onCheckedChange={() => toggleRepo(repo)} />
              </Table.Cell>
              <Table.Cell>
                <Link onClick={() => toggleRepo(repo)}>{repo}</Link>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Button
        disabled={saveLoading}
        colorPalette="green"
        variant="surface"
        loading={saveLoading}
        onClick={() => saveRegressionTests()}
      >
        Save Testing Configuration
      </Button>
    </div>
  );
}
