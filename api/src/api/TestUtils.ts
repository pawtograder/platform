import GitHubController, { GitHubOIDCToken } from "../GitHubController.js";
import {jest} from '@jest/globals'

export function mockGitHubOIDC({ repository, sha, workflow_ref }: Pick<GitHubOIDCToken, 'repository' | 'sha' | 'workflow_ref'>) {
    const spy = jest.spyOn(GitHubController.getInstance(), 'validateOIDCToken')
    const retVal: GitHubOIDCToken = {
        "jti": "e1b14567-1b0b-4e34-8599-77918c24da7e",
        "sub": "repo:neu-se/autograder-action:ref:refs/heads/main",
        "aud": "https://github.com/neu-se",
        "ref": "refs/heads/main",
        sha,
        repository,
        "repository_owner": "neu-se",
        "repository_owner_id": "76491096",
        "run_id": "13033167167",
        "run_number": "18",
        "run_attempt": "1",
        "repository_visibility": "public",
        "repository_id": "922761846",
        "actor_id": "2130186",
        "actor": "jon-bell",
        "workflow": "ignore",
        workflow_ref,
        "head_ref": "",
        "base_ref": "",
        "event_name": "push",
        "ref_protected": "false",
        "ref_type": "branch",
        "workflow_sha": "763de74e3977eb9ae398e8b34d8a8ac14185dde0",
        "job_workflow_ref": "neu-se/autograder-action/.github/workflows/ci.yml@refs/heads/main",
        "job_workflow_sha": "763de74e3977eb9ae398e8b34d8a8ac14185dde0",
        "runner_environment": "github-hosted",
        "enterprise_id": "521",
        "enterprise": "northeastern-university",
        "iss": "https://token.actions.githubusercontent.com",
        "nbf": 1738159301,
        "exp": 1738160201,
        "iat": 1738159901
    };
    spy.mockResolvedValueOnce(retVal);

    return spy;
}