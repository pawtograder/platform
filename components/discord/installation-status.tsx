"use client";

import { Alert } from "@/components/ui/alert";
import { TimeZoneAwareDate } from "@/components/TimeZoneAwareDate";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { PopConfirm } from "@/components/ui/popconfirm";
import { checkDiscordBotInstallation, type CheckBotInstallationResponse } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { REQUIRED_BOT_PERMISSIONS } from "@/supabase/functions/_shared/DiscordPermissions";
import { Box, Button, Code, Heading, HStack, Icon, List, Spinner, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BsArrowRepeat, BsDiscord } from "react-icons/bs";

/**
 * Whether the Pawtograder bot is in this class's Discord server, and whether it can work there.
 *
 * Replaces the free-text "Discord Server ID" box. That box was both a security hole (one bot token
 * serves every course, so typing another course's guild id pointed this class at their server) and
 * the worst possible diagnostic surface: an instructor whose roles never synced had no way to tell a
 * wrong id from a missing permission from the role-hierarchy trap below.
 *
 * The states are deliberately distinct remediations rather than degrees of the same warning:
 *
 *   - not installed        -> add the bot (this is also the initial state for every class)
 *   - missing permissions  -> re-authorize, and here is exactly which ones
 *   - no invite channel    -> allow Create Invite in a text channel; nobody can be enrolled until then
 *   - channel overwrite    -> edit that one channel's permissions; the server-level ones are fine
 *   - role hierarchy       -> drag the bot's role above the class roles; permissions are fine
 *   - stale tracked role   -> re-sync; the fix is on Pawtograder's side, not in Discord
 *   - healthy              -> who connected it, and when
 *
 * The two channel states are separate from "missing permissions" because re-authorizing the bot does
 * nothing for either: Discord resolves per-channel and per-category overwrites on top of the
 * server-level bits, and the button that widens the server-level bits cannot touch them. The fix is in
 * one channel's own permission settings, so the panel has to say which channel.
 *
 * The third is the point of the panel. Discord reports "cannot assign a role positioned above me"
 * with 50013 Missing Permissions -- the same code as not holding Manage Roles at all -- so from the
 * error alone the diagnosis is impossible and the obvious fix (grant more permissions) does nothing.
 * The two role positions below are the evidence, and they are shown because without them the advice
 * is unverifiable.
 */

type Provenance = {
  claimedAt: string | null;
  claimedBy: string | null;
};

/** The `classes` columns and embedded claimer this panel reads. */
type ProvenanceRow = {
  discord_server_claimed_at: string | null;
  users: { name: string | null; email: string | null } | null;
};

