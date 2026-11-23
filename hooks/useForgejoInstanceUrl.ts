import { useList } from "@refinedev/core";

// The Forgejo host is the instance of the newest Forgejo account the viewer can see (#1092): their own
// for a student, their class's for staff, and after a FORGEJO_URL change the newest is on the current
// instance. Undefined until it loads, or when the viewer can see no Forgejo account.
export function useForgejoInstanceUrl(enabled = true): string | undefined {
  const { data } = useList<{ instance_url: string }>({
    resource: "git_accounts",
    meta: { select: "instance_url" },
    filters: [
      { field: "provider", operator: "eq", value: "forgejo" },
      { field: "login", operator: "nnull", value: null }
    ],
    sorters: [{ field: "created_at", order: "desc" }],
    pagination: { pageSize: 1 },
    queryOptions: { enabled }
  });
  return data?.data?.[0]?.instance_url;
}

// The web host repos of this provider live on, for links: GitHub, or the Forgejo instance (undefined until known).
export function useRepoWebHost(gitProvider: string | null | undefined): string | undefined {
  const isForgejo = gitProvider === "forgejo";
  const forgejoHost = useForgejoInstanceUrl(isForgejo);
  return isForgejo ? forgejoHost : "https://github.com";
}

export function repoWebUrl(
  host: string | undefined,
  repository: string | null | undefined,
  path = ""
): string | undefined {
  if (!host || !repository) return undefined;
  const base = host.replace(/\/$/, "");
  const webPath =
    base === "https://github.com" ? path : path.replace(/^\/blob\//, "/src/commit/").replace(/^\/pull\//, "/pulls/");
  return `${base}/${repository}${webPath}`;
}
