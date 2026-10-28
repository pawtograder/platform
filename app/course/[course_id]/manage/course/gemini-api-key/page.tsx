"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useAnnouncer } from "@/components/ui/live-announcer";
import { PopConfirm } from "@/components/ui/popconfirm";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import {
  classifyGeminiKeyError,
  GEMINI_KEY_FAILURE_TEXT,
  isBlankGeminiKey,
  parseGeminiKeyOutcome,
  parseGeminiKeyStatus,
  successText,
  type GeminiKeyStatus
} from "@/lib/courseGeminiKey";
import { createClient } from "@/utils/supabase/client";
import { Badge, Box, Card, HStack, Heading, Input, Link, Text, VStack } from "@chakra-ui/react";
import NextLink from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; status: GeminiKeyStatus }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

type Notice = { tone: "success" | "error" | "warning"; text: string } | null;

export default function CourseGeminiKeyPage() {
  const { course_id } = useParams();
  const { role } = useClassProfiles();
  const courseId = Number.parseInt(course_id as string, 10);

  if (!role || role.role !== "instructor" || Number.isNaN(courseId)) {
    return (
      <Box p={6}>
        <Text>Access denied. This page is only available to instructors.</Text>
      </Box>
    );
  }
  // Keyed by course: switching courses mounts a fresh panel, so no state (status, input, pending
  // request results) carries over from the previous course.
  return <GeminiKeyPanel key={courseId} courseId={courseId} />;
}

