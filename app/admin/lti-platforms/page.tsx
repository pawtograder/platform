"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toaster } from "@/components/ui/toaster";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Card, Flex, Heading, HStack, Input, Stack, Table, Text, VStack } from "@chakra-ui/react";
import { Plus, RefreshCw, Save, Trash2, X } from "lucide-react";

interface LtiPlatform {
  id: number;
  name: string;
  issuer: string;
  client_id: string;
  auth_login_url: string;
  token_url: string;
  jwks_url: string;
  enabled: boolean;
}

type EditState = Partial<LtiPlatform> & { id?: number };

const EMPTY: EditState = {
  name: "",
  issuer: "",
  client_id: "",
  auth_login_url: "",
  token_url: "",
  jwks_url: "",
  enabled: true
};

export default function LtiPlatformsPage() {
  const [platforms, setPlatforms] = useState<LtiPlatform[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [toolBaseUrl, setToolBaseUrl] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") setToolBaseUrl(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    const supabase = createClient();
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("lti_platforms")
        .select("id, name, issuer, client_id, auth_login_url, token_url, jwks_url, enabled")
        .order("name");
      if (error) throw error;
      setPlatforms((data as LtiPlatform[]) ?? []);
    } catch (error) {
      toaster.create({
        title: "Error loading LTI platforms",
        description: error instanceof Error ? error.message : "Failed to load data",
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (!edit) return;
    const supabase = createClient();
    setSaving(true);
    try {
      const { error } = await supabase.rpc("admin_upsert_lti_platform", {
        p_id: edit.id ?? null,
        p_name: edit.name ?? "",
        p_issuer: edit.issuer ?? "",
        p_client_id: edit.client_id ?? "",
        p_auth_login_url: edit.auth_login_url ?? "",
        p_token_url: edit.token_url ?? "",
        p_jwks_url: edit.jwks_url ?? "",
        p_enabled: edit.enabled ?? true
      });
      if (error) throw error;
      toaster.create({ title: edit.id ? "Platform updated" : "Platform created", type: "success" });
      setEdit(null);
      load();
    } catch (error) {
      toaster.create({
        title: "Save failed",
        description: error instanceof Error ? error.message : "Failed to save platform",
        type: "error"
      });
    } finally {
      setSaving(false);
    }
  }, [edit, load]);

  const remove = useCallback(
    async (id: number) => {
      if (!confirm("Delete this LTI platform? This also removes its deployments and context links.")) return;
      const supabase = createClient();
      try {
        const { error } = await supabase.rpc("admin_delete_lti_platform", { p_id: id });
        if (error) throw error;
        toaster.create({ title: "Platform deleted", type: "success" });
        load();
      } catch (error) {
        toaster.create({
          title: "Delete failed",
          description: error instanceof Error ? error.message : "Failed to delete platform",
          type: "error"
        });
      }
    },
    [load]
  );

  const field = (label: string, key: keyof EditState, placeholder?: string) => (
    <Box w="full">
      <Text fontSize="sm" fontWeight="medium" mb={1}>
        {label}
      </Text>
      <Input
        size="sm"
        value={(edit?.[key] as string) ?? ""}
        placeholder={placeholder}
        onChange={(e) => setEdit((prev) => ({ ...(prev ?? {}), [key]: e.target.value }))}
      />
    </Box>
  );

  return (
    <VStack align="stretch" gap={6}>
      <Flex justify="space-between" align="center">
        <VStack align="start" gap={1}>
          <Heading size="2xl">LTI 1.3 Platforms</Heading>
          <Text color="fg.muted">Register the LMS platforms Pawtograder integrates with via LTI 1.3</Text>
        </VStack>
        <HStack gap={3}>
          <Button variant="outline" onClick={load} loading={isLoading}>
            <HStack gap={2}>
              <RefreshCw size={16} />
              <Text>Refresh</Text>
            </HStack>
          </Button>
          <Button onClick={() => setEdit({ ...EMPTY })} colorScheme="blue">
            <HStack gap={2}>
              <Plus size={16} />
              <Text>Register Platform</Text>
            </HStack>
          </Button>
        </HStack>
      </Flex>

      {/* Tool registration details to give the LMS admin */}
      <Card.Root>
        <Card.Header>
          <Card.Title>Tool registration details</Card.Title>
          <Text color="fg.muted">Provide these URLs when registering Pawtograder as an LTI tool in your LMS.</Text>
        </Card.Header>
        <Card.Body>
          <VStack align="start" gap={2} fontSize="sm">
            <Text>
              <strong>OIDC login URL:</strong> <code>{toolBaseUrl}/api/lti/login</code>
            </Text>
            <Text>
              <strong>Redirect/launch URL:</strong> <code>{toolBaseUrl}/api/lti/launch</code>
            </Text>
            <Text>
              <strong>Public JWKS URL:</strong> <code>{toolBaseUrl}/api/lti/jwks</code>
            </Text>
            <Text>
              <strong>Deep linking URL:</strong> <code>{toolBaseUrl}/api/lti/launch</code>
            </Text>
          </VStack>
        </Card.Body>
      </Card.Root>

      {edit && (
        <Card.Root borderColor="blue.emphasized" borderWidth="1px">
          <Card.Header>
            <Card.Title>{edit.id ? "Edit platform" : "Register platform"}</Card.Title>
          </Card.Header>
          <Card.Body>
            <Stack gap={3}>
              {field("Display name", "name", "Northeastern Canvas")}
              {field("Issuer (iss)", "issuer", "https://canvas.instructure.com")}
              {field("Client ID", "client_id", "10000000000123")}
              {field(
                "OIDC auth login URL",
                "auth_login_url",
                "https://canvas.instructure.com/api/lti/authorize_redirect"
              )}
              {field("Token URL", "token_url", "https://canvas.instructure.com/login/oauth2/token")}
              {field("Platform JWKS URL", "jwks_url", "https://canvas.instructure.com/api/lti/security/jwks")}
              <HStack justify="flex-end" gap={2} pt={2}>
                <Button variant="ghost" onClick={() => setEdit(null)}>
                  <HStack gap={1}>
                    <X size={14} />
                    <Text>Cancel</Text>
                  </HStack>
                </Button>
                <Button colorScheme="blue" onClick={save} loading={saving}>
                  <HStack gap={1}>
                    <Save size={14} />
                    <Text>Save</Text>
                  </HStack>
                </Button>
              </HStack>
            </Stack>
          </Card.Body>
        </Card.Root>
      )}

      <Card.Root>
        <Card.Header>
          <Card.Title>Registered platforms</Card.Title>
        </Card.Header>
        <Card.Body>
          {isLoading ? (
            <Box textAlign="center" py={8}>
              <Text>Loading…</Text>
            </Box>
          ) : platforms.length === 0 ? (
            <Box textAlign="center" py={8}>
              <Text color="fg.subtle">No platforms registered yet.</Text>
            </Box>
          ) : (
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Name</Table.ColumnHeader>
                  <Table.ColumnHeader>Issuer</Table.ColumnHeader>
                  <Table.ColumnHeader>Client ID</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader>Actions</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {platforms.map((p) => (
                  <Table.Row key={p.id}>
                    <Table.Cell>
                      <Text fontWeight="medium">{p.name}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontSize="sm" color="fg.muted" maxW="280px" truncate>
                        {p.issuer}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontSize="sm" fontFamily="mono">
                        {p.client_id}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge colorPalette={p.enabled ? "green" : "orange"} variant={p.enabled ? "solid" : "outline"}>
                        {p.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <HStack gap={2}>
                        <Button size="sm" variant="outline" onClick={() => setEdit({ ...p })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" colorPalette="red" onClick={() => remove(p.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
