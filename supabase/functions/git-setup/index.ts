import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { forgejoUrl, rotateUserToken } from "../_shared/ForgejoWrapper.ts";
import {
  assertUserIsInCourse,
  readJsonObjectBody,
  SecurityError,
  UserVisibleError,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_NAME = "pawtograder-local";
const TOKEN_SCOPES = ["write:repository"];

type Shell = "sh" | "ps1";

export type GitSetupCreateResponse = { code: string; expires_at: string };

function adminClient() {
  return createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: REQUEST_SCOPED_AUTH_OPTIONS
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createCode(req: Request, scope: Sentry.Scope): Promise<GitSetupCreateResponse> {
  const body = await readJsonObjectBody(req);
  const classId = Number(body.class_id);
  if (!Number.isInteger(classId)) {
    throw new UserVisibleError("class_id is required", 400);
  }
  scope?.setTag("class_id", String(classId));
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new SecurityError("Missing Authorization header");
  }
  const { enrollment } = await assertUserIsInCourse(classId, authHeader);
  const admin = adminClient();

  const { data: klass } = await admin.from("classes").select("git_provider").eq("id", classId).single();
  if (klass?.git_provider !== "forgejo") {
    throw new UserVisibleError("This class does not use Forgejo", 400);
  }
  const { data: account } = await admin
    .from("git_accounts")
    .select("login")
    .eq("user_id", enrollment.user_id)
    .eq("provider", "forgejo")
    .eq("instance_url", forgejoUrl())
    .maybeSingle();
  if (!account) {
    throw new UserVisibleError(
      "Your Forgejo account has not been created yet. It is created when your instructor sets up the course.",
      409
    );
  }

  const code = randomCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const { error } = await admin.from("git_setup_codes").insert({
    code_hash: await sha256Hex(code),
    user_id: enrollment.user_id,
    class_id: classId,
    expires_at: expiresAt
  });
  if (error) {
    throw new Error(`Could not store setup code: ${error.message}`);
  }
  return { code, expires_at: expiresAt };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type ScriptInput = {
  host: string;
  login: string;
  token: string | null;
  cloneUrls: string[];
  gitName: string | null;
  gitEmail: string | null;
};

function shScript(input: ScriptInput): string {
  const token = input.token ?? "<your token is inserted here when you run the real command>";
  return `#!/bin/sh
# Pawtograder git setup for ${input.login} on ${input.host}.
# The link that served this script has now been used up. It stores a push/pull-only token for
# ${input.host} in git's credential helper and clones your course repositories into this folder.
set -e
HOST=${shQuote(input.host)}
LOGIN=${shQuote(input.login)}
TOKEN=${shQuote(token)}

if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed. On macOS run: xcode-select --install   On Linux, install git with your package manager."
  exit 1
fi

# Everything below is scoped to $HOST, so github.com logins and settings are left alone.
# Use the helper git already has (Keychain on macOS, Git Credential Manager on Windows). With none,
# or only the in-memory cache (which forgets after 15 minutes), add a persistent one for this host.
case "$(git config --get-urlmatch credential.helper "https://$HOST" 2>/dev/null)" in
  "" | cache*)
    case "$(uname -s)" in
      Darwin) git config --global "credential.https://$HOST.helper" osxkeychain ;;
      *) git config --global "credential.https://$HOST.helper" store ;;
    esac ;;
esac
git config --global "credential.https://$HOST.username" "$LOGIN"

# Replace any token saved by an earlier setup, then save this one.
printf 'protocol=https\\nhost=%s\\nusername=%s\\n\\n' "$HOST" "$LOGIN" | git credential reject
printf 'protocol=https\\nhost=%s\\nusername=%s\\npassword=%s\\n\\n' "$HOST" "$LOGIN" "$TOKEN" | git credential approve
${input.cloneUrls
  .map(
    (url) => `url=${shQuote(url)}
dir=$(basename "$url" .git)
if [ -d "$dir" ]; then echo "$dir already exists here, skipping clone."; else git clone "$url"; fi${
      input.gitName && input.gitEmail
        ? `
# Commits need a name and email. Only when git has none at all, set them in this repo alone.
git -C "$dir" config user.name >/dev/null 2>&1 || git -C "$dir" config user.name ${shQuote(input.gitName)}
git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email ${shQuote(input.gitEmail)}`
        : ""
    }`
  )
  .join("\n")}

echo ""
echo "Git is set up for $HOST as $LOGIN. Push with: git push"
`;
}

function ps1Script(input: ScriptInput): string {
  const token = input.token ?? "<your token is inserted here when you run the real command>";
  return `# Pawtograder git setup for ${input.login} on ${input.host}.
# The link that served this script has now been used up. It stores a push/pull-only token for
# ${input.host} in git's credential helper and clones your course repositories into this folder.
$ErrorActionPreference = 'Stop'
$HostName = ${psQuote(input.host)}
$Login = ${psQuote(input.login)}
$Token = ${psQuote(token)}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'git is not installed. Install Git for Windows from https://git-scm.com/download/win and run this again.'
  return
}

# Everything below is scoped to this host, so github.com logins and settings are left alone.
$helper = git config --get-urlmatch credential.helper "https://$HostName" 2>$null
if (-not $helper -or $helper -like 'cache*') { git config --global "credential.https://$HostName.helper" manager }
git config --global "credential.https://$HostName.username" $Login

# Replace any token saved by an earlier setup, then save this one. git reads CRLF fine, so the
# line ending PowerShell adds when piping to a native command does no harm.
"protocol=https\`nhost=$HostName\`nusername=$Login\`n" | git credential reject
"protocol=https\`nhost=$HostName\`nusername=$Login\`npassword=$Token\`n" | git credential approve
${input.cloneUrls
  .map(
    (url) => `$url = ${psQuote(url)}
$dir = [System.IO.Path]::GetFileNameWithoutExtension($url)
if (Test-Path $dir) { Write-Host "$dir already exists here, skipping clone." } else { git clone $url }${
      input.gitName && input.gitEmail
        ? `
# Only when git has no name/email at all, set them in this repo alone.
if (-not (git -C $dir config user.name)) { git -C $dir config user.name ${psQuote(input.gitName)} }
if (-not (git -C $dir config user.email)) { git -C $dir config user.email ${psQuote(input.gitEmail)} }`
        : ""
    }`
  )
  .join("\n")}

Write-Host ''
Write-Host "Git is set up for $HostName as $Login. Push with: git push"
`;
}

function failureScript(shell: Shell, message: string): string {
  return shell === "ps1" ? `Write-Host ${psQuote(message)}\nreturn\n` : `#!/bin/sh\necho ${shQuote(message)}\nexit 1\n`;
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function serveScript(req: Request, codeOrPreview: string, shell: Shell): Promise<Response> {
  const host = new URL(forgejoUrl()).host;
  const render = shell === "ps1" ? ps1Script : shScript;
  if (codeOrPreview === "preview") {
    return textResponse(
      render({
        host,
        login: "<your-username>",
        token: null,
        cloneUrls: [`${forgejoUrl()}/<course-org>/<assignment>-<your-username>.git`],
        gitName: "<your name>",
        gitEmail: "<your email>"
      })
    );
  }

  const admin = adminClient();
  // Burn the code in the same statement that checks it, so two requests cannot both use it.
  const { data: claimed, error } = await admin
    .from("git_setup_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code_hash", await sha256Hex(codeOrPreview))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("user_id, class_id")
    .maybeSingle();
  if (error) {
    throw new Error(`Setup code lookup failed: ${error.message}`);
  }
  if (!claimed) {
    return textResponse(
      failureScript(shell, "This setup link has expired or was already used. Get a new one from Pawtograder.")
    );
  }

  const [{ data: account }, { data: role }, { data: user }] = await Promise.all([
    admin
      .from("git_accounts")
      .select("login")
      .eq("user_id", claimed.user_id)
      .eq("provider", "forgejo")
      .eq("instance_url", forgejoUrl())
      .single(),
    admin
      .from("user_roles")
      .select("private_profile_id")
      .eq("user_id", claimed.user_id)
      .eq("class_id", claimed.class_id)
      .single(),
    admin.from("users").select("name, email").eq("user_id", claimed.user_id).single()
  ]);
  if (!account || !role) {
    return textResponse(failureScript(shell, "Your Forgejo account is not set up yet. Ask your instructor."));
  }
  const [{ data: repos }, { data: profile }] = await Promise.all([
    admin
      .from("repositories")
      .select("repository")
      .eq("class_id", claimed.class_id)
      .eq("profile_id", role.private_profile_id)
      .eq("git_provider", "forgejo")
      .eq("is_github_ready", true),
    admin.from("profiles").select("name").eq("id", role.private_profile_id).single()
  ]);

  const token = await rotateUserToken(account.login, TOKEN_NAME, TOKEN_SCOPES);
  return textResponse(
    render({
      host,
      login: account.login,
      token,
      cloneUrls: (repos ?? []).map((r) => `${forgejoUrl()}/${r.repository}.git`),
      gitName: user?.name || profile?.name || null,
      gitEmail: user?.email ?? null
    })
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (req.method === "GET" && last && last !== "git-setup") {
    const shell: Shell = url.searchParams.get("shell") === "ps1" ? "ps1" : "sh";
    try {
      return await serveScript(req, last, shell);
    } catch (e) {
      console.error(e);
      Sentry.captureException(e);
      return textResponse(failureScript(shell, "Pawtograder could not set up git right now. Try again in a minute."));
    }
  }
  return await wrapRequestHandler(req, createCode);
});
