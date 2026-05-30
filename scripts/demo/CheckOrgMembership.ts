/* eslint-disable no-console */
/**
 * CheckOrgMembership — local diagnostic for the demo "student has not joined
 * course org" problem.
 *
 * Authenticates as the Pawtograder GitHub App using the same env vars and
 * @octokit/auth-app strategy the edge functions use (GitHubWrapper.ts), then:
 *   1. Lists the App's installations and prints the granted permissions for the
 *      target org's installation — `members: read` is what isUserInOrg needs.
 *   2. Runs the EXACT call isUserInOrg makes: GET /orgs/{org}/members/{username},
 *      reporting the raw HTTP status so we can tell 204 (member) from 404
 *      (not a member OR token can't see membership) from 302 (private member).
 *   3. For context, lists the org's members (as the App sees them) and any
 *      pending invitations, so we can spot accepted-vs-pending.
 *
 * Usage:
 *   npx tsx scripts/demo/CheckOrgMembership.ts \
 *       [--org pawtograder-playground] \
 *       --user ripley0 --user orion3100 --user pawsTheTester
 *
 * If no --user is given, defaults to the three demo-fleet logins.
 */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

interface Args {
  org: string;
  users: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { org: "pawtograder-playground", users: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--org") {
      if (!next) throw new Error("--org requires a value");
      out.org = next;
      i++;
    } else if (a === "--user") {
      if (!next) throw new Error("--user requires a value");
      out.users.push(next);
      i++;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: npx tsx scripts/demo/CheckOrgMembership.ts [--org <org>] [--user <login> ...]");
      process.exit(0);
    }
  }
  if (out.users.length === 0) {
    out.users = ["ripley0", "orion3100", "pawsTheTester"];
  }
  return out;
}

function loadPrivateKey(): string {
  const raw = process.env.GITHUB_PRIVATE_KEY_STRING;
  if (!raw) throw new Error("GITHUB_PRIVATE_KEY_STRING is not set in .env.local");
  // .env files commonly store the PEM with literal \n; normalize to real newlines.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

async function main() {
  const args = parseArgs();
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new Error("GITHUB_APP_ID is not set in .env.local");
  const privateKey = loadPrivateKey();

  console.log(`🔑 Authenticating as GitHub App id=${appId}`);

  // App-level client: lists installations + their granted permissions.
  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });

  const installations = await appOctokit.request("GET /app/installations", { per_page: 100 });
  console.log(`\n📦 App is installed on ${installations.data.length} account(s):`);
  for (const inst of installations.data) {
    const login = inst.account && "login" in inst.account ? inst.account.login : "(unknown)";
    console.log(`   • ${login} (installation_id=${inst.id})`);
  }

  const target = installations.data.find(
    (i) => i.account && "login" in i.account && i.account.login.toLowerCase() === args.org.toLowerCase()
  );
  if (!target) {
    throw new Error(
      `The App is NOT installed on org "${args.org}". isUserInOrg would throw "No octokit found for organization". Installed orgs listed above.`
    );
  }

  console.log(`\n🔍 Installation permissions for "${args.org}" (installation_id=${target.id}):`);
  const perms = (target.permissions ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(perms)) {
    console.log(`   ${k}: ${v}`);
  }
  const membersPerm = perms["members"];
  if (!membersPerm) {
    console.log(
      `\n❗ The "members" permission is NOT granted to this installation.\n` +
        `   GET /orgs/{org}/members/{username} returns 404 for genuine members when the\n` +
        `   token lacks org "Members: Read". isUserInOrg collapses that 404 → false, which\n` +
        `   triggers the github_org_confirmed reset. THIS is almost certainly the cause.`
    );
  } else {
    console.log(`\n✓ "members" permission present: ${membersPerm}`);
  }

  // Installation-scoped client: this is what getOctoKit(org) returns, and what
  // isUserInOrg actually calls through.
  const orgOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId: target.id }
  });

  console.log(`\n👥 Per-user membership probe (GET /orgs/${args.org}/members/{username}):`);
  for (const username of args.users) {
    try {
      const resp = await orgOctokit.request("GET /orgs/{org}/members/{username}", {
        org: args.org,
        username
      });
      console.log(`   ✓ ${username}: HTTP ${resp.status} → isUserInOrg=true (member)`);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) {
        console.log(`   ✗ ${username}: HTTP 404 → isUserInOrg=false (not a member, OR token can't see membership)`);
      } else if (status === 302) {
        console.log(`   ~ ${username}: HTTP 302 → isUserInOrg=true (private membership)`);
      } else {
        console.log(`   ⚠ ${username}: HTTP ${status ?? "?"} → isUserInOrg would RETHROW: ${(e as Error).message}`);
      }
    }
  }

  // Context: list members + pending invitations as the App sees them.
  try {
    const members = await orgOctokit.request("GET /orgs/{org}/members", { org: args.org, per_page: 100 });
    console.log(`\n📋 Org members visible to the App (${members.data.length}):`);
    console.log(`   ${members.data.map((m) => m.login).join(", ") || "(none — likely missing members:read)"}`);
  } catch (e) {
    console.log(
      `\n📋 Could not list org members: HTTP ${(e as { status?: number }).status ?? "?"} ${(e as Error).message}`
    );
  }

  try {
    const invites = await orgOctokit.request("GET /orgs/{org}/invitations", { org: args.org, per_page: 100 });
    console.log(`\n✉️  Pending org invitations (${invites.data.length}):`);
    console.log(`   ${invites.data.map((iv) => iv.login ?? iv.email ?? "(unknown)").join(", ") || "(none)"}`);
  } catch (e) {
    console.log(
      `\n✉️  Could not list invitations: HTTP ${(e as { status?: number }).status ?? "?"} ${(e as Error).message}`
    );
  }
}

main().catch((e) => {
  console.error("❌ Check failed:", e);
  process.exit(1);
});
