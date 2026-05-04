"use client";

import { DialogBody, DialogContent, DialogHeader, DialogRoot, DialogTitle } from "@/components/ui/dialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import * as React from "react";

const MOD = typeof navigator !== "undefined" && /Mac|iPad|iPhone/i.test(navigator.platform) ? "⌘" : "Ctrl";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <Box
      as="kbd"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      px="1.5"
      py="0.5"
      mx="0.5"
      minW="6"
      borderWidth="1px"
      borderColor="border.emphasized"
      borderBottomWidth="2px"
      borderRadius="md"
      bg="bg.muted"
      fontSize="xs"
      fontFamily="mono"
      lineHeight="1"
    >
      {children}
    </Box>
  );
}

function Row({ keys, label }: { keys: React.ReactNode; label: string }) {
  return (
    <Box
      as="li"
      display="flex"
      justifyContent="space-between"
      alignItems="center"
      py="1.5"
      borderBottomWidth="1px"
      borderColor="border.subtle"
    >
      <Text as="span" fontSize="sm">
        {label}
      </Text>
      <Box as="span" display="inline-flex" alignItems="center">
        {keys}
      </Box>
    </Box>
  );
}

export default function ShortcutsHelpDialog() {
  const { helpOpen, closeHelp, goShortcuts, landmarkShortcuts } = useKeyboardShortcuts();

  return (
    <DialogRoot open={helpOpen} onOpenChange={({ open }) => (open ? null : closeHelp())} size="md">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Stack gap="5">
            <Box>
              <Heading size="sm" mb="2">
                Go to
              </Heading>
              <Box as="ul" listStyleType="none" m="0" p="0">
                {goShortcuts.map((g) => (
                  <Row
                    key={g.key}
                    label={g.label}
                    keys={
                      <>
                        <Kbd>g</Kbd>
                        then
                        <Kbd>{g.key}</Kbd>
                      </>
                    }
                  />
                ))}
              </Box>
            </Box>

            <Box>
              <Heading size="sm" mb="2">
                Jump within page
              </Heading>
              <Box as="ul" listStyleType="none" m="0" p="0">
                {landmarkShortcuts.map((l) => (
                  <Row
                    key={l.key}
                    label={l.label}
                    keys={
                      <>
                        <Kbd>Alt</Kbd>+<Kbd>{l.key.toUpperCase()}</Kbd>
                      </>
                    }
                  />
                ))}
                <Row label="Focus search (when present)" keys={<Kbd>s</Kbd>} />
                <Row label="Focus search (alternate)" keys={<Kbd>/</Kbd>} />
              </Box>
            </Box>

            <Box>
              <Heading size="sm" mb="2">
                Comments &amp; markdown editor
              </Heading>
              <Box as="ul" listStyleType="none" m="0" p="0">
                <Row
                  label="Bold"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>B</Kbd>
                    </>
                  }
                />
                <Row
                  label="Italic"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>I</Kbd>
                    </>
                  }
                />
                <Row
                  label="Inline code"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>E</Kbd>
                    </>
                  }
                />
                <Row
                  label="Link"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>K</Kbd>
                    </>
                  }
                />
                <Row
                  label="Ordered list"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>Shift</Kbd>+<Kbd>7</Kbd>
                    </>
                  }
                />
                <Row
                  label="Unordered list"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>Shift</Kbd>+<Kbd>8</Kbd>
                    </>
                  }
                />
                <Row
                  label="Quote"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>Shift</Kbd>+<Kbd>.</Kbd>
                    </>
                  }
                />
                <Row
                  label="Toggle preview"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>Shift</Kbd>+<Kbd>P</Kbd>
                    </>
                  }
                />
                <Row
                  label="Submit form"
                  keys={
                    <>
                      <Kbd>{MOD}</Kbd>+<Kbd>Enter</Kbd>
                    </>
                  }
                />
              </Box>
            </Box>

            <Box>
              <Heading size="sm" mb="2">
                Help
              </Heading>
              <Box as="ul" listStyleType="none" m="0" p="0">
                <Row label="Open this dialog" keys={<Kbd>?</Kbd>} />
                <Row label="Close dialog / cancel" keys={<Kbd>Esc</Kbd>} />
              </Box>
            </Box>

            <Text fontSize="xs" color="fg.muted">
              Shortcuts are suppressed while typing in form fields.
            </Text>
          </Stack>
        </DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}
