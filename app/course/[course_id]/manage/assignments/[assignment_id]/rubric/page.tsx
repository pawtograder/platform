"use client";
import { Alert } from "@/components/ui/alert";
import { useColorMode } from "@/components/ui/color-mode";
import RubricSidebar from "@/components/ui/rubric-sidebar";
import { toaster, Toaster } from "@/components/ui/toaster";
import {
  Assignment,
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  RubricChecksDataType,
  YmlRubricChecksType,
  YmlRubricCriteriaType,
  YmlRubricPartType,
  YmlRubricType
} from "@/utils/supabase/DatabaseTypes";
import { Accordion, Box, Button, Container, Flex, Heading, HStack, List, Text, VStack } from "@chakra-ui/react";
import Editor, { Monaco } from "@monaco-editor/react";
import { useCreate, useDelete, useShow, useUpdate } from "@refinedev/core";
import { configureMonacoYaml } from "monaco-yaml";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, useRef } from "react";
import * as YAML from "yaml";

function rubricCheckDataOrThrow(check: YmlRubricChecksType): RubricChecksDataType | undefined {
  if (!check.data) {
    return undefined;
  }
  if (check.data.options?.length === 1) {
    throw new Error("Checks may not have only one option - they must have at least two options, or can have none");
  }
  for (const option of check.data.options) {
    if (option.points === undefined || option.points === null) {
      throw new Error("Option points are required");
    }
    if (!option.label) {
      throw new Error("Option label is required");
    }
  }
  return check.data as RubricChecksDataType;
}
function hydratedRubricChecksToYamlRubric(checks: HydratedRubricCheck[]): YmlRubricChecksType[] {
  return checks
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((check) => ({
      id: check.id,
      name: check.name,
      description: valOrUndefined(check.description),
      file: valOrUndefined(check.file),
      group: valOrUndefined(check.group),
      is_annotation: check.is_annotation,
      is_required: check.is_required,
      is_comment_required: check.is_comment_required,
      artifact: valOrUndefined(check.artifact),
      max_annotations: valOrUndefined(check.max_annotations),
      points: check.points,
      data: valOrUndefined(check.data),
      annotation_target: valOrUndefined(check.annotation_target) as "file" | "artifact" | undefined
    }));
}
function valOrUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}
function hydratedRubricCriteriaToYamlRubric(criteria: HydratedRubricCriteria[]): YmlRubricCriteriaType[] {
  criteria.sort((a, b) => a.ordinal - b.ordinal);
  return criteria.map((criteria) => ({
    id: criteria.id,
    data: valOrUndefined(criteria.data),
    description: valOrUndefined(criteria.description),
    is_additive: criteria.is_additive,
    name: criteria.name,
    total_points: criteria.total_points,
    max_checks_per_submission: valOrUndefined(criteria.max_checks_per_submission),
    min_checks_per_submission: valOrUndefined(criteria.min_checks_per_submission),
    checks: hydratedRubricChecksToYamlRubric(criteria.rubric_checks)
  }));
}
function hydratedRubricPartToYamlRubric(parts: HydratedRubricPart[]): YmlRubricPartType[] {
  parts.sort((a, b) => a.ordinal - b.ordinal);
  return parts.map((part) => ({
    id: part.id,
    data: valOrUndefined(part.data),
    description: valOrUndefined(part.description),
    name: part.name,
    criteria: hydratedRubricCriteriaToYamlRubric(part.rubric_criteria)
  }));
}
function HydratedRubricToYamlRubric(rubric: HydratedRubric): YmlRubricType {
  return {
    name: rubric.name,
    description: valOrUndefined(rubric.description),
    parts: hydratedRubricPartToYamlRubric(rubric.rubric_parts)
  };
}
function valOrNull<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}
function YamlChecksToHydratedChecks(checks: YmlRubricChecksType[]): HydratedRubricCheck[] {
  if (checks.length === 0) {
    throw new Error("Criteria must have at least one check");
  }
  return checks.map((check, index) => ({
    id: check.id || -1,
    name: check.name,
    description: valOrNull(check.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: rubricCheckDataOrThrow(check),
    rubric_criteria_id: 0,
    file: valOrNull(check.file),
    artifact: valOrNull(check.artifact),
    group: valOrNull(null),
    is_annotation: check.is_annotation,
    is_comment_required: check.is_comment_required,
    max_annotations: valOrNull(check.max_annotations),
    points: check.points,
    is_required: check.is_required,
    annotation_target: valOrNull(check.annotation_target)
  }));
}
function YamlCriteriaToHydratedCriteria(part_id: number, criteria: YmlRubricCriteriaType[]): HydratedRubricCriteria[] {
  return criteria.map((criteria, index) => ({
    id: criteria.id || -1,
    name: criteria.name,
    description: valOrNull(criteria.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: criteria.data,
    rubric_part_id: part_id,
    is_additive: criteria.is_additive || false,
    total_points: criteria.total_points || 0,
    max_checks_per_submission: valOrNull(criteria.max_checks_per_submission),
    min_checks_per_submission: valOrNull(criteria.min_checks_per_submission),
    rubric_checks: YamlChecksToHydratedChecks(criteria.checks)
  }));
}
function YamlPartsToHydratedParts(parts: YmlRubricPartType[]): HydratedRubricPart[] {
  const partsWithIds = parts.filter((part) => part.id);
  const partIds = new Set(partsWithIds.map((part) => part.id));
  if (partIds.size !== partsWithIds.length) {
    throw new Error(
      "Duplicate part ids in YAML. If you intend to copy a part, simply remove the ID on the copy, and a new ID will be generated for the new part upon saving."
    );
  }
  const criteriaWithIds = parts.flatMap((part) => part.criteria.filter((criteria) => criteria.id));
  const criteriaIds = new Set(criteriaWithIds.map((criteria) => criteria.id));
  if (criteriaIds.size !== criteriaWithIds.length) {
    throw new Error(
      "Duplicate criteria ids in YAML. If you intend to copy a criteria, simply remove the ID on the copy, and a new ID will be generated for the new criteria upon saving."
    );
  }
  const checksWithIds = parts.flatMap((part) =>
    part.criteria.flatMap((criteria) => criteria.checks.filter((check) => check.id))
  );
  const checkIds = new Set(checksWithIds.map((check) => check.id));
  if (checkIds.size !== checksWithIds.length) {
    throw new Error(
      "Duplicate check ids in YAML. If you intend to copy a check, simply remove the ID on the copy, and a new ID will be generated for the new check upon saving."
    );
  }
  return parts.map((part, index) => ({
    id: part.id || -1,
    name: part.name,
    description: valOrNull(part.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: part.data,
    rubric_criteria: YamlCriteriaToHydratedCriteria(part.id || -1, part.criteria)
  }));
}
function YamlRubricToHydratedRubric(yaml: YmlRubricType): HydratedRubric {
  return {
    id: 0,
    class_id: 0,
    created_at: "",
    name: yaml.name,
    description: valOrNull(yaml.description),
    rubric_parts: YamlPartsToHydratedParts(yaml.parts)
  };
}

type AssignmentWithRubric = Assignment & {
  rubrics: HydratedRubric;
};

function findUpdatedPropertyNames<T extends object>(newItem: T, existingItem: T): (keyof T)[] {
  return Object.keys(newItem)
    .filter(
      (key) =>
        !Array.isArray(newItem[key as keyof T]) && key !== "rubric_id" && key !== "class_id" && key !== "created_at"
    )
    .filter(
      (key) =>
        (key === "data" &&
          newItem[key as keyof T] != existingItem[key as keyof T] &&
          JSON.stringify(newItem[key as keyof T]) != JSON.stringify(existingItem[key as keyof T])) ||
        newItem[key as keyof T] != existingItem[key as keyof T]
    ) as (keyof T)[];
}

enum RubricType {
  "student",
  "grader"
}

export default function RubricPage() {
  const rubrics = [
    { title: "Student Rubric", content: <RubricElement type={RubricType.student} /> },
    { title: "Grader Rubric", content: <RubricElement type={RubricType.grader} /> }
  ];

  return (
    <Container>
      <Accordion.Root collapsible>
        {rubrics.map((item, index) => (
          <Accordion.Item key={index} value={item.title}>
            <Accordion.ItemTrigger>
              {item.title}
              <Accordion.ItemIndicator color="black" />
            </Accordion.ItemTrigger>
            <Accordion.ItemContent>
              <Accordion.ItemBody>{item.content}</Accordion.ItemBody>
            </Accordion.ItemContent>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </Container>
  );
}

/**
 * Gets either the assignment with the student rubric or the grader rubric depending on which one is being edited.
 */
function useAssignment(type: RubricType) {
  const { assignment_id } = useParams();
  const { query: assignment } = useShow<AssignmentWithRubric>({
    resource: "assignments",
    id: assignment_id as string,
    meta: {
      select:
        type === RubricType.grader
          ? "*, rubrics!assignments_rubric_id_fkey(*,rubric_parts(*, rubric_criteria(*, rubric_checks(*))))"
          : "*, rubrics!assignments_student_rubric_id_fkey(*,rubric_parts(*, rubric_criteria(*, rubric_checks(*))))"
    }
  });
  return assignment!;
}
function RubricElement({ type }: { type: RubricType }) {
  const assignment = useAssignment(type);

  function handleEditorWillMount(monaco: Monaco) {
    window.MonacoEnvironment = {
      getWorker(moduleId, label) {
        switch (label) {
          case "editorWorkerService":
            return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
          case "yaml":
            return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
          default:
            throw new Error(`Unknown label ${label}`);
        }
      }
    };

    configureMonacoYaml(monaco, {
      enableSchemaRequest: true,
      schemas: [
        {
          // If YAML file is opened matching this glob
          fileMatch: ["*"],
          // Then this schema will be downloaded from the internet and used.
          uri: "/RubricSchema.json"
        }
      ]
    });
  }
  const existingRubric = assignment.data?.data.rubrics;
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [value, setValue] = useState(existingRubric ? YAML.stringify(HydratedRubricToYamlRubric(existingRubric)) : "");
  const [rubric, setRubric] = useState<HydratedRubric | undefined>(existingRubric);
  const [error, setError] = useState<string | undefined>(undefined);
  const [errorMarkers, setErrorMarkers] = useState<{ message: string; startLineNumber: number }[]>([]);
  const { colorMode } = useColorMode();
  const { mutateAsync: updateResource } = useUpdate({});
  const { mutateAsync: deleteResource } = useDelete({});
  const { mutateAsync: createResource } = useCreate({});
  const debounceTimeoutRef = useRef<NodeJS.Timeout>();
  const [updatePaused, setUpdatePaused] = useState<boolean>(false);
  const [canLoadDemo, setCanLoadDemo] = useState<boolean>(false);

  const debouncedParseYaml = useCallback(
    (value: string) => {
      if (errorMarkers.length === 0) {
        try {
          setRubric(YamlRubricToHydratedRubric(YAML.parse(value)));
          setError(undefined);
        } catch (error) {
          setError(error instanceof Error ? error.message : "Unknown error");
        }
      }
    },
    [errorMarkers.length]
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value) {
        setValue(value);
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }
        setUpdatePaused(true);
        debounceTimeoutRef.current = setTimeout(() => {
          debouncedParseYaml(value);
          setUpdatePaused(false);
        }, 2000);
      }
    },
    [debouncedParseYaml]
  );

  useEffect(() => {
    setValue(existingRubric ? YAML.stringify(HydratedRubricToYamlRubric(existingRubric)) : "");
    setRubric(existingRubric);
  }, [existingRubric]);
  useEffect(() => {
    if (rubric && rubric.rubric_parts.length === 0) {
      setCanLoadDemo(true);
    } else {
      setCanLoadDemo(false);
    }
  }, [rubric]);

  const updatePartIfChanged = useCallback(
    async (part: HydratedRubricPart, existingPart: HydratedRubricPart) => {
      if (part.id !== existingPart.id) {
        return { toCreate: [], toUpdate: [], toDelete: [] };
      }
      const updatedPropertyNames = findUpdatedPropertyNames(part, existingPart);
      if (updatedPropertyNames.length === 0) {
        return;
      }
      const values = updatedPropertyNames.reduce(
        (acc, curr) => ({
          ...acc,
          [curr]: part[curr]
        }),
        {}
      );
      await updateResource({
        id: part.id,
        resource: "rubric_parts",
        values
      });
    },
    [updateResource]
  );
  const updateCriteriaIfChanged = useCallback(
    async (criteria: HydratedRubricCriteria, existingCriteria: HydratedRubricCriteria) => {
      if (criteria.id !== existingCriteria.id) {
        return { toCreate: [], toUpdate: [], toDelete: [] };
      }
      const updatedPropertyNames = findUpdatedPropertyNames(criteria, existingCriteria);
      if (updatedPropertyNames.length === 0) {
        return;
      }
      const values = updatedPropertyNames.reduce(
        (acc, curr) => ({
          ...acc,
          [curr]: criteria[curr]
        }),
        {}
      );
      await updateResource({
        id: criteria.id,
        resource: "rubric_criteria",
        values
      });
    },
    [updateResource]
  );
  const updateCheckIfChanged = useCallback(
    async (check: HydratedRubricCheck, existingCheck: HydratedRubricCheck) => {
      if (check.id !== existingCheck.id) {
        return { toCreate: [], toUpdate: [], toDelete: [] };
      }
      const updatedPropertyNames = findUpdatedPropertyNames(check, existingCheck);
      if (updatedPropertyNames.length === 0) {
        return;
      }
      const values = updatedPropertyNames.reduce(
        (acc, curr) => ({
          ...acc,
          [curr]: check[curr]
        }),
        {}
      );
      await updateResource({
        id: check.id,
        resource: "rubric_checks",
        values
      });
    },
    [updateResource]
  );
  const saveRubric = useCallback(
    async (value: string) => {
      const rubric = YamlRubricToHydratedRubric(YAML.parse(value));
      if (!rubric || !existingRubric) return;
      const findChanges = <T extends { id: number | undefined }>(
        newItems: T[],
        existingItems: T[]
      ): {
        toCreate: T[];
        toUpdate: T[];
        toDelete: number[];
      } => {
        const existingIds = new Set(
          existingItems.map((item) => item.id).filter((id): id is number => id !== undefined)
        );
        const newIds = new Set(newItems.map((item) => item.id).filter((id): id is number => id !== undefined));

        return {
          toCreate: newItems.filter((item) => !item.id || !existingIds.has(item.id)),
          toUpdate: newItems.filter((item) => item.id && existingIds.has(item.id)),
          toDelete: Array.from(existingIds).filter((id) => !newIds.has(id))
        };
      };

      const partChanges = findChanges(rubric.rubric_parts, existingRubric.rubric_parts);

      const allExistingCriteria = existingRubric.rubric_parts.flatMap((part) => part.rubric_criteria);
      const allNewCriteria = rubric.rubric_parts.flatMap((part) => part.rubric_criteria);
      const criteriaChanges = findChanges(allNewCriteria, allExistingCriteria);

      const allExistingChecks = allExistingCriteria.flatMap((criteria) => criteria.rubric_checks);
      const allNewChecks = allNewCriteria.flatMap((criteria) => criteria.rubric_checks);
      const checkChanges = findChanges(allNewChecks, allExistingChecks);

      await Promise.all(
        checkChanges.toDelete.map((id) =>
          deleteResource({
            id,
            resource: "rubric_checks",
            errorNotification: (error) => {
              toaster.create({
                title: "Failed to delete check",
                description: "The check could not be deleted because of an error: " + error,
                type: "error"
              });
              return false;
            }
          })
        )
      );

      await Promise.all(
        partChanges.toUpdate.map((part) =>
          updatePartIfChanged(part, existingRubric.rubric_parts.find((p) => p.id === part.id) as HydratedRubricPart)
        )
      );

      await Promise.all(
        partChanges.toCreate.map(async (part) => {
          const partCopy = { ...part };
          partCopy.class_id = assignment.data?.data.class_id || 0;
          partCopy.rubric_id = assignment.data?.data.rubrics.id || 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (partCopy as any).rubric_criteria = undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (partCopy as any).id = undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (partCopy as any).created_at = undefined;
          const createdPart = await createResource({
            resource: "rubric_parts",
            values: partCopy
          });
          if (!createdPart.data.id) {
            throw new Error("Failed to create part");
          }
          part.id = createdPart.data.id as number;
        })
      );

      //Update the IDs of the criteria
      rubric.rubric_parts.forEach((part) => {
        part.rubric_criteria.forEach((criteria) => {
          criteria.rubric_part_id = part.id;
          criteria.class_id = part.class_id;
          criteria.rubric_id = part.rubric_id;
        });
      });

      await Promise.all(
        criteriaChanges.toUpdate.map((criteria) =>
          updateCriteriaIfChanged(
            criteria,
            existingRubric.rubric_parts
              .find((p) => p.id === criteria.rubric_part_id)
              ?.rubric_criteria.find((c) => c.id === criteria.id) as HydratedRubricCriteria
          )
        )
      );
      await Promise.all(
        criteriaChanges.toCreate.map(async (criteria) => {
          const criteriaCopy = { ...criteria };
          criteriaCopy.class_id = assignment.data?.data.class_id || 0;
          criteriaCopy.rubric_id = assignment.data?.data.rubrics.id || 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (criteriaCopy as any).id = undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (criteriaCopy as any).created_at = undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (criteriaCopy as any).rubric_checks = undefined;
          const createdCriteria = await createResource({
            resource: "rubric_criteria",
            values: criteriaCopy
          });
          if (!createdCriteria.data.id) {
            throw new Error("Failed to create criteria");
          }
          criteria.id = createdCriteria.data.id as number;
        })
      );

      //Update the IDs of the checks
      allNewCriteria.forEach((criteria) => {
        criteria.rubric_checks.forEach((check) => {
          check.rubric_criteria_id = criteria.id;
          check.class_id = assignment.data?.data.class_id || -1;
        });
      });

      await Promise.all(
        checkChanges.toUpdate.map((check) =>
          updateCheckIfChanged(check, allExistingChecks.find((c) => c.id === check.id) as HydratedRubricCheck)
        )
      );
      await Promise.all(
        checkChanges.toCreate.map(async (check) => {
          const checkCopy = { ...check };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (checkCopy as any).id = undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (checkCopy as any).created_at = undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (checkCopy as any).rubric_id = undefined;
          const createdCheck = await createResource({
            resource: "rubric_checks",
            values: checkCopy
          });
          if (!createdCheck.data.id) {
            throw new Error("Failed to create check");
          }
          check.id = createdCheck.data.id as number;
        })
      );

      await Promise.all(
        criteriaChanges.toDelete.map((id) =>
          deleteResource({
            id,
            resource: "rubric_criteria"
          })
        )
      );
      await Promise.all(
        partChanges.toDelete.map((id) =>
          deleteResource({
            id,
            resource: "rubric_parts"
          })
        )
      );
    },
    [
      existingRubric,
      assignment.data?.data.class_id,
      assignment.data?.data.rubrics.id,
      deleteResource,
      createResource,
      updateCriteriaIfChanged,
      updatePartIfChanged,
      updateCheckIfChanged
    ]
  );

  return (
    <Flex w="100%" minW="0">
      <Box w="100%" minW="0">
        <VStack w="100%">
          <HStack w="100%" mt={2} mb={2} justifyContent="space-between">
            <Toaster />
            <HStack>
              <Heading size="md">
                {type === RubricType.grader ? "Handgrading Rubric" : "Self Evaluation Rubric"}
              </Heading>
              {canLoadDemo && (
                <Button
                  variant="ghost"
                  colorScheme="gray"
                  onClick={() => {
                    setValue(defaultRubric);
                    setRubric(YamlRubricToHydratedRubric(YAML.parse(defaultRubric)));
                  }}
                >
                  Load Demo Rubric
                </Button>
              )}
            </HStack>
            <HStack pr={2}>
              <Button
                variant="ghost"
                colorScheme="gray"
                onClick={() => {
                  window.history.back();
                }}
              >
                Cancel
              </Button>
              <Button
                colorPalette="green"
                loading={isSaving}
                onClick={async () => {
                  try {
                    setIsSaving(true);
                    await saveRubric(value);
                    toaster.create({
                      title: "Rubric saved",
                      description: "The rubric has been saved successfully",
                      type: "success"
                    });
                    //Reload the rubric so that we have ID's on newly created items
                    await assignment.refetch();
                    if (assignment.data?.data.rubrics) {
                      setValue(YAML.stringify(HydratedRubricToYamlRubric(assignment.data?.data.rubrics)));
                    }
                  } catch (error) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const _error = error as any;
                    if ("details" in _error && "message" in _error) {
                      toaster.create({
                        title: "Failed to save rubric",
                        description:
                          "The rubric could not be saved because of an error. Please report this to the developers: " +
                          _error.message +
                          " " +
                          (_error.details || ""),
                        type: "error"
                      });
                    } else {
                      toaster.create({
                        title: "Failed to save rubric",
                        description: "The rubric could not be saved because of an error: " + JSON.stringify(_error),
                        type: "error"
                      });
                    }
                  } finally {
                    setIsSaving(false);
                  }
                }}
              >
                Save
              </Button>
            </HStack>
          </HStack>
          <Editor
            height="100vh"
            width="100%"
            defaultLanguage="yaml"
            path="rubric.yml"
            beforeMount={handleEditorWillMount}
            value={value}
            theme={colorMode === "dark" ? "vs-dark" : "vs"}
            onValidate={(markers) => {
              if (markers.length > 0) {
                setError("YAML syntax error. Please fix the errors in the editor.");
                setErrorMarkers(markers);
              } else {
                setError(undefined);
                setErrorMarkers([]);
              }
            }}
            onChange={handleEditorChange}
          />
        </VStack>
      </Box>
      <Box w="lg" position="relative">
        {updatePaused && <Alert variant="surface">Preview paused while typing</Alert>}
        {!error && rubric && <RubricSidebar rubric={rubric} />}
        {error && (
          <Box
            position="absolute"
            top="0"
            left="0"
            width="100%"
            height="100%"
            backgroundColor="bg.error"
            display="flex"
            justifyContent="center"
            alignItems="center"
            zIndex="1"
          >
            <VStack>
              <Text color="fg.error">{error}</Text>
              <List.Root>
                {errorMarkers.map((marker, index) => (
                  <List.Item key={index}>
                    <Text color="fg.error">
                      Line {marker.startLineNumber}: {marker.message}
                    </Text>
                  </List.Item>
                ))}
              </List.Root>
            </VStack>
          </Box>
        )}
      </Box>
    </Flex>
  );
}
const defaultRubric = `
name: Demo Rubric
description: Edit or delete this rubric to create your own.
parts:
  - description: >
      We might even include a complete description of the part of the assignment
      here, you get markdown, you even get $\LaTeX$ basically everywhere!
    name: Question 1
    criteria:
      - description: Overall conformance to our course [style
          guide](https://neu-se.github.io/CS4530-Spring-2024/policies/style/).
          All of these checks happen to be "annotations," which means they are
          applied directly to line(s) of code. Scoring is **negative** which
          means each check deducts points from the total points for this
          criteria.
        is_additive: false
        name: Design rules
        total_points: 15
        checks:
          - name: Non-compliant name
            description: All new names (e.g. for local variables, methods, and properties)
              follow the naming conventions defined in our style guide (Max 6
              annotations per-submission, comment required)
            is_annotation: true
            is_required: false
            is_comment_required: true
            max_annotations: 6
            points: 2
          - name: Missing documentation
            description: Max 10 annotations per-submission. Comment optional.
            is_annotation: true
            is_required: false
            is_comment_required: false
            max_annotations: 10
            points: 2
      - description: This is an example of a criteria that has multiple checks, and only
          one can be selected.
        is_additive: true
        name: Overall design quality
        total_points: 10
        max_checks_per_submission: 1
        min_checks_per_submission: 1
        checks:
          - name: It's the best
            description: This is *great* and has low coupling and high cohesion, something
              something objects.
            is_annotation: false
            is_required: false
            is_comment_required: false
            max_annotations: 1
            points: 10
          - name: It's mediocre
            description: Something's not quite right, the grader has added comments to
              explain
            is_annotation: false
            is_required: false
            is_comment_required: true
            max_annotations: 1
            points: 5
      - description: This is additive scoring with multiple checks. Each check has
          multiple options. Graders must select one option for each check.
        is_additive: true
        name: Test case quality
        total_points: 10
        checks:
          - name: Submission-level check, select one option
            description: This check demonstrates having an "option". The grader selects the
              option from this sidebar. This check is required.
            file: src/test/java/com/pawtograder/example/java/EntrypointTest.java
            is_annotation: false
            is_required: true
            is_comment_required: false
            points: 4
            data:
              options:
                - label: Satisfactory
                  points: 10
                - label: Marginal
                  points: 5
                - label: Unacceptable
                  points: 0
          - name: File-level check, select one option
            description: This check demonstrates having an "option". The grader selects the
              option by marking a line. This check is required.
            file: src/test/java/com/pawtograder/example/java/EntrypointTest.java
            is_annotation: true
            is_required: true
            is_comment_required: false
            max_annotations: 1
            points: 4
            data:
              options:
                - label: Satisfactory
                  points: 10
                - label: Marginal
                  points: 5
                - label: Unacceptable
                  points: 0
  - name: Part 2
    description: This is another part/question. You might assign grading per-part,
      and we'll track what's been done and what hasn't.
    criteria:
      - name: A big criteria with checkboxes, positive scoring
        description: Some use-cases might call for having graders tick boxes to add
          points. This will require at least 2 and at most 4 boxes to be ticked.
        is_additive: true
        total_points: 10
        max_checks_per_submission: 4
        min_checks_per_submission: 2
        checks:
          - name: Some option 1
            description: This might be useful for $O(n^2)$ having more details describing
              the attribute
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 2
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 3
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 4
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 5
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 6
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
      - description: Some use-cases might call for having graders tick boxes to deduct
          points. This will require at least 2 and at most 4 boxes to be ticked.
        is_additive: false
        name: A big criteria with checkboxes, NEGATIVE scoring
        total_points: 10
        max_checks_per_submission: 4
        min_checks_per_submission: 2
        checks:
          - name: Some option 1
            description: This might be useful for $O(n^2)$ having more details describing
              the attribute
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 2
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 3
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 4
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 5
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
          - name: Some option 6
            is_annotation: false
            is_required: false
            is_comment_required: true
            points: 2
`;
