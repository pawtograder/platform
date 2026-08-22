/**
 * Disconnect a class from its Discord server.
 *
 * The inverse of the install flow. `claim_discord_guild()` is the only writer of
 * `classes.discord_server_id` and it refuses anything that is not a snowflake, so without this route
 * an instructor who connected the wrong server has no way back -- see
 * `supabase/migrations/20260822140000_discord_guild_disconnect.sql`.
 *
 * POST rather than GET, because it changes state: a GET here would be triggerable by any image tag
 * pointed at the URL. Supabase's session cookies are `SameSite=Lax`, which already means a
 * cross-site POST arrives without them and so fails the instructor check, but the `Sec-Fetch-Site`
 * check below makes that a deliberate property of this route rather than a side effect of cookie
 * defaults elsewhere.
 *
 * There is no confirmation step here; the UI owns that. What this route guarantees is that a
 * disconnect is authorized, attributed, and idempotent.
 */
import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/client";
import { isInstructorOfClass } from "@/lib/lti/auth";
import { manageDiscordPageUrl } from "@/lib/discordInstall";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** What disconnect_discord_guild() returns. One row. */
type DisconnectRow = {
  class_id: number;
  previous_guild_id: string | null;
};

export async function POST(request: NextRequest) {
  const scope = Sentry.getCurrentScope();
  scope.setTag("endpoint", "discord_disconnect");

  // Same-origin only. Browsers that send Sec-Fetch-Site are held to it; older ones fall through to
  // the session and instructor checks below, which a cross-site caller cannot satisfy anyway.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    scope.setTag("error_type", "cross_site");
    return NextResponse.json({ error: "Cross-site requests are not allowed" }, { status: 403, headers: NO_STORE });
  }

  // Accept the class id from a form post or a JSON body, so the UI can use either.
  let rawClassId: string | null = null;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => null);
    const value = (body as { class_id?: unknown } | null)?.class_id;
    rawClassId = value === undefined || value === null ? null : String(value);
  } else {
    const form = await request.formData().catch(() => null);
    const value = form?.get("class_id");
    rawClassId = typeof value === "string" ? value : null;
  }

  const classId = Number(rawClassId);
  if (!rawClassId || !Number.isInteger(classId) || classId <= 0) {
    return NextResponse.json({ error: "A valid class_id is required" }, { status: 400, headers: NO_STORE });
  }
  scope.setTag("class_id", String(classId));

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: NO_STORE });
  }
  if (!(await isInstructorOfClass(supabase, classId))) {
    scope.setTag("error_type", "not_instructor");
    return NextResponse.json(
      { error: "You must be an instructor of this course to disconnect its Discord server." },
      { status: 403, headers: NO_STORE }
    );
  }

  // Admin client: disconnect_discord_guild() is granted to service_role only, for the same reason as
  // claim_discord_guild() -- between them they are the only writers of discord_server_id, and an
  // instructor must not be able to reach either directly. The actor is passed explicitly because a
  // service-role call carries no auth.uid(), and the function re-checks that they are staff.
  //
  // Type-erased because the RPC lands with migration 20260822140000 and SupabaseTypes.d.ts is
  // regenerated centrally once all of this branch's migrations are in.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = (await admin.rpc("disconnect_discord_guild", {
    p_class_id: classId,
    p_actor: user.id
  })) as { data: DisconnectRow[] | null; error: { message: string; code?: string } | null };

  if (error) {
    if (error.message.includes("DISCORD_CLAIM_FORBIDDEN")) {
      scope.setTag("error_type", "disconnect_forbidden");
      return NextResponse.json(
        { error: "You must be an instructor of this course to disconnect its Discord server." },
        { status: 403, headers: NO_STORE }
      );
    }
    scope.setTag("error_type", "disconnect_failed");
    Sentry.captureException(new Error(`disconnect_discord_guild failed: ${error.message}`), scope);
    // Fixed sentence, not `error.message`: the same reasoning as the install callback. Raw Postgres
    // text names internals, and this string ends up in the URL as well as on the page.
    return NextResponse.redirect(
      manageDiscordPageUrl(request, classId, {
        error: "discord_disconnect_failed",
        errorDescription: "The Discord server could not be disconnected. The error has been reported."
      }),
      { status: 303 }
    );
  }

  // A null previous guild means there was nothing connected. Reported as "noop" rather than as a
  // success so the page can stay quiet instead of claiming it tore something down.
  const previous = data?.[0]?.previous_guild_id ?? null;
  // eslint-disable-next-line no-console
  console.log(
    previous
      ? `[discord disconnect] class ${classId} released guild ${previous} by ${user.id}`
      : `[discord disconnect] class ${classId} was already disconnected`
  );

  // 303 so the browser follows with GET; a 302 on a POST is honoured inconsistently.
  return NextResponse.redirect(manageDiscordPageUrl(request, classId, { disconnected: previous ? "1" : "noop" }), {
    status: 303
  });
}
