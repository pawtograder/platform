/**
 * Classes commands - classes.list, classes.show
 */

import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass } from "../utils/resolvers.ts";
import { assertUserCanAccessClass, listAccessibleClassIds } from "../utils/auth.ts";
import { pageAll } from "../utils/paging.ts";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import type { CLIResponse, ClassesShowParams } from "../types.ts";

async function handleClassesList(ctx: MCPAuthContext, _params: Record<string, unknown>): Promise<CLIResponse> {
  const supabase = getAdminClient();

  // Scoped to the caller's own classes. There is no single class to assert
  // against here, and the query runs on the service-role client, so without this
  // filter the command would enumerate every class on the deployment.
  const accessibleClassIds = await listAccessibleClassIds(supabase, ctx.userId);
  if (accessibleClassIds.length === 0) {
    return { success: true, data: { classes: [] } };
  }

  // Batched and paged: the id set can exceed max_rows on its own, and an
  // unpaged read would cap the result even after draining the role rows.
  // Matches the generated row type: slug and name are nullable, time_zone is not.
  const classes: Array<{
    id: number;
    slug: string | null;
    name: string | null;
    term: number | null;
    github_org: string | null;
    time_zone: string;
    is_demo: boolean;
  }> = [];
  for (let i = 0; i < accessibleClassIds.length; i += 500) {
    const batch = accessibleClassIds.slice(i, i + 500);
    const rows = await pageAll<(typeof classes)[number]>(
      () =>
        supabase
          .from("classes")
          .select("id, slug, name, term, github_org, time_zone, is_demo")
          .in("id", batch)
          .order("id", { ascending: true }),
      "Failed to list classes"
    );
    classes.push(...rows);
  }
  classes.sort((a, b) => b.id - a.id);

  return {
    success: true,
    data: {
      classes: classes.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        term: c.term,
        github_org: c.github_org,
        time_zone: c.time_zone,
        is_demo: c.is_demo
      }))
    }
  };
}

async function handleClassesShow(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { CLICommandError } = await import("../errors.ts");
  const identifier = (params as unknown as ClassesShowParams).identifier;
  if (!identifier) throw new CLICommandError("identifier is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, identifier);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);

  return {
    success: true,
    data: {
      class: {
        id: classData.id,
        slug: classData.slug,
        name: classData.name,
        term: classData.term,
        github_org: classData.github_org,
        time_zone: classData.time_zone,
        is_demo: classData.is_demo
      }
    }
  };
}

registerCommand({
  name: "classes.list",
  requiredScope: "cli:read",
  handler: handleClassesList
});

registerCommand({
  name: "classes.show",
  requiredScope: "cli:read",
  handler: handleClassesShow
});
