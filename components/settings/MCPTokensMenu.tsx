"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toaster, Toaster } from "@/components/ui/toaster";
import { useIsGraderOrInstructor } from "@/hooks/useClassProfiles";
import { mcpTokensList, mcpTokensCreate, mcpTokensRevoke, MCPToken, MCPScope } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Dialog, Flex, HStack, IconButton, Portal, Spinner, Table, Text, VStack } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import { LuCopy, LuCheck, LuKey, LuTrash2, LuPlus } from "react-icons/lu";

type TokenType = "mcp" | "cli" | "both";

const TOKEN_TYPE_SCOPES: Record<TokenType, MCPScope[]> = {
  mcp: ["mcp:read", "mcp:write"],
  cli: ["cli:read", "cli:write"],
  both: ["mcp:read", "mcp:write", "cli:read", "cli:write"]
};

const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
  mcp: "MCP (AI Assistants)",
  cli: "CLI (Command Line)",
  both: "MCP + CLI"
};

function getScopeLabel(scopes: string[]): string {
  const hasMcp = scopes.some((s) => s.startsWith("mcp:"));
  const hasCli = scopes.some((s) => s.startsWith("cli:"));
  if (hasMcp && hasCli) return "MCP + CLI";
  if (hasCli) return "CLI";
  return "MCP";
}

/**
 * Dialog component for managing API tokens (MCP and CLI).
 * Only available to instructors and graders.
 */
