'use client'
import { useColorMode } from '@/components/ui/color-mode';
import RubricSidebar from '@/components/ui/rubric-sidebar';
import { toaster, Toaster } from "@/components/ui/toaster";
import { Assignment, HydratedRubric, HydratedRubricCheck, HydratedRubricCriteria, HydratedRubricPart, RubricChecksDataType, YmlRubricChecksType, YmlRubricCriteriaType, YmlRubricPartType, YmlRubricType } from '@/utils/supabase/DatabaseTypes';
import { Box, Button, Flex, Heading, HStack, List, Text, VStack } from '@chakra-ui/react';
import Editor, { Monaco } from '@monaco-editor/react';
import { useCreate, useDelete, useShow, useUpdate } from '@refinedev/core';
import { configureMonacoYaml } from 'monaco-yaml';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import * as YAML from 'yaml';

function rubricCheckDataOrThrow(check: YmlRubricChecksType): RubricChecksDataType | undefined {
    if (!check.data) {
        return undefined;
    }
    for (const option of check.data.options) {
        if (!option.points) {
            throw new Error('Option points are required');
        }
        if (!option.label) {
            throw new Error('Option label is required');
        }
    }
    return check.data as RubricChecksDataType;
}
function hydratedRubricChecksToYamlRubric(checks: HydratedRubricCheck[]): YmlRubricChecksType[] {
    return checks.sort((a, b) => a.ordinal - b.ordinal).map(check => ({
        id: check.id,
        name: check.name,
        description: valOrUndefined(check.description),
        file: valOrUndefined(check.file),
        group: valOrUndefined(check.group),
        is_annotation: check.is_annotation,
        is_comment_required: check.is_comment_required,
        max_annotations: valOrUndefined(check.max_annotations),
        points: check.points,
        data: valOrUndefined(check.data),
    }));
}
function valOrUndefined<T>(value: T | null | undefined): T | undefined {
    return value === null ? undefined : value;
}
function hydratedRubricCriteriaToYamlRubric(criteria: HydratedRubricCriteria[]): YmlRubricCriteriaType[] {
    criteria.sort((a, b) => a.ordinal - b.ordinal);
    return criteria.map(criteria => ({
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
    return parts.map(part => ({
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
    }
}
function valOrNull<T>(value: T | null | undefined): T | null {
    return value === undefined ? null : value;
}
function YamlChecksToHydratedChecks(checks: YmlRubricChecksType[]): HydratedRubricCheck[] {
    return checks.map((check, index) => ({
        id: check.id || -1,
        name: check.name,
        description: valOrNull(check.description),
        ordinal: index,
        rubric_id: 0,
        class_id: 0,
        created_at: '',
        data: rubricCheckDataOrThrow(check),
        rubric_criteria_id: 0,
        file: valOrNull(check.file),
        group: valOrNull(null),
        is_annotation: check.is_annotation,
        is_comment_required: check.is_comment_required,
        max_annotations: valOrNull(check.max_annotations),
        points: check.points
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
        created_at: '',
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
    return parts.map((part, index) => ({
        id: part.id || -1,
        name: part.name,
        description: valOrNull(part.description),
        ordinal: index,
        rubric_id: 0,
        class_id: 0,
        created_at: '',
        data: part.data,
        rubric_criteria: YamlCriteriaToHydratedCriteria(part.id || -1, part.criteria)
    }));
}
function YamlRubricToHydratedRubric(yaml: YmlRubricType): HydratedRubric {
    return {
        id: 0,
        class_id: 0,
        created_at: '',
        name: yaml.name,
        description: valOrNull(yaml.description),
        rubric_parts: YamlPartsToHydratedParts(yaml.parts)
    }
}

type AssignmentWithRubric = Assignment & {
    rubrics: HydratedRubric;
}

function findUpdatedPropertyNames<T extends object>(newItem: T, existingItem: T): (keyof T)[] {
    return Object.keys(newItem)
        .filter(key => !Array.isArray(newItem[key as keyof T])
            && key !== 'rubric_id'
            && key !== 'class_id'
            && key !== 'created_at'
        )
        .filter(key =>
            (key === 'data' &&
                newItem[key as keyof T] != existingItem[key as keyof T] &&
                JSON.stringify(newItem[key as keyof T]) != JSON.stringify(existingItem[key as keyof T]))
            ||
            (newItem[key as keyof T] != existingItem[key as keyof T])

        ) as (keyof T)[];
}

export default function RubricPage() {

    const { assignment_id } = useParams();
    const { query: assignment } = useShow<AssignmentWithRubric>({
        resource: 'assignments',
        id: assignment_id as string,
        meta: {
            select: '*, rubrics!assignments_rubric_id_fkey(*,rubric_parts(*, rubric_criteria(*, rubric_checks(*))))'
        }
    })
    function handleEditorWillMount(monaco: Monaco) {
        window.MonacoEnvironment = {
            getWorker(moduleId, label) {
                switch (label) {
                    case 'editorWorkerService':
                        return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url))
                    case 'yaml':
                        return new Worker(new URL('monaco-yaml/yaml.worker', import.meta.url))
                    default:
                        throw new Error(`Unknown label ${label}`)
                }
            }
        }

        configureMonacoYaml(monaco, {
            enableSchemaRequest: true,
            schemas: [
                {
                    // If YAML file is opened matching this glob
                    fileMatch: ['*'],
                    // Then this schema will be downloaded from the internet and used.
                    uri: '/RubricSchema.json'
                },
            ]
        })
    }
    const existingRubric = assignment.data?.data.rubrics;
    const [value, setValue] = useState(existingRubric ? YAML.stringify(HydratedRubricToYamlRubric(existingRubric)) : '');
    const [rubric, setRubric] = useState<HydratedRubric | undefined>(existingRubric);
    const [error, setError] = useState<boolean>(false);
    const [errorMarkers, setErrorMarkers] = useState<{ message: string, startLineNumber: number }[]>([]);
    const { colorMode } = useColorMode();
    const { mutateAsync: updateResource } = useUpdate({});
    const { mutateAsync: deleteResource } = useDelete({});
    const { mutateAsync: createResource } = useCreate({})
    useEffect(() => {
        setValue(existingRubric ? YAML.stringify(HydratedRubricToYamlRubric(existingRubric)) : '');
        setRubric(existingRubric);
    }, [existingRubric]);

    const updatePartIfChanged = useCallback(async (part: HydratedRubricPart, existingPart: HydratedRubricPart) => {
        if (part.id !== existingPart.id) {
            return { toCreate: [], toUpdate: [], toDelete: [] };
        }
        const updatedPropertyNames = findUpdatedPropertyNames(part, existingPart);
        if (updatedPropertyNames.length === 0) {
            return;
        }
        await updateResource({
            id: part.id,
            resource: 'rubric_parts',
            values: updatedPropertyNames.map(propertyName => ({
                [propertyName]: part[propertyName]
            }))
        });
    }, [updateResource]);
    const updateCriteriaIfChanged = useCallback(async (criteria: HydratedRubricCriteria, existingCriteria: HydratedRubricCriteria) => {
        if (criteria.id !== existingCriteria.id) {
            return { toCreate: [], toUpdate: [], toDelete: [] };
        }
        const updatedPropertyNames = findUpdatedPropertyNames(criteria, existingCriteria);
        if (updatedPropertyNames.length === 0) {
            return;
        }
        const values = updatedPropertyNames.reduce((acc, curr) => ({
            ...acc,
            [curr]: criteria[curr]
        }), {});
        console.log(values);
        await updateResource({
            id: criteria.id,
            resource: 'rubric_criteria',
            values
        });
    }, [updateResource]);
    const updateCheckIfChanged = useCallback(async (check: HydratedRubricCheck, existingCheck: HydratedRubricCheck) => {
        if (check.id !== existingCheck.id) {
            return { toCreate: [], toUpdate: [], toDelete: [] };
        }
        const updatedPropertyNames = findUpdatedPropertyNames(check, existingCheck);
        if (updatedPropertyNames.length === 0) {
            return;
        }
        const values = updatedPropertyNames.reduce((acc, curr) => ({
            ...acc,
            [curr]: check[curr]
        }), {});
        await updateResource({
            id: check.id,
            resource: 'rubric_checks',
            values
        });
    }, [updateResource]);
    const saveRubric = useCallback(async () => {
        if (!rubric || !existingRubric) return;

        const findChanges = <T extends { id: number | undefined }>(newItems: T[], existingItems: T[]): {
            toCreate: T[];
            toUpdate: T[];
            toDelete: number[];
        } => {
            const existingIds = new Set(existingItems.map(item => item.id).filter((id): id is number => id !== undefined));
            const newIds = new Set(newItems.map(item => item.id).filter((id): id is number => id !== undefined));

            return {
                toCreate: newItems.filter(item => !item.id || !existingIds.has(item.id)),
                toUpdate: newItems.filter(item => item.id && existingIds.has(item.id)),
                toDelete: Array.from(existingIds).filter(id => !newIds.has(id))
            };
        };

        const partChanges = findChanges(rubric.rubric_parts, existingRubric.rubric_parts);

        const allExistingCriteria = existingRubric.rubric_parts.flatMap(part => part.rubric_criteria);
        const allNewCriteria = rubric.rubric_parts.flatMap(part => part.rubric_criteria);
        const criteriaChanges = findChanges(allNewCriteria, allExistingCriteria);

        const allExistingChecks = allExistingCriteria.flatMap(criteria => criteria.rubric_checks);
        const allNewChecks = allNewCriteria.flatMap(criteria => criteria.rubric_checks);
        const checkChanges = findChanges(allNewChecks, allExistingChecks);

        await Promise.all(checkChanges.toDelete.map(id => deleteResource({
            id,
            resource: 'rubric_checks',
            errorNotification: (error) => {
                toaster.create({
                    title: 'Failed to delete check',
                    description: 'The check could not be deleted because of an error: ' + error,
                    type: 'error'
                })
                return false;
            }
        })));

        await Promise.all(criteriaChanges.toDelete.map(id => deleteResource({
            id,
            resource: 'rubric_criteria'
        })));

        await Promise.all(partChanges.toUpdate.map(part => updatePartIfChanged(part, existingRubric.rubric_parts.find(p => p.id === part.id) as HydratedRubricPart)));
        await Promise.all(partChanges.toDelete.map(id => deleteResource({
            id,
            resource: 'rubric_parts'
        })));
        await Promise.all(partChanges.toCreate.map(async part => {
            part.class_id = assignment.data?.data.class_id || 0;
            part.rubric_id = assignment.data?.data.rubrics.id || 0;

            const createdPart = await createResource({
                resource: 'rubric_parts',
                values: part
            })
            if (!createdPart.data.id) {
                throw new Error('Failed to create part');
            }
            part.id = createdPart.data.id as number;
        }));

        //Update the IDs of the criteria
        rubric.rubric_parts.forEach(part => {
            part.rubric_criteria.forEach(criteria => {
                criteria.rubric_part_id = part.id;
                criteria.class_id = part.class_id;
                criteria.rubric_id = part.rubric_id;
            });
        });

        await Promise.all(criteriaChanges.toUpdate.map(criteria => updateCriteriaIfChanged(criteria, existingRubric.rubric_parts.find(p => p.id === criteria.rubric_part_id)?.rubric_criteria.find(c => c.id === criteria.id) as HydratedRubricCriteria)));
        await Promise.all(criteriaChanges.toCreate.map(async criteria => {
            const createdCriteria = await createResource({
                resource: 'rubric_criteria',
                values: criteria
            })
            if (!createdCriteria.data.id) {
                throw new Error('Failed to create criteria');
            }
            criteria.id = createdCriteria.data.id as number;
        }));

        //Update the IDs of the checks
        allNewCriteria.forEach(criteria => {
            criteria.rubric_checks.forEach(check => {
                check.rubric_criteria_id = criteria.id;
                check.class_id = criteria.class_id;
            });
        });


        await Promise.all(checkChanges.toUpdate.map(check => updateCheckIfChanged(check, allExistingChecks.find(c => c.id === check.id) as HydratedRubricCheck)));
        await Promise.all(checkChanges.toCreate.map(async check => {
            check.class_id = assignment.data?.data.class_id || 0;
            check.rubric_criteria_id = assignment.data?.data.rubrics.id || 0;
        }));
    }, [rubric, existingRubric, assignment.data?.data.class_id, assignment.data?.data.rubrics.id]);

    return (<Flex w="100%">
        <Box w="100%">
            <VStack w="100%">
                <HStack w="100%" mt={2} mb={2} justifyContent="space-between">
                    <Toaster />
                    <Heading size="xl">{assignment.data?.data.title} Rubric</Heading>
                    <HStack pr={2}>
                        <Button variant="ghost" colorScheme="gray"
                            onClick={() => {
                                window.history.back();
                            }}>Cancel</Button>
                        <Button colorPalette="green" onClick={async () => {
                            try {
                                await saveRubric();
                                toaster.create({
                                    title: 'Rubric saved',
                                    description: 'The rubric has been saved successfully',
                                    type: 'success'
                                })
                            } catch (error) {
                                toaster.create({
                                    title: 'Failed to save rubric',
                                    description: 'The rubric could not be saved because of an error: ' + error,
                                    type: 'error'
                                })
                            }
                        }}>Save</Button>
                    </HStack>
                </HStack>
                <Editor
                    height="100vh"
                    width="100%"
                    defaultLanguage="yaml"
                    path="rubric.yml"
                    beforeMount={handleEditorWillMount}
                    value={value}
                    theme={colorMode === 'dark' ? 'vs-dark' : 'vs'}
                    onValidate={(markers) => {
                        console.log(markers);
                        if (markers.length > 0) {
                            setError(true);
                            setErrorMarkers(markers);
                        } else {
                            setError(false);
                            setErrorMarkers([]);
                        }
                    }}
                    onChange={(value, event) => {
                        if (value) {
                            setValue(value);
                            if (errorMarkers.length == 0) {
                                try {
                                    setRubric(YamlRubricToHydratedRubric(YAML.parse(value)));
                                    setError(false);
                                } catch (error) {
                                    console.log(error);
                                    setError(true);
                                }
                            }
                        }
                    }}
                />
            </VStack>
        </Box>
        <Box w="lg" position="relative">
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
                        <Text color="fg.error">Error in YAML syntax. Please fix the errors in the editor.</Text>
                        <List.Root>
                            {errorMarkers.map((marker, index) => (
                                <List.Item key={index}>
                                    <Text color="fg.error">Line {marker.startLineNumber}: {marker.message}</Text>
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