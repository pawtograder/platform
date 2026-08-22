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
 * The four states are deliberately distinct remediations rather than degrees of the same warning:
 *
 *   - not installed        -> add the bot (this is also the initial state for every class)
 *   - missing permissions  -> re-authorize, and here is exactly which ones
 *   - role hierarchy       -> drag the bot's role above the class roles; permissions are fine
 *   - healthy              -> who connected it, and when
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
  if (!status.can_manage_class_roles) {
    return "The Pawtograder bot's role sits too low in the Discord server to assign the course's roles.";
  }
  return `The Pawtograder bot is installed and healthy in ${status.guild_name ?? "the connected server"}.`;
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
  if (!status.can_manage_class_roles) {
    return <RoleHierarchyProblem status={status} />;
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
        confirmText={`This releases ${
          guildName ?? "the connected server"
        } and deletes the roles, channels and tracked messages Pawtograder created in it. Students already in the server stay in it. You can reconnect later.`}
        onConfirm={async () => {
          formRef.current?.submit();
        }}
      />
    </>
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
          with every permission it needs, and its role is high enough to assign this course&apos;s roles.
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
