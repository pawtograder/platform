import { ListReposResponse } from "@/components/github/GitHubTypes";
import { fetchGetFileFromRepo } from "@/lib/generated/pawtograderComponents";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import yaml from 'yaml';
import { Alert } from "@/components/ui/alert";
import Markdown from "react-markdown";
import { Box, Button, Heading, Text } from "@chakra-ui/react";
import { AutograderRegressionTest } from "@/utils/supabase/DatabaseTypes";
import { useList } from "@refinedev/core";
export default function AutograderConfiguration({ graderRepo }: { graderRepo: ListReposResponse[0] }) {
    const [autograderConfig, setAutograderConfig] = useState<string>();
    const [error, setError] = useState<string>();
    const { course_id, assignment_id } = useParams();
    const {data : regressionTests, error: regressionTestsError} = useList<AutograderRegressionTest>({
        resource: "autograder_regression_tests",
        meta: {
            select: "*"
        },
        pagination: {
            pageSize: 1000
        },
        filters: [
            { field: "autograder_id", operator: "eq", value: Number(assignment_id) }
        ]
    });
    useEffect(() => {
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
                console.log(config);
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
    return <div>
        {error && <Alert status="error">{error}</Alert>}
        <Heading as="h2">Regression Testing</Heading>
        <Alert status="info">
            Automatically run a smoke test of the autograder on a selection of student submissions.
            If enabled, a new autograder won't be published until the smoke test passes.
        </Alert>
    </div>
}