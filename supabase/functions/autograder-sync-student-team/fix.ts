import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.3/dist/module/index.js";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { syncStudentTeam } from "../_shared/GitHubWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

async function main() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const f25Classes = await adminSupabase.from("classes").select("*").eq("slug", "f25").limit(1000);
  if (f25Classes.error) {
    throw new Error("Error fetching f25 classes");
  }
  for (const classData of f25Classes.data!) {
    // Guard against null/undefined github_org
    if (!classData.github_org) {
      console.warn(`Skipping class ${classData.slug || classData.id}: github_org is null or undefined`);
      continue;
    }

    await syncStudentTeam(classData.github_org, classData.slug!, async () => {
      const { data: students, error: studentsError } = await adminSupabase
        .from("user_roles")
        .select("users(github_username)")
        .eq("class_id", classData.id)
        .eq("role", "student")
        .eq("github_org_confirmed", true)
        .limit(1000);
      if (studentsError) {
        console.error(studentsError);
        throw new UserVisibleError("Error fetching students");
      }
      return students!.filter((s) => s.users.github_username).map((s) => s.users.github_username!);
    });
  }
}
main();
