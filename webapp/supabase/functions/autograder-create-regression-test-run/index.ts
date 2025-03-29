// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { Database } from "../_shared/SupabaseTypes.d.ts";
import { validateOIDCToken, getRepoTarballURL } from "../_shared/GitHubWrapper.ts";
import {
  SecurityError,
  UserVisibleError,
  wrapRequestHandler,
} from "../_shared/HandlerUtils.ts";
console.log("Hello from Functions!");
async function handleRequest(req: Request) {
  const url = req.url;
  const lastURLPart = url.split("/").pop();
  if (!lastURLPart) {
    throw new UserVisibleError("Invalid regression test ID");
  }
  const regression_test_id = parseInt(lastURLPart);
  if (isNaN(regression_test_id)) {
    throw new UserVisibleError("Invalid regression test ID");
  }

  const decoded = await validateOIDCToken(
    req.headers.get("Authorization")!,
  );
  const { repository, sha, workflow_ref } = decoded;
  console.log(
    "Creating regression test run for",
    repository,
    sha,
    workflow_ref,
    regression_test_id,
  );

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );
  const { data: graderData } = await adminSupabase.from("autograder").select(
    "*, assignments(id, submission_files, class_id)",
  ).eq("grader_repo", repository).limit(1).single();
  if (graderData) {
    //It's a grader repo
    if (
      !workflow_ref.endsWith(
        `.github/workflows/regression-test.yml@refs/heads/main`,
      )
    ) {
      throw new Error(`Invalid workflow, got ${workflow_ref}`);
    }
    try {
      //Validate that the regression test repo is registered for this grader
      const { data: regressionTestRepoData } = await adminSupabase.from(
        "autograder_regression_test_by_grader",
      ).select(
        "*",
      ).eq("id", regression_test_id)
        .eq("grader_repo", graderData.grader_repo!)
        .limit(1).single();
      if (!regressionTestRepoData) {
        throw new SecurityError(
          `Regression test repo not found for grader ${graderData.grader_repo} and test id ${regression_test_id}`,
        );
      }
      if (!regressionTestRepoData.sha) {
        throw new UserVisibleError(
          `Regression test repo has no SHA: ${regressionTestRepoData.repository}`,
        );
      }
      const { download_link: regression_test_url } = await getRepoTarballURL(
        regressionTestRepoData.repository!,
        regressionTestRepoData.sha,
      );

      console.log("Grader URL:", regression_test_url);

      const patchedURL= regression_test_url.replace("http://kong:8000","https://khoury-classroom-dev.ngrok.pizza")
      console.log("Patched URL:", patchedURL);

      return {
        regression_test_url: patchedURL,
        regression_test_sha: regressionTestRepoData.sha,
      };
    } catch (err) {
      console.error(err);
      // TODO update the submission status to failed, save error, etc

      throw err;
    }
  } else {
    throw new SecurityError(`Repository not found: ${repository}`);
  }
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