function GeminiKeyPanel({ courseId }: { courseId: number }) {
  const announce = useAnnouncer();
  const [panel, setPanel] = useState<PanelState>({ kind: "loading" });
  const [keyInput, setKeyInput] = useState("");
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const mounted = useRef(true);
  const statusRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Reads status; only the latest request for this mounted panel may update it. */
  const loadStatus = useCallback(async () => {
    const requestId = ++statusRequest.current;
    const supabase = createClient();
    const res = await supabase.rpc("get_course_gemini_key_status", { p_class_id: courseId });
    if (!mounted.current || requestId !== statusRequest.current) return;
    if (res.error) {
      setPanel(
        classifyGeminiKeyError(res.error, res.status) === "forbidden" ? { kind: "forbidden" } : { kind: "unavailable" }
      );
      return;
    }
    const status = parseGeminiKeyStatus(res.data);
    setPanel(status ? { kind: "ready", status } : { kind: "unavailable" });
  }, [courseId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const finish = useCallback(
    async (n: Notice) => {
      // Every settle clears the secret input, whatever the outcome.
      setKeyInput("");
      if (!mounted.current) return;
      setNotice(n);
      if (n) announce(n.text, { priority: n.tone === "success" ? "polite" : "assertive" });
      await loadStatus();
      if (mounted.current) setPending(null);
    },
    [announce, loadStatus]
  );

  const runMutation = useCallback(
    async (kind: "save" | "remove") => {
      // The panel is keyed by course, so `courseId` is the course this click was made for.
      const target = courseId;
      const value = keyInput;
      setPending(kind);
      setNotice(null);
      try {
        const supabase = createClient();
        const res =
          kind === "save"
            ? await supabase.rpc("set_course_gemini_key", { p_class_id: target, p_api_key: value })
            : await supabase.rpc("remove_course_gemini_key", { p_class_id: target });
        if (res.error) {
          const failure = classifyGeminiKeyError(res.error, res.status);
          await finish({ tone: failure === "unknown" ? "warning" : "error", text: GEMINI_KEY_FAILURE_TEXT[failure] });
          return;
        }
        // A success response the client can't interpret is not shown as success.
        const outcome = parseGeminiKeyOutcome(kind, res.data);
        await finish(
          outcome
            ? { tone: "success", text: successText(outcome) }
            : { tone: "warning", text: GEMINI_KEY_FAILURE_TEXT.unknown }
        );
      } catch {
        // A throw means no usable response: the outcome is unknown.
        await finish({ tone: "warning", text: GEMINI_KEY_FAILURE_TEXT.unknown });
      }
    },
    [courseId, finish, keyInput]
  );

  const status = panel.kind === "ready" ? panel.status : null;
  const canSave = !!status?.setup_enabled && pending === null && !isBlankGeminiKey(keyInput);

  return (
    <Box p={4} maxW="2xl" data-testid="gemini-key-page" data-course-id={courseId}>
      <VStack align="stretch" gap={6}>
        <Box>
          <Heading size="lg">Gemini API key</Heading>
          <Text fontSize="sm" color="fg.muted" mt={1}>
            Store one Gemini API key for this course. It is shared by all of the course&apos;s instructors and is
            encrypted when stored. Nobody can view it again after it is saved: not you, other instructors, or students.
          </Text>
          <Text fontSize="sm" color="fg.muted" mt={2}>
            Saving a key does not check it with Google and does not turn on AI grading. &ldquo;Configured&rdquo; only
            means a key is stored.
          </Text>
        </Box>

        <Box role="status" aria-live="polite" data-testid="gemini-key-notice">
          {notice ? <Alert status={notice.tone} title={notice.text} /> : null}
        </Box>

        {panel.kind === "loading" ? (
          <Text data-testid="gemini-key-loading">Loading configuration status…</Text>
        ) : panel.kind === "forbidden" ? (
          <Alert status="error" title={GEMINI_KEY_FAILURE_TEXT.forbidden} data-testid="gemini-key-forbidden" />
        ) : panel.kind === "unavailable" ? (
          <Alert
            status="warning"
            title="Configuration status is unavailable"
            data-testid="gemini-key-unavailable"
            endElement={
              <Button size="sm" variant="outline" onClick={() => void loadStatus()}>
                Retry
              </Button>
            }
          >
            The status could not be loaded, so it is not known whether a key is stored. This does not mean no key is
            stored.
          </Alert>
        ) : (
          <Card.Root>
            <Card.Body>
              <VStack align="stretch" gap={3} data-testid="gemini-key-status">
                <HStack>
                  <Text fontWeight="semibold" minW="10rem">
                    Setup
                  </Text>
                  <Badge colorPalette={panel.status.setup_enabled ? "green" : "gray"} data-testid="gemini-key-setup">
                    {panel.status.setup_enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </HStack>
                <HStack>
                  <Text fontWeight="semibold" minW="10rem">
                    Key
                  </Text>
                  <Badge colorPalette={panel.status.configured ? "blue" : "gray"} data-testid="gemini-key-configured">
                    {panel.status.configured ? "Configured (not validated)" : "Not configured"}
                  </Badge>
                </HStack>
                {!panel.status.setup_enabled ? (
                  <Text fontSize="sm" color="fg.muted" data-testid="gemini-key-disabled-help">
                    Setup is disabled, so a key can&apos;t be saved or replaced. A stored key is kept and can still be
                    removed. To enable setup, turn on &ldquo;Gemini API key setup&rdquo; in{" "}
                    <Link asChild color="blue.fg">
                      <NextLink href={`/course/${courseId}/manage/course/feature-flags`}>Feature flags</NextLink>
                    </Link>
                    .
                  </Text>
                ) : null}
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {status ? (
          <Card.Root>
            <Card.Body>
              <form
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSave) void runMutation("save");
                }}
              >
                <VStack align="stretch" gap={4}>
                  <Field
                    label={status.configured ? "New Gemini API key" : "Gemini API key"}
                    helperText={
                      status.configured
                        ? "Saving replaces the stored key. Surrounding spaces are removed."
                        : "Surrounding spaces are removed."
                    }
                    disabled={!status.setup_enabled || pending !== null}
                  >
                    <Input
                      type="password"
                      name="course-gemini-api-key"
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      data-1p-ignore
                      data-lpignore="true"
                      className="ph-no-capture"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      data-testid="gemini-key-input"
                    />
                  </Field>
                  <HStack>
                    <Button
                      type="submit"
                      disabled={!canSave}
                      loading={pending === "save"}
                      data-testid="gemini-key-save"
                    >
                      {status.configured ? "Replace key" : "Save key"}
                    </Button>
                    {status.configured ? (
                      <PopConfirm
                        triggerLabel="Remove key"
                        trigger={
                          <Button
                            variant="outline"
                            colorPalette="red"
                            disabled={pending !== null}
                            loading={pending === "remove"}
                            data-testid="gemini-key-remove"
                          >
                            Remove key
                          </Button>
                        }
                        confirmHeader="Remove the stored key?"
                        confirmText="Pawtograder will delete its copy of the key. This does not revoke the key at Google."
                        onConfirm={() => runMutation("remove")}
                      />
                    ) : null}
                  </HStack>
                </VStack>
              </form>
            </Card.Body>
          </Card.Root>
        ) : null}
      </VStack>
    </Box>
  );
}