export default function DiscordInstallationStatus({
  classId,
  /** Graders see the diagnosis but get no install or re-authorize controls. */
  canManage
}: {
  classId: number;
  canManage: boolean;
}) {
  const [status, setStatus] = useState<CheckBotInstallationResponse | null>(null);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const announce = useAnnouncer();
  // So the first render does not announce; a page load already reads the panel.
  const announcedOnce = useRef(false);

  const recheck = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    setLoading(true);

    const load = async () => {
      const installation = await checkDiscordBotInstallation({ class_id: classId }, supabase);
      // Provenance is a separate read because the edge function reports the state of the *Discord*
      // side; who pressed the button is Pawtograder's own record. Fetched second and allowed to fail:
      // a class whose claimer has since been deleted, or a grader who cannot read the users row, still
      // needs the diagnosis above it.
      //
      // Cast because discord_server_claimed_at / _by land with migration
      // 20260822130000_discord_guild_claim.sql and SupabaseTypes.d.ts is regenerated centrally once
      // all of this branch's migrations are in.
      let claimed: Provenance = { claimedAt: null, claimedBy: null };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const untyped = supabase as any;
        const { data } = (await untyped
          .from("classes")
          .select("discord_server_claimed_at, users!discord_server_claimed_by(name, email)")
          .eq("id", classId)
          .maybeSingle()) as { data: ProvenanceRow | null };
        claimed = {
          claimedAt: data?.discord_server_claimed_at ?? null,
          claimedBy: data?.users?.name ?? data?.users?.email ?? null
        };
      } catch {
        // Leave provenance blank; the healthy panel simply omits the "connected by" line.
      }
      return { installation, claimed };
    };

    load()
      .then(({ installation, claimed }) => {
        if (cancelled) return;
        setStatus(installation);
        setProvenance(claimed);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus(null);
        setError(e instanceof Error ? e.message : "Could not check the Discord bot installation.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [classId, reloadToken]);

  // A short spoken summary when the state changes, so a re-check is not a silent no-op for a screen
  // reader. The panel itself is not a live region: it is several paragraphs of remediation, and
  // announcing all of it on every poll would be unusable.
  useEffect(() => {
    if (loading) return;
    if (!announcedOnce.current) {
      announcedOnce.current = true;
      return;
    }
    announce(summarize({ status, error }));
  }, [loading, status, error, announce]);

  const recheckButton = (
    <Button variant="outline" size="sm" onClick={recheck} loading={loading} disabled={loading}>
      <Icon as={BsArrowRepeat} />
      Re-check
    </Button>
  );

  return (
    <Box
      as="section"
      role="region"
      aria-labelledby="discord-installation-heading"
      aria-busy={loading}
      borderWidth="1px"
      borderRadius="md"
      p={4}
    >
      <VStack align="stretch" gap={4}>
        <HStack justify="space-between" gap={2}>
          <HStack gap={2}>
            <Icon as={BsDiscord} />
            <Heading size="md" id="discord-installation-heading">
              Discord Server
            </Heading>
          </HStack>
          {recheckButton}
        </HStack>

        {loading && !status && (
          <HStack gap={2}>
            <Spinner size="sm" />
            <Text fontSize="sm" color="fg.muted">
              Checking the Discord bot installation…
            </Text>
          </HStack>
        )}

        {error && (
          <Alert status="error" title="Could not check the Discord bot installation">
            <Text>{error}</Text>
            <Text fontSize="sm" mt={2} color="fg.muted">
              This says nothing about whether the bot is installed — only that Pawtograder could not ask. Try again in a
              moment.
            </Text>
          </Alert>
        )}

        {status && <StatusBody status={status} provenance={provenance} classId={classId} canManage={canManage} />}
      </VStack>
    </Box>
  );
}

/** One sentence, for the live announcer. Mirrors the alert titles below. */
function summarize({ status, error }: { status: CheckBotInstallationResponse | null; error: string | null }): string {
  if (error) return "Could not check the Discord bot installation.";
  if (!status) return "";
  if (!status.installed) return "The Pawtograder bot is not installed in a Discord server for this course.";
  if (status.missing_permissions.length > 0) {
    return `The Pawtograder bot is installed but missing ${status.missing_permissions.length} permission${
      status.missing_permissions.length === 1 ? "" : "s"
    }: ${status.missing_permissions.join(", ")}.`;
  }
  if (!status.can_create_invites) {
    return "No Discord channel allows the Pawtograder bot to create invites, so no student can be invited to the server.";
  }
  if (status.channel_permission_problems.length > 0) {
    const n = status.channel_permission_problems.length;
    return `The Pawtograder bot is blocked by channel permissions in ${n} Discord channel${n === 1 ? "" : "s"}.`;
  }
  if (!status.can_manage_class_roles) {
    return "The Pawtograder bot's role sits too low in the Discord server to assign the course's roles.";
  }
  if (status.stale_class_role_ids.length > 0) {
    const n = status.stale_class_role_ids.length;
    return `The Pawtograder bot is installed, but ${n} tracked role${n === 1 ? "" : "s"} no longer exist${
      n === 1 ? "s" : ""
    } in the Discord server.`;
  }
  return `The Pawtograder bot is installed in ${status.guild_name ?? "the connected server"} with every permission it needs, in the server and in its channels.`;
}

function StatusBody({
  status,
  provenance,
  classId,
  canManage
}: {
  status: CheckBotInstallationResponse;
  provenance: Provenance | null;
  classId: number;
  canManage: boolean;
}) {
  if (!status.installed) {
    return <NotInstalled status={status} classId={classId} canManage={canManage} />;
  }
  if (status.missing_permissions.length > 0) {
    return <MissingPermissions status={status} canManage={canManage} />;
  }
  // Ranked above the channel-overwrite panel, and above the hierarchy one: with no channel that
  // permits Create Invite, no student reaches the server at all, so nothing further can matter to
  // them. It is checked after `missing_permissions` because a server-level Create Invite denial is
  // already named there, with the re-authorize button that fixes it.
  if (!status.can_create_invites) {
    return <NoInviteChannel status={status} />;
  }
  if (status.channel_permission_problems.length > 0) {
    return <ChannelPermissionProblems status={status} />;
  }
  if (!status.can_manage_class_roles) {
    return <RoleHierarchyProblem status={status} />;
  }
  // Checked before Healthy: permissions and hierarchy are fine, so every other signal says the
  // install works, and it does -- for every role except the deleted one. Reporting this as healthy is
  // what let a class sit with a role that silently 404s on every assignment.
  if (status.stale_class_role_ids.length > 0) {
    return <StaleClassRoles status={status} provenance={provenance} classId={classId} canManage={canManage} />;
  }
  return <Healthy status={status} provenance={provenance} classId={classId} canManage={canManage} />;
}

function NotInstalled({
  status,
  classId,
  canManage
}: {
  status: CheckBotInstallationResponse;
  classId: number;
  canManage: boolean;
}) {
  return (
    <VStack align="stretch" gap={3}>
      {/* `title` states the status in words; the Alert's colour and icon are reinforcement, never the
          only carrier of it. */}
      <Alert status="warning" title="Not connected to a Discord server">
        <Text>
          {status.guild_id
            ? "This course names a Discord server, but the Pawtograder bot is not in it — either it was removed, or the server no longer exists. Nothing will sync until the bot is added again."
            : "Add the Pawtograder bot to your course's Discord server to create channels, sync roles and invite students."}
        </Text>
        {status.guild_id && (
          <Text fontSize="sm" mt={2} color="fg.muted">
            Configured server: <Code>{status.guild_id}</Code>
          </Text>
        )}
      </Alert>

      <Box>
        <Text fontSize="sm" fontWeight="semibold" mb={1}>
          Pawtograder asks for these permissions, and no others:
        </Text>
        <List.Root fontSize="sm" pl={4}>
          {REQUIRED_BOT_PERMISSIONS.map((permission) => (
            <List.Item key={permission.flag}>
              <Text as="span" fontWeight="medium">
                {permission.label}
              </Text>{" "}
              — {permission.reason}
            </List.Item>
          ))}
        </List.Root>
        <Text fontSize="sm" color="fg.muted" mt={2}>
          Administrator is deliberately not requested. You will pick the server on Discord&apos;s own screen, which only
          lists servers you can add a bot to — that is what proves this course may use it.
        </Text>
      </Box>

      {canManage ? (
        <HStack>
          <Button asChild colorPalette="blue">
            <a href={`/api/discord/install?class_id=${classId}`}>
              <Icon as={BsDiscord} />
              Add Pawtograder to your Discord server
            </a>
          </Button>
        </HStack>
      ) : (
        <Text fontSize="sm" color="fg.muted" fontStyle="italic">
          Only instructors can connect a Discord server.
        </Text>
      )}
    </VStack>
  );
}

function MissingPermissions({ status, canManage }: { status: CheckBotInstallationResponse; canManage: boolean }) {
  const count = status.missing_permissions.length;
  return (
    <VStack align="stretch" gap={3}>
      <Alert status="error" title={`Connected, but missing ${count} required permission${count === 1 ? "" : "s"}`}>
        <Text>
          The bot is in{" "}
          <Text as="span" fontWeight="semibold">
            {status.guild_name ?? "the connected server"}
          </Text>{" "}
          but Discord will refuse the operations below until these are granted. Each one fails as a bare 403 with no
          explanation, so nothing else will tell you this.
        </Text>
        <List.Root fontSize="sm" pl={4} mt={2}>
          {status.missing_permissions.map((label) => (
            <List.Item key={label}>{label}</List.Item>
          ))}
        </List.Root>
      </Alert>
      {canManage && (
        <VStack align="stretch" gap={1}>
          <HStack>
            <Button asChild colorPalette="blue" size="sm">
              <a href={status.install_url} target="_blank" rel="noopener noreferrer">
                <Icon as={BsDiscord} />
                Re-authorize the bot with the required permissions
              </a>
            </Button>
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            Opens Discord in a new tab, pinned to this course&apos;s server. Come back and press Re-check when you are
            done.
          </Text>
        </VStack>
      )}
    </VStack>
  );
}

/**
 * No text channel in the server permits Create Invite, so enrollment cannot happen.
 *
 * The most severe of the channel-level states and ranked first among them: an invite is how a student
 * reaches the server at all, so until one channel allows it nothing else about the install matters to
 * anybody but the instructor. Reached only when the server-level permissions are complete, which is
 * what makes it a channel problem: the "re-authorize" button widens server-level permissions and can
 * do nothing about a channel that overrides them, so this panel deliberately does not offer it.
 */
function NoInviteChannel({ status }: { status: CheckBotInstallationResponse }) {
  return (
    <VStack align="stretch" gap={3}>
      {/* `title` carries the state in words; the Alert's colour and icon only reinforce it. */}
      <Alert status="error" title="No channel allows invites, so no student can be added">
        <Text>
          Pawtograder holds Create Invite across{" "}
          <Text as="span" fontWeight="semibold">
            {status.guild_name ?? "the connected server"}
          </Text>
          , but every text channel it can see overrides that and denies it — or the server has no text channel at all.
          Invites are made in a channel, so student enrollment will keep failing until one channel permits it.
        </Text>
        <Text mt={2}>
          To fix it, open{" "}
          <Text as="span" fontWeight="semibold">
            Edit Channel → Permissions
          </Text>{" "}
          on a text channel students can see, add the{" "}
          <Text as="span" fontWeight="semibold">
            Pawtograder
          </Text>{" "}
          role, and allow{" "}
          <Text as="span" fontWeight="semibold">
            Create Invite
          </Text>
          . Check the channel&apos;s category too — a channel inherits its category&apos;s overrides. Then press
          Re-check.
        </Text>
        <Text fontSize="sm" mt={2} color="fg.muted">
          Re-authorizing the bot will not clear this. Channel overrides sit above the server-level permissions the
          authorization screen grants.
        </Text>
      </Alert>
    </VStack>
  );
}

/**
 * A channel override blocks the bot in one or more of the channels Pawtograder posts to.
 *
 * Named per channel and per permission on purpose. The symptom an instructor sees is that
 * notifications stopped appearing in one place, and the server-level panel above would have said
 * everything was fine, so the only useful thing this can do is point at the exact channel and the
 * exact switch inside it.
 */
function ChannelPermissionProblems({ status }: { status: CheckBotInstallationResponse }) {
  const problems = status.channel_permission_problems;
  const count = problems.length;
  return (
    <VStack align="stretch" gap={3}>
      <Alert
        status="error"
        title={count === 1 ? "One channel's permissions block the bot" : `${count} channels' permissions block the bot`}
      >
        <Text>
          Every server-level permission is granted in{" "}
          <Text as="span" fontWeight="semibold">
            {status.guild_name ?? "the connected server"}
          </Text>
          , and its role is high enough to assign this course&apos;s roles. Discord applies per-channel and per-category
          overrides on top of that, and {count === 1 ? "this channel takes" : "these channels take"} back what the
          server grants, so Pawtograder&apos;s messages there fail with a bare 403.
        </Text>
        <List.Root fontSize="sm" pl={4} mt={2}>
          {problems.map((problem) => (
            <List.Item key={problem.channel_id}>
              <Text as="span" fontWeight="medium">
                {problem.channel_name ? `#${problem.channel_name}` : "Channel"}
              </Text>{" "}
              {/* No wrapping parentheses: <Code> carries its own horizontal padding, so "(id)" renders
                  with a visible gap inside each bracket and reads as a spacing bug. The chip already
                  separates the id from the name on its own. */}
              <Code>{problem.channel_id}</Code> — denied {problem.missing.join(", ")}
            </List.Item>
          ))}
        </List.Root>
        <Text mt={2}>
          To fix it, open{" "}
          <Text as="span" fontWeight="semibold">
            Edit Channel → Permissions
          </Text>{" "}
          on {count === 1 ? "that channel" : "each channel"}, find the{" "}
          <Text as="span" fontWeight="semibold">
            Pawtograder
          </Text>{" "}
          role, and allow the permission{count === 1 && problems[0].missing.length === 1 ? "" : "s"} listed above. A
          channel with no override of its own inherits its category&apos;s, so check the category as well. Then press
          Re-check.
        </Text>
        <Text fontSize="sm" mt={2} color="fg.muted">
          Re-authorizing the bot will not clear this. Channel overrides sit above the server-level permissions the
          authorization screen grants.
        </Text>
      </Alert>
    </VStack>
  );
}

function RoleHierarchyProblem({ status }: { status: CheckBotInstallationResponse }) {
  return (
    <VStack align="stretch" gap={3}>
      <Alert status="error" title="The bot's role sits too low to assign this course's roles">
        <Text>
          Permissions are correct — the bot holds every one it needs. Discord additionally refuses to assign a role
          positioned at or above the acting member&apos;s own highest role, and reports that refusal with the same error
          code as a missing permission, so no amount of granting permissions will fix it.
        </Text>
        <Box mt={2} fontSize="sm">
          <Text>
            Pawtograder&apos;s role position:{" "}
            <Text as="span" fontWeight="semibold">
              {status.bot_role_position ?? "unknown"}
            </Text>
          </Text>
          <Text>
            Highest course role position:{" "}
            <Text as="span" fontWeight="semibold">
              {status.highest_class_role_position ?? "unknown"}
            </Text>
          </Text>
        </Box>
        <Text mt={2}>
          To fix it, in {status.guild_name ?? "the server"} open{" "}
          <Text as="span" fontWeight="semibold">
            Server Settings → Roles
          </Text>{" "}
          and drag the{" "}
          <Text as="span" fontWeight="semibold">
            Pawtograder
          </Text>{" "}
          role above the course roles it creates (Student, Grader, Instructor), then press Re-check. The number above it
          needs to be higher than {status.highest_class_role_position ?? "the highest course role"}.
        </Text>
      </Alert>
    </VStack>
  );
}

/**
 * Release the class's hold on its Discord server.
 *
 * Submits a real form POST rather than fetch(), so the route's redirect is followed by the browser
 * and the settings page reloads with the outcome in its query string -- the same path the install
 * callback takes. The confirmation matters: disconnecting drops every role, channel and tracked
 * message Pawtograder created in that server.
 */
function DisconnectButton({ classId, guildName }: { classId: number; guildName: string | null }) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={formRef} method="post" action="/api/discord/disconnect" hidden>
        <input type="hidden" name="class_id" value={classId} />
      </form>
      <PopConfirm
        triggerLabel="Disconnect Discord"
        trigger={
          <Button variant="ghost" size="sm" colorPalette="red">
            Disconnect Discord
          </Button>
        }
        confirmHeader="Disconnect Discord"
        // Deliberately does not claim the Discord roles and channels are deleted. Disconnecting drops
        // Pawtograder's *tracking* of them; the roles and channels themselves stay in the server, and
        // so does everyone's membership. That matches what moving a course to a different server
        // already does, and saying otherwise would have been the one sentence here that was false.
        confirmText={`Pawtograder will stop managing ${
          guildName ?? "the connected server"
        } and will forget the roles and channels it created there. Those roles and channels are left in the server for you to delete, and nobody is removed from it. You can reconnect later.`}
        onConfirm={async () => {
          formRef.current?.submit();
        }}
      />
    </>
  );
}

