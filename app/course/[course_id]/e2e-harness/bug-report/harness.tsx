"use client";

import { Avatar } from "@/components/ui/avatar";
import MdEditor from "@/components/ui/md-editor";
import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import Editor, { loader } from "@monaco-editor/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import BugReportUnmaskHarness from "@/app/e2e-harness/bug-report-unmask/BugReportUnmaskHarness";
import { parseLeakValues, type LeakValues } from "./leakValues";

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

/**
 * Canary values on every surface the redaction walker covers (D8-D12, D15, D17), all inside
 * `data-report-unmask` so rrweb records them as text and only the walker stands between them
 * and an upload.
 */
function LeakFixture({ v }: { v: LeakValues }) {
  const [first, ...rest] = v.name.split(" ");
  const last = rest.join(" ");
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    document.title = `${v.name} | Bug report harness`;
    const id = setTimeout(() => setLate(v.otherName), 30_000);
    return () => clearTimeout(id);
  }, [v]);
  return (
    <Stack gap={2} data-report-unmask="" data-testid="leak-fixture">
      <Text data-testid="d8-split">
        <b>{first}</b> {last}
      </Text>
      <Text data-testid="d8-handle">
        <span>{v.handle.slice(0, 3)}</span>
        <i>{v.handle.slice(3)}</i>
      </Text>
      <Text data-testid="d9-sortable">
        {last}, {first}
      </Text>
      <Text data-testid="d9-person-name">
        {v.name}
        <span> ({v.otherName})</span>
      </Text>
      <Text data-testid="d9-case">
        {v.handle.toUpperCase()} {v.name.toLowerCase()} {v.email.toUpperCase()}
      </Text>
      <Box data-testid="d10-attrs" title={v.name} aria-label={`Row for ${v.name}`}>
        attributes
      </Box>
      <input data-testid="d10-input" aria-label="Contact" placeholder={`e.g. ${v.email}`} />
      <a data-testid="d10-mailto" href={`mailto:${v.email}`}>
        Email the student
      </a>
      <a data-testid="d10-href" href={`?student=${encodeURIComponent(v.name)}`}>
        Profile link
      </a>
      <Text data-testid="d12-late">Assigned to: {late ?? "nobody yet"}</Text>
      <Box data-testid="d15-unmask-harness">
        <BugReportUnmaskHarness name={v.name} />
      </Box>
    </Stack>
  );
}

export default function BugReportHarness() {
  const params = useSearchParams();
  const fixture = params.get("fixture") ?? "inputs";
  const leak = fixture === "leaks" ? parseLeakValues(params.get("v")) : null;
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
      {leak && <LeakFixture v={leak} />}
    </Stack>
  );
}
