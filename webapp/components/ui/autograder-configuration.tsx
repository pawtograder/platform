import { ListReposResponse } from "@/components/github/GitHubTypes";
import { fetchGetFileFromRepo } from "@/lib/generated/pawtograderComponents";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import yaml from 'yaml';
import { Alert } from "@/components/ui/alert";
import Markdown from "react-markdown";
import { Box, Button, Heading, Spinner, Link, Table, Text } from "@chakra-ui/react";
import { Checkbox } from "@/components/ui/checkbox"

import { AutograderRegressionTest, Repository } from "@/utils/supabase/DatabaseTypes";
import { useCreate, useDelete, useList, useUpdate } from "@refinedev/core";
export default function AutograderConfiguration({ graderRepo }: { graderRepo: ListReposResponse[0]|undefined }) {
    const [autograderConfig, setAutograderConfig] = useState<string>();
    const [selectedRepos, setSelectedRepos] = useState<string[]>([]);

    const [error, setError] = useState<string>();
    const { course_id, assignment_id } = useParams();
    const { mutateAsync: createRegressionTest } = useCreate<AutograderRegressionTest>({
        resource: "autograder_regression_test",
    });
    const { mutateAsync: deleteRegressionTest } = useDelete<AutograderRegressionTest>({
    });
    const [saveLoading, setSaveLoading] = useState(false);
    const { data: repos, error: reposError, isLoading: reposLoading } = useList<Repository>({
        resource: "repositories",
        meta: {
            select: "*"
        },
        filters: [
            { field: 'assignment_id', operator: 'eq', value: Number(assignment_id) }
        ]
    });
    const { data: regressionTestRepos, error: regressionTestReposError, isLoading: regressionTestReposLoading } = useList<AutograderRegressionTest>({
        resource: "autograder_regression_test",
        meta: {
            select: "*"
        },
        filters: [
            { field: 'autograder_id', operator: 'eq', value: Number(assignment_id) }
        ]
    });
    useEffect(() => {
        if (!graderRepo) {
            return;
        }
        fetchGetFileFromRepo({
            pathParams: {

                courseId: Number(course_id),
                orgName: graderRepo.owner.login,
                repoName: graderRepo.name,
                path: 'pawtograder.yml'
            }
        }).then((res) => {
            if ('content' in res) {
                const config = Buffer.from(res.content, 'base64').toString();
                setAutograderConfig(config);
            }
        }).catch((err) => {
            if (err.stack.message === 'Not Found') {
                setError(`Autograder configuration file not found in ${graderRepo.owner.login}/${graderRepo.name}. Please create a pawtograder.yml file in the root of the repository.`);
                setAutograderConfig(undefined);
            } else {
                console.log("Error fetching autograder configuration", err);
                // throw err;
            }
        });
    }, [graderRepo]);
    const saveRegressionTests = useCallback(async () => {
        setSaveLoading(true);
        const additions = selectedRepos.filter((r) => !regressionTestRepos?.data.some((rt) => rt.repository === r));
        const deletions = regressionTestRepos?.data.filter((rt) => !selectedRepos.includes(rt.repository)).map((rt) => rt.id);
        async function saveAdditions() {
            return Promise.all(additions.map(async (repo) => {
                await createRegressionTest({
                    values: {
                        autograder_id: Number(assignment_id),
                        repository: repo
                    }
                });
            }));
        }
        async function saveDeletions() {
            if (deletions)
                return Promise.all(deletions.map(async (id) => {
                    await deleteRegressionTest({
                        resource: "autograder_regression_test",
                        id: id
                    });
                }));
        }
        await Promise.all([saveAdditions(), saveDeletions()]);
        setSaveLoading(false);
    }, [selectedRepos, regressionTestRepos]);
    const toggleRepo = useCallback((repo: string) => {
        setSelectedRepos((oldRepos) => {
            if (oldRepos.includes(repo)) {
                return oldRepos.filter((r) => r !== repo);
            } else {
                return [...oldRepos, repo];
            }
        })
    }, [setSelectedRepos]);
    useEffect(() => {
        if (regressionTestRepos?.data) {
            setSelectedRepos(regressionTestRepos.data.map((r) => r.repository));
        }
    }, [regressionTestRepos?.data]);
    if (regressionTestReposLoading || reposLoading) {
        return <Spinner />
    }
    const allRepos = new Set<string>((repos?.data.map((r) => r.repository) ?? []).concat(regressionTestRepos?.data.map((r) => r.repository) ?? []));
    const allReposArray = Array.from(allRepos);
    allReposArray.sort();
    return <div>
        {error && <Alert status="error">{error}</Alert>}
        <Heading as="h2">Regression Testing</Heading>
        <Alert status="info">
            Automatically run a smoke test of the autograder on a selection of student submissions.
            If enabled, a new autograder won't be published until the smoke test passes.
        </Alert>
        <Table.Root >
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
                        <Table.Cell><Link onClick={() => toggleRepo(repo)}>{repo}</Link></Table.Cell>
                    </Table.Row>
                ))}
            </Table.Body>
        </Table.Root>
        <Button disabled={saveLoading} loading={saveLoading} onClick={() => saveRegressionTests()}>Save</Button>
    </div>
}