export default function MCPTokensMenu() {
  const isInstructorOrGrader = useIsGraderOrInstructor();
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<MCPToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenType, setNewTokenType] = useState<TokenType>("mcp");
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = createClient();
      const { tokens: fetchedTokens } = await mcpTokensList(supabase);
      setTokens(fetchedTokens || []);
    } catch (error) {
      toaster.error({
        title: "Error fetching tokens",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchTokens();
    }
  }, [open, fetchTokens]);

  const createToken = async () => {
    if (!newTokenName.trim()) {
      toaster.error({
        title: "Token name required",
        description: "Please enter a name for your token"
      });
      return;
    }

    setCreating(true);
    try {
      const supabase = createClient();
      const data = await mcpTokensCreate(
        {
          name: newTokenName.trim(),
          scopes: TOKEN_TYPE_SCOPES[newTokenType],
          expires_in_days: 90
        },
        supabase
      );

      setNewlyCreatedToken(data.token);
      setNewTokenName("");
      await fetchTokens();

      toaster.success({
        title: "Token created",
        description: "Copy your token now - it won't be shown again!"
      });
    } catch (error) {
      toaster.error({
        title: "Error creating token",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (tokenId: string) => {
    try {
      const supabase = createClient();
      await mcpTokensRevoke({ token_id: tokenId }, supabase);

      await fetchTokens();
      toaster.success({
        title: "Token revoked",
        description: "The token has been revoked and can no longer be used"
      });
    } catch (error) {
      toaster.error({
        title: "Error revoking token",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopiedTokenId(token);
      setTimeout(() => setCopiedTokenId(null), 2000);
      toaster.success({
        title: "Token copied",
        description: "Token copied to clipboard"
      });
    } catch (error) {
      toaster.error({
        title: "Failed to copy",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  };

  const isExpired = (expiresAt: string) => {
    return new Date(expiresAt) < new Date();
  };

  // Don't render if not authorized (not an instructor/grader)
  if (!isInstructorOrGrader) {
    return null;
  }

  return (
    <>
      <Toaster />
      <Dialog.Root size="lg" placement="center" open={open} onOpenChange={(e) => setOpen(e.open)}>
        <Dialog.Trigger asChild>
          <Button
            variant="ghost"
            colorPalette="gray"
            width="100%"
            justifyContent="flex-start"
            textAlign="left"
            size="sm"
            py={0}
          >
            <LuKey />
            API Tokens
          </Button>
        </Dialog.Trigger>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxHeight="80vh" overflowY="auto">
              <Dialog.Header>
                <Dialog.Title>API Tokens</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack gap={6} alignItems="stretch">
                  {/* Create new token */}
                  <Box p={4} borderWidth={1} borderRadius="md" bg="bg.subtle">
                    <Text fontWeight="bold" mb={3}>
                      Create New Token
                    </Text>
                    <VStack gap={3} alignItems="stretch">
                      <Box>
                        <Label htmlFor="token-name">Token Name</Label>
                        <Input
                          id="token-name"
                          value={newTokenName}
                          onChange={(e) => setNewTokenName(e.target.value)}
                          placeholder="e.g., Claude Desktop, VS Code, My CLI"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createToken();
                          }}
                        />
                      </Box>
                      <Box>
                        <Label htmlFor="token-type">Token Type</Label>
                        <HStack gap={2} mt={1}>
                          {(Object.keys(TOKEN_TYPE_LABELS) as TokenType[]).map((type) => (
                            <Button
                              key={type}
                              size="sm"
                              variant={newTokenType === type ? "solid" : "outline"}
                              colorPalette={newTokenType === type ? "blue" : "gray"}
                              onClick={() => setNewTokenType(type)}
                            >
                              {TOKEN_TYPE_LABELS[type]}
                            </Button>
                          ))}
                        </HStack>
                      </Box>
                      <Button
                        colorPalette="green"
                        onClick={createToken}
                        disabled={creating || !newTokenName.trim()}
                      >
                        {creating ? <Spinner size="sm" /> : <LuPlus />}
                        Create Token
                      </Button>
                    </VStack>
                    <Text fontSize="sm" color="fg.muted" mt={2}>
                      Tokens are valid for 90 days. MCP tokens grant access to AI assistant tools. CLI tokens grant
                      access to the command-line interface API.
                    </Text>
                  </Box>

                  {/* Newly created token display */}
                  {newlyCreatedToken && (
                    <Box p={4} borderWidth={2} borderColor="green.500" borderRadius="md" bg="green.subtle">
                      <Text fontWeight="bold" color="green.fg" mb={2}>
                        Token Created - Copy Now!
                      </Text>
                      <Text fontSize="sm" color="fg.muted" mb={3}>
                        This token will only be shown once. Copy it now and store it securely.
                      </Text>
                      <HStack gap={2}>
                        <Input value={newlyCreatedToken} readOnly fontFamily="mono" fontSize="sm" />
                        <IconButton
                          aria-label="Copy token"
                          onClick={() => copyToken(newlyCreatedToken)}
                          colorPalette={copiedTokenId === newlyCreatedToken ? "green" : "gray"}
                        >
                          {copiedTokenId === newlyCreatedToken ? <LuCheck /> : <LuCopy />}
                        </IconButton>
                      </HStack>
                      <Button variant="ghost" size="sm" mt={2} onClick={() => setNewlyCreatedToken(null)}>
                        Dismiss
                      </Button>
                    </Box>
                  )}

                  {/* Token list */}
                  <Box>
                    <Text fontWeight="bold" mb={3}>
                      Your Tokens
                    </Text>
                    {loading ? (
                      <Flex justify="center" p={4}>
                        <Spinner />
                      </Flex>
                    ) : tokens.length === 0 ? (
                      <Text color="fg.muted" textAlign="center" p={4}>
                        No tokens yet. Create one to get started.
                      </Text>
                    ) : (
                      <Table.Root size="sm">
                        <Table.Header>
                          <Table.Row>
                            <Table.ColumnHeader>Name</Table.ColumnHeader>
                            <Table.ColumnHeader>Type</Table.ColumnHeader>
                            <Table.ColumnHeader>Status</Table.ColumnHeader>
                            <Table.ColumnHeader>Created</Table.ColumnHeader>
                            <Table.ColumnHeader>Expires</Table.ColumnHeader>
                            <Table.ColumnHeader>Last Used</Table.ColumnHeader>
                            <Table.ColumnHeader></Table.ColumnHeader>
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {tokens.map((token) => (
                            <Table.Row key={token.id}>
                              <Table.Cell fontWeight="medium">{token.name}</Table.Cell>
                              <Table.Cell>
                                <Badge colorPalette="blue" variant="subtle">
                                  {getScopeLabel(token.scopes)}
                                </Badge>
                              </Table.Cell>
                              <Table.Cell>
                                {token.revoked_at ? (
                                  <Badge colorPalette="red">Revoked</Badge>
                                ) : isExpired(token.expires_at) ? (
                                  <Badge colorPalette="orange">Expired</Badge>
                                ) : (
                                  <Badge colorPalette="green">Active</Badge>
                                )}
                              </Table.Cell>
                              <Table.Cell>{formatDate(token.created_at)}</Table.Cell>
                              <Table.Cell>{formatDate(token.expires_at)}</Table.Cell>
                              <Table.Cell>{token.last_used_at ? formatDate(token.last_used_at) : "Never"}</Table.Cell>
                              <Table.Cell>
                                {!token.revoked_at && !isExpired(token.expires_at) && (
                                  <IconButton
                                    aria-label="Revoke token"
                                    size="sm"
                                    variant="ghost"
                                    colorPalette="red"
                                    onClick={() => revokeToken(token.token_id)}
                                  >
                                    <LuTrash2 />
                                  </IconButton>
                                )}
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Root>
                    )}
                  </Box>

                  {/* Usage instructions */}
                  <Box p={4} borderWidth={1} borderRadius="md" bg="bg.subtle">
                    <Text fontWeight="bold" mb={2}>
                      How to Use
                    </Text>
                    <Text fontSize="sm" color="fg.muted" mb={3}>
                      MCP tokens are used with AI assistants (Claude Desktop, etc). CLI tokens are used with the
                      Pawtograder CLI API.
                    </Text>
                    <Text fontSize="sm" fontWeight="semibold" mb={1}>
                      MCP Client Configuration (Claude Desktop):
                    </Text>
                    <Box
                      mt={1}
                      mb={3}
                      p={2}
                      bg="bg.emphasized"
                      borderRadius="sm"
                      fontFamily="mono"
                      fontSize="xs"
                      whiteSpace="pre-wrap"
                      overflowX="auto"
                    >
                      {`{
  "mcpServers": {
    "pawtograder": {
      "url": "${typeof window !== "undefined" ? window.location.origin : ""}/functions/v1/mcp-server",
      "headers": {
        "Authorization": "Bearer mcp_YOUR_TOKEN_HERE"
      }
    }
  }
}`}
                    </Box>
                    <Text fontSize="sm" fontWeight="semibold" mb={1}>
                      CLI API Usage:
                    </Text>
                    <Box
                      mt={1}
                      p={2}
                      bg="bg.emphasized"
                      borderRadius="sm"
                      fontFamily="mono"
                      fontSize="xs"
                      whiteSpace="pre-wrap"
                      overflowX="auto"
                    >
                      {`curl -X POST ${typeof window !== "undefined" ? window.location.origin : ""}/functions/v1/cli \\
  -H "Authorization: Bearer mcp_YOUR_TOKEN_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{"command": "classes.list", "params": {}}'`}
                    </Box>
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.ActionTrigger asChild>
                  <Button variant="outline">Close</Button>
                </Dialog.ActionTrigger>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}