/**
 * Installed and permitted, but Pawtograder is tracking a role Discord no longer has.
 *
 * Rendered as a warning over the healthy panel rather than instead of it: everything the healthy
 * panel says is still true, and the remaining roles keep working. What is broken is one snowflake,
 * and the fix is on the Pawtograder side (re-sync so the dead row is replaced), not in Discord.
 */
function StaleClassRoles({
  status,
  provenance,
  classId,
  canManage
}: {
  status: CheckBotInstallationResponse;
  provenance: Provenance | null;
  classId: number;
  canManage: boolean;
}) {
  const count = status.stale_class_role_ids.length;
  return (
    <VStack align="stretch" gap={3}>
      <Alert
        status="warning"
        title={
          count === 1
            ? "One tracked role no longer exists in Discord"
            : `${count} tracked roles no longer exist in Discord`
        }
      >
        <VStack align="stretch" gap={2}>
          <Text>
            Pawtograder still has {count === 1 ? "a role" : "roles"} recorded for this course that{" "}
            {count === 1 ? "has" : "have"} been deleted in{" "}
            <Text as="span" fontWeight="semibold">
              {status.guild_name ?? "the connected server"}
            </Text>
            . Assigning {count === 1 ? "it" : "them"} will keep failing, and the stale record stops a replacement from
            being created.
          </Text>
          <Text fontSize="sm" color="fg.muted">
            Deleted role {count === 1 ? "ID" : "IDs"}: <Code>{status.stale_class_role_ids.join(", ")}</Code>
          </Text>
          {canManage && (
            <Text fontSize="sm">Use “Sync Roles” below to recreate the missing {count === 1 ? "role" : "roles"}.</Text>
          )}
        </VStack>
      </Alert>
      <Healthy status={status} provenance={provenance} classId={classId} canManage={canManage} />
    </VStack>
  );
}

