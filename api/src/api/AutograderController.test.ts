import { AutograderController } from "./AutograderController.js";
import GitHubController from "../GitHubController.js";
import { App } from "@octokit/app";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { configDotenv } from "dotenv";
import { mockGitHubOIDC } from "./TestUtils.js";

describe('AutograderController', () => {
    let spy: jest.SpyInstance;
    let controller = new AutograderController();
    beforeAll(async () => {
        configDotenv();
        const app = new App({
            authStrategy: createAppAuth,
            appId: process.env.GITHUB_APP_ID || -1,
            privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_FILE || 'process.env.GITHUB_PRIVATE_KEY_FILE is blank!', 'utf8'),
            oauth: {
                clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
                clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
            },
            webhooks: {
                secret: process.env.GITHUB_WEBHOOK_SECRET || '',
            },
        });
        GitHubController.initialize(app);
        await GitHubController.getInstance().initializeApp();
    })
    beforeEach(() => {
        controller = new AutograderController();
        const repository = "autograder-dev/f24-democlass-final-ripley0";
        const sha = "2ab352f6ed9d1a93f4a47c919f3fdaf4b6e5c02d";
        const workflow_ref = `${repository}/.github/workflows/grade.yml@refs/heads/main`;
        spy = mockGitHubOIDC({ repository, sha, workflow_ref });
    });
    afterEach(() => {
        spy.mockRestore();
    });
    describe("createSubmission", () => {
        it('checks the SHA of the workflow file', async () => {
            await controller.createSubmission('token');
            expect(spy).toHaveBeenCalled();
            expect(true).toBeTruthy();

        });
    });
});