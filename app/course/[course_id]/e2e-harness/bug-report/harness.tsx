"use client";

import { Avatar } from "@/components/ui/avatar";
import MdEditor from "@/components/ui/md-editor";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import Editor, { loader } from "@monaco-editor/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Grows and rewrites a large block of text on every tick, for the size-cap test (C2). */
function MutationStorm() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <Box data-testid="mutation-storm">
      {Array.from({ length: 400 }, (_, i) => (
        <Text key={i}>{`row ${i} tick ${tick} ${"lorem ipsum dolor sit amet ".repeat(40)}`}</Text>
      ))}
    </Box>
  );
}

/**
 * Rewrites random, incompressible attribute values on a fixed set of nodes, for the upload
 * size tests (F2). Attributes other than the text ones are recorded as-is, so the recording
 * compresses poorly, as a real one full of ids and class names can. The DOM stays the same
 * size, so every checkout's FullSnapshot does too.
 */
function EntropyStorm() {
  const [values, setValues] = useState<string[]>(() => randomValues());
  useEffect(() => {
    const id = setInterval(() => setValues(randomValues()), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <Box data-testid="entropy-storm">
      {values.map((v, i) => (
        <Box key={i} data-entropy={v} width="4px" height="4px" />
      ))}
    </Box>
  );
}

function randomValues(): string[] {
  return Array.from({ length: 100 }, () => {
    const bytes = new Uint8Array(1536);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
  });
}

function MonacoFixture() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    import("monaco-editor")
      .then((monaco) => {
        try {
          loader.config({ monaco });
        } catch {
          // Already configured by another editor.
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) return null;
  return (
    <Box data-testid="monaco-fixture" height="120px" width="400px">
      <Editor height="120px" defaultLanguage="java" defaultValue={"class SecretCode { int canary = 4242; }"} />
    </Box>
  );
}

export default function BugReportHarness() {
  const fixture = useSearchParams().get("fixture") ?? "inputs";
  const [md, setMd] = useState<string | undefined>("markdown canary text");
  return (
    <Stack p={4} gap={4}>
      <Heading size="md">Bug report recorder harness</Heading>
      <Text data-testid="plain-text">Visible harness text</Text>
      {fixture === "inputs" && (
        <Stack as="form" gap={2} maxW="md" onSubmit={(e) => e.preventDefault()}>
          <input aria-label="Display name" name="display_name" data-testid="text-input" />
          <input aria-label="Email" type="email" name="email" data-testid="email-input" />
          <textarea aria-label="Notes" name="notes" data-testid="textarea-input" />
          <select aria-label="Choice" name="choice" data-testid="select-input" defaultValue="a">
            <option value="a">Option alpha</option>
            <option value="b">Option beta</option>
          </select>
          <input aria-label="Password" type="password" name="password" data-testid="password-input" />
          <input aria-label="API token" name="api_token" data-testid="token-input" />
          <input type="hidden" name="csrf" value="hidden-canary-value" readOnly />
        </Stack>
      )}
      {fixture === "media" && (
        <Stack gap={2}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            data-testid="image"
            className="c6-image"
            alt="Photo of a student"
            width={64}
            height={48}
            src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='48'/%3E"
          />
          <video data-testid="video" className="c6-video" width={80} height={40} />
          <canvas data-testid="canvas" className="c6-canvas" width={50} height={30} />
          <Box data-testid="avatar-wrapper">
            <Avatar name="Avatar Canary Person" size="md" />
          </Box>
          <Box data-testid="report-block" className="c6-report-block" data-report-block="">
            Blocked by attribute
          </Box>
          <MonacoFixture />
          <Box data-testid="md-editor-fixture">
            <MdEditor value={md} onChange={setMd} height={150} />
          </Box>
        </Stack>
      )}
      {fixture === "mutations" && <MutationStorm />}
      {fixture === "entropy" && <EntropyStorm />}
    </Stack>
  );
}