function Healthy({
  status,
  provenance,
  classId,
  canManage
}: {
  status: CheckBotInstallationResponse;
  provenance: Provenance | null;
  classId: number;
  canManage: boolean;
}) {
  return (
    <VStack align="stretch" gap={3}>
      <Alert status="success" title="Connected and working">
        <Text>
          Pawtograder is in{" "}
          <Text as="span" fontWeight="semibold">
            {status.guild_name ?? "the connected server"}
          </Text>{" "}
          with every permission it needs, its role is high enough to assign this course&apos;s roles, and no channel
          override blocks it from posting or from inviting students.
        </Text>
      </Alert>
      <VStack align="stretch" gap={0} fontSize="sm" color="fg.muted">
        <Text>
          Server ID: <Code>{status.guild_id}</Code>
        </Text>
        {provenance?.claimedAt ? (
          <Text>
            Connected {provenance.claimedBy ? `by ${provenance.claimedBy} ` : ""}on{" "}
            <TimeZoneAwareDate date={provenance.claimedAt} format="full" />
          </Text>
        ) : (
          <Text>
            Connected before Pawtograder recorded who did it. Re-running the install records it, without disturbing the
            server.
          </Text>
        )}
      </VStack>
      {canManage && (
        <VStack align="stretch" gap={2}>
          <HStack gap={2} flexWrap="wrap">
            {/* Pinned to this server by the edge function (`disable_guild_select`), so it can only
                widen permissions here — it cannot move the course by mistake. */}
            <Button asChild variant="outline" size="sm">
              <a href={status.install_url} target="_blank" rel="noopener noreferrer">
                <Icon as={BsDiscord} />
                Re-authorize permissions in this server
              </a>
            </Button>
            {/* The install route, not install_url: moving needs the server picker and needs the
                callback to confirm the bot really is in the new guild before recording it. */}
            <Button asChild variant="ghost" size="sm">
              <a href={`/api/discord/install?class_id=${classId}`}>Connect a different Discord server</a>
            </Button>
            <DisconnectButton classId={classId} guildName={status.guild_name} />
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            Moving this course to a different Discord server deletes the roles, channels and tracked messages
            Pawtograder created in this one, and creates them again in the new server.
          </Text>
        </VStack>
      )}
    </VStack>
  );
}
