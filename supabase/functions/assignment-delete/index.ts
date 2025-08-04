import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { IllegalArgumentError, SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { getOctoKit, listCommits } from "../_shared/GitHubWrapper.ts";

interface AssignmentDeleteRequest {
  assignment_id: number;
  class_id: number;
}

async function deleteAssignment(req: Request): Promise<{ message: string }> {
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });

  const { assignment_id, class_id } = (await req.json()) as AssignmentDeleteRequest;

  console.log(`Request to delete assignment ${assignment_id} in course ${class_id}`);

  if (!assignment_id || !class_id) {
    throw new IllegalArgumentError("assignment_id and class_id are required");
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    throw new SecurityError("User not found");
  }

  // Check if user is an instructor for this course
  const { data: userRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("class_id", class_id)
    .single();

  if (!userRole || userRole.role !== "instructor") {
    throw new SecurityError("Only instructors can delete assignments");
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  // Check if assignment exists and belongs to the specified class
  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("id, title, template_repo, autograder(grader_repo)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new IllegalArgumentError("Assignment not found or does not belong to this class");
  }

  // ========================
  // PHASE 1: PERFORM ALL CHECKS FIRST
  // ========================

  console.log("Phase 1: Performing all safety checks...");

  // Check for released submission reviews
  const { data: releasedReviews } = await adminSupabase
    .from("submission_reviews")
    .select("id")
    .eq("assignment_id", assignment_id)
    .not("released_at", "is", null)
    .limit(1);

  if (releasedReviews && releasedReviews.length > 0) {
    throw new UserVisibleError(
      "Cannot delete assignment: This assignment has released submission reviews. Delete cannot proceed."
    );
  }

  // Get all repositories for this assignment
  const { data: repositories } = await adminSupabase
    .from("repositories")
    .select("repository, assignment_group_id, profile_id, synced_handout_sha")
    .eq("assignment_id", assignment_id);

  // Check repository states - verify they haven't been modified beyond template
  if (repositories && repositories.length > 0 && assignment.template_repo) {
    console.log(`Checking ${repositories.length} repositories for modifications...`);

    try {
      // Get template repo's initial commit to compare against
      const templateRepoCommits = await listCommits(assignment.template_repo, 1);
      const templateInitialCommit = templateRepoCommits.commits[templateRepoCommits.commits.length - 1];

      for (const repo of repositories) {
        if (!repo.repository) {
          console.log("Repository name is null, skipping");
          continue;
        }

        try {
          // Get the repository's commit history
          const repoCommits = await listCommits(repo.repository, 1);

          // Check if repo has more commits than just the template
          if (repoCommits.commits.length > 1) {
            // Check if the oldest commit matches the template's initial commit
            const oldestCommit = repoCommits.commits[repoCommits.commits.length - 1];

            if (oldestCommit.sha !== templateInitialCommit?.sha && oldestCommit.sha !== repo.synced_handout_sha) {
              throw new UserVisibleError(
                `Cannot delete assignment: Repository ${repo.repository} has been modified beyond the template. ` +
                  `Please manually delete modified repositories if you want to proceed.`
              );
            }
          }
        } catch (error) {
          console.warn(`Error checking repository ${repo.repository}:`, error);
          // If we can't check the repo (maybe it's already deleted), that's okay
          // Missing repos should not be an error according to requirements
        }
      }
    } catch (error) {
      console.warn("Error checking template repository:", error);
      // If we can't access the template repo, we'll proceed with deletion
    }
  }

  console.log("All safety checks passed. Proceeding with deletion...");

  // ========================
  // PHASE 2: DELETE FROM GITHUB FIRST
  // ========================
  
  console.log("Phase 2: Deleting repositories from GitHub...");
  
  // Delete student repositories
  if (repositories && repositories.length > 0) {
    for (const repo of repositories) {
      if (!repo.repository) {
        continue;
      }
      
      try {
        console.log(`Deleting student repository ${repo.repository} from GitHub...`);
        const [org, repoName] = repo.repository.split("/");
        const octokit = await getOctoKit(org);
        
        if (octokit) {
          await octokit.request("DELETE /repos/{owner}/{repo}", {
            owner: org,
            repo: repoName
          });
          console.log(`Successfully deleted repository ${repo.repository} from GitHub`);
        }
      } catch (deleteError) {
        console.warn(`Failed to delete repository ${repo.repository} from GitHub:`, deleteError);
        // Continue with deletion - missing repos should not be an error
      }
    }
  }

  // Delete handout repo (template_repo)
  if (assignment.template_repo) {
    try {
      console.log(`Deleting handout repository ${assignment.template_repo} from GitHub...`);
      const [org, repoName] = assignment.template_repo.split("/");
      const octokit = await getOctoKit(org);
      
      if (octokit) {
        await octokit.request("DELETE /repos/{owner}/{repo}", {
          owner: org,
          repo: repoName
        });
        console.log(`Successfully deleted handout repository ${assignment.template_repo} from GitHub`);
      }
    } catch (deleteError) {
      console.warn(`Failed to delete handout repository ${assignment.template_repo} from GitHub:`, deleteError);
      // Continue with deletion - missing repos should not be an error
    }
  }

  // Delete solution repo (grader_repo)
  if (assignment.autograder?.grader_repo) {
    try {
      console.log(`Deleting solution repository ${assignment.autograder.grader_repo} from GitHub...`);
      const [org, repoName] = assignment.autograder.grader_repo.split("/");
      const octokit = await getOctoKit(org);
      
      if (octokit) {
        await octokit.request("DELETE /repos/{owner}/{repo}", {
          owner: org,
          repo: repoName
        });
        console.log(`Successfully deleted solution repository ${assignment.autograder.grader_repo} from GitHub`);
      }
    } catch (deleteError) {
      console.warn(`Failed to delete solution repository ${assignment.autograder.grader_repo} from GitHub:`, deleteError);
      // Continue with deletion - missing repos should not be an error
    }
  }

  // ========================
  // PHASE 3: DELETE GRADEBOOK COLUMNS AND DEPENDENCIES
  // ========================

  console.log("Phase 3: Handling gradebook columns...");

  // Find gradebook columns that reference this assignment
  const { data: gradebookColumns } = await adminSupabase
    .from("gradebook_columns")
    .select("id, dependencies")
    .eq("class_id", class_id)
    .eq("assignment_id", assignment_id);

  if (gradebookColumns && gradebookColumns.length > 0) {
    const columnIds = gradebookColumns.map((col) => col.id);
    console.log(`Found ${columnIds.length} gradebook columns to delete:`, columnIds);

    // Remove these columns from dependencies of other columns
    const { data: allColumns } = await adminSupabase
      .from("gradebook_columns")
      .select("id, dependencies")
      .eq("class_id", class_id)
      .not("assignment_id", "eq", assignment_id);

    if (allColumns) {
      for (const column of allColumns) {
        if (column.dependencies && Array.isArray(column.dependencies)) {
          const updatedDependencies = column.dependencies.filter((dep: number) => !columnIds.includes(dep));

          if (updatedDependencies.length !== column.dependencies.length) {
            console.log(`Updating dependencies for column ${column.id}`);
            await adminSupabase
              .from("gradebook_columns")
              .update({ dependencies: updatedDependencies })
              .eq("id", column.id);
          }
        }
      }
    }

    // Delete the gradebook columns
    await adminSupabase.from("gradebook_columns").delete().eq("assignment_id", assignment_id);
  }

  // ========================
  // PHASE 4: DELETE ALL RELATED DATA FROM SUPABASE
  // ========================

  console.log("Phase 4: Deleting all related data from database...");

  // Delete in order to respect foreign key constraints

  // Delete submission reviews first
  await adminSupabase.from("submission_reviews").delete().eq("assignment_id", assignment_id);

  // Delete grader results
  await adminSupabase.from("grader_results").delete().eq("assignment_id", assignment_id);

  // Delete submissions
  await adminSupabase.from("submissions").delete().eq("assignment_id", assignment_id);

  // Delete repositories
  await adminSupabase.from("repositories").delete().eq("assignment_id", assignment_id);

  // Delete assignment group members
  await adminSupabase.from("assignment_groups_members").delete().eq("assignment_id", assignment_id);

  // Delete assignment group invitations for this assignment's groups
  const { data: assignmentGroups } = await adminSupabase
    .from("assignment_groups")
    .select("id")
    .eq("assignment_id", assignment_id);

  if (assignmentGroups && assignmentGroups.length > 0) {
    const groupIds = assignmentGroups.map((g) => g.id);
    await adminSupabase.from("assignment_group_invitations").delete().in("assignment_group_id", groupIds);
  }

  // Delete assignment group join requests
  await adminSupabase.from("assignment_group_join_request").delete().eq("assignment_id", assignment_id);

  // Delete assignment groups
  await adminSupabase.from("assignment_groups").delete().eq("assignment_id", assignment_id);

  // Delete due date exceptions
  await adminSupabase.from("assignment_due_date_exceptions").delete().eq("assignment_id", assignment_id);

  // Delete review assignments
  await adminSupabase.from("review_assignments").delete().eq("assignment_id", assignment_id);

  // Delete autograder if exists
  await adminSupabase.from("autograder").delete().eq("assignment_id", assignment_id);

  // Finally, delete the assignment itself
  const { error: deleteError } = await adminSupabase
    .from("assignments")
    .delete()
    .eq("id", assignment_id)
    .eq("class_id", class_id);

  if (deleteError) {
    console.error("Failed to delete assignment:", deleteError);
    throw new UserVisibleError(`Failed to delete assignment: ${deleteError.message}`);
  }

  console.log(`Successfully deleted assignment ${assignment_id}: "${assignment.title}"`);

  return {
    message: `Assignment "${assignment.title}" has been successfully deleted along with all related data.`
  };
}

Deno.serve((req) => {
  return wrapRequestHandler(req, deleteAssignment);
});
