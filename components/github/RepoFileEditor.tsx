"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useColorMode } from "@/components/ui/color-mode";
import { Field } from "@/components/ui/field";
import { toaster } from "@/components/ui/toaster";
import { validatePawtograderConfig } from "@/components/ui/autograder-configuration";
import githubWorkflowSchema from "@/lib/schemas/github-workflow.schema.json";
import pawtograderSchema from "@/lib/schemas/pawtograder.schema.json";
import { EdgeFunctionError, repositoryGetFile, repositoryWriteFile } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import { Box, HStack, Input, List, NativeSelect, Spinner, Text, VStack } from "@chakra-ui/react";
import Editor, { Monaco, loader } from "@monaco-editor/react";
import { configureMonacoYaml } from "monaco-yaml";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as YAML from "yaml";

type RepoFileEditorProps = {
  courseId: number;
  orgName: string;
  repoName: string;
  /** Initial file path to edit (e.g. "pawtograder.yml" or ".github/workflows/grade.yml"). */
  path: string;
  /**
   * Optional list of selectable files. When provided, renders a file picker so the user
   * can switch between candidate config files in the same repo.
   */
  paths?: { label: string; path: string }[];
  onSaved?: (newSha: string | undefined) => void;
};

const PAWTOGRADER_SCHEMA_URI = "https://pawtograder.com/schemas/pawtograder.yml.json";
const GITHUB_WORKFLOW_SCHEMA_URI = "https://json.schemastore.org/github-workflow.json";

/** `# yaml-language-server: $schema=<url>` — the inline schema directive the yaml LS honours. */
const SCHEMA_MODELINE_RE = /^#\s*yaml-language-server:\s*.*\$schema=(\S+)/m;

/**
 * The message the yaml language server emits for a `$schema` it cannot fetch. Schema requests
 * are deliberately disabled (see applySchema), so a modeline we can't resolve locally produces
 * this marker — an editor limitation, not a defect in the file, so it must not block saving.
 */
const SCHEMA_REQUEST_UNAVAILABLE_RE = /No schema request service available/i;

function isPawtograderYml(path: string): boolean {
  return /(^|\/)pawtograder\.ya?ml$/i.test(path);
}

function isWorkflowFile(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
}

/**
 * The URL in the file's schema modeline, if any. Extracted separately from the file text so
 * schema re-registration is keyed on the URL (near-always stable) rather than on every keystroke.
 */
function schemaModelineUri(text: string): string | undefined {
  return SCHEMA_MODELINE_RE.exec(text)?.[1];
}

/**
 * assignment-action's own schema URL, e.g.
 * `https://raw.githubusercontent.com/pawtograder/assignment-action/refs/tags/v4/pawtograder.schema.json`.
 * Captures the git ref (`v4`, `v3.0.6`, `main`, …), which is what determines whether the bundled
 * copy describes the same config shape.
 */
const ASSIGNMENT_ACTION_SCHEMA_RE =
  /^\/pawtograder\/assignment-action\/(?:refs\/(?:tags|heads)\/)?([^/]+)\/pawtograder\.schema\.json$/i;

/**
 * Whether `url` names a schema the bundled copy can stand in for, so it can be served locally
 * instead of fetched.
 *
 * For pawtograder.yml this is deliberately narrow: `lib/schemas/pawtograder.schema.json` is a
 * verbatim copy of assignment-action **v4** (see lib/schemas/README.md), and earlier majors
 * describe a materially different config shape (v3 has no `grader` key, allows
 * `linter.policy: warn`, …). Serving v4's schema for a v3-pinned file would report errors that
 * aren't real, so leave those unresolved — refreshMarkers surfaces that as a non-blocking notice.
 */
function isKnownSchemaUrl(url: string, kind: "pawtograder" | "workflow"): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  if (kind === "workflow") {
    return /\/github-workflow\.json$/i.test(pathname);
  }
  const ref = ASSIGNMENT_ACTION_SCHEMA_RE.exec(pathname)?.[1];
  // `main` is best-effort: it tracked v4 when the copy was vendored.
  return !!ref && (/^v4(\.|$)/i.test(ref) || ref.toLowerCase() === "main");
}

/**
 * Monaco-based editor for repo config files (pawtograder.yml and GitHub Actions workflow
 * files) with live YAML schema validation/autocomplete and commit-back to the repo.
 *
 * - Loads the file (and its blob sha) via the repository-get-file edge function.
 * - Validates live against a JSON Schema matched by file path (monaco-yaml), plus a
 *   structural save-time guard for pawtograder.yml (validatePawtograderConfig).
 * - Saves via repository-write-file using the loaded sha for optimistic concurrency; on a
 *   stale-sha conflict it re-fetches and warns.
 */
export default function RepoFileEditor({ courseId, orgName, repoName, path, paths, onSaved }: RepoFileEditorProps) {
  const { colorMode } = useColorMode();
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const disposablesRef = useRef<import("monaco-editor").IDisposable[]>([]);
  const monacoYamlRef = useRef<import("monaco-yaml").MonacoYaml | null>(null);

  const [currentPath, setCurrentPath] = useState(path);
  const [content, setContent] = useState<string>("");
  const [sha, setSha] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [markerErrors, setMarkerErrors] = useState<string[]>([]);
  const [schemaWarnings, setSchemaWarnings] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [loaderReady, setLoaderReady] = useState(false);

  // Point @monaco-editor/react at the locally-bundled monaco instead of the default CDN.
  // This keeps the editor working in restricted/offline networks and ensures the main
  // thread and the bundled workers (configured below) are the same monaco version.
  useEffect(() => {
    let cancelled = false;
    import("monaco-editor")
      .then((monaco) => {
        if (cancelled) return;
        try {
          loader.config({ monaco });
        } catch {
          // loader.config throws if init already ran (another editor mounted first) —
          // safe to ignore; the configured monaco is shared process-wide.
        }
        setLoaderReady(true);
      })
      .catch(() => {
        // Fall back to the default (CDN) loader if the bundled import fails.
        if (!cancelled) setLoaderReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep currentPath in sync if the parent changes the path prop.
  useEffect(() => {
    setCurrentPath(path);
  }, [path]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    const supabase = createClient();
    try {
      // skipRetryOnNotFound: a not-yet-created file is a valid "create new file" starting point
      // here, so fail fast instead of letting the function sleep 15s + retry before returning 404.
      const res = await repositoryGetFile(
        { courseId, orgName, repoName, path: currentPath, skipRetryOnNotFound: true },
        supabase
      );
      setContent(res.content ?? "");
      setSha(res.sha);
      setDirty(false);
      setCommitMessage(`Update ${currentPath} via Pawtograder`);
    } catch (err) {
      const message = err instanceof EdgeFunctionError || err instanceof Error ? err.message : String(err);
      const details = err instanceof EdgeFunctionError ? err.details : "";
      // A genuinely-missing file is an editable starting point (create-on-save). But other
      // 404-shaped errors serialize to the same message "Not Found" with the specifics in
      // `details` — notably the org-not-installed case ("No GitHub App installation found...").
      // Only treat it as create-on-save when the details confirm a missing FILE; otherwise surface
      // the actionable error instead of presenting a misleading blank "Create file" buffer.
      if (message === "Not Found" && /not found in/i.test(details)) {
        setContent("");
        setSha(undefined);
        setDirty(false);
        setCommitMessage(`Create ${currentPath} via Pawtograder`);
      } else {
        setLoadError(details || message);
      }
    } finally {
      setLoading(false);
    }
  }, [courseId, orgName, repoName, currentPath]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  // Derive the schema purely from the live model uri (not from closure state) so it stays
  // correct when @monaco-editor/react swaps the model on a file switch — including when
  // called from the one-time onDidChangeModel listener (which would otherwise capture a
  // stale schema).
  const applySchema = useCallback((monaco: Monaco) => {
    const model = editorRef.current?.getModel();
    const modelUri = model?.uri.toString() ?? null;
    let cfg: { uri: string; schema: unknown; kind: "pawtograder" | "workflow" } | undefined;
    if (modelUri && isPawtograderYml(modelUri)) {
      cfg = { uri: PAWTOGRADER_SCHEMA_URI, schema: pawtograderSchema, kind: "pawtograder" };
    } else if (modelUri && isWorkflowFile(modelUri)) {
      cfg = { uri: GITHUB_WORKFLOW_SCHEMA_URI, schema: githubWorkflowSchema, kind: "workflow" };
    }
    const schemas: { uri: string; fileMatch: string[]; schema: Record<string, unknown> }[] = [];
    if (cfg && modelUri) {
      schemas.push({ uri: cfg.uri, fileMatch: [modelUri], schema: cfg.schema as Record<string, unknown> });
      // `enableSchemaRequest: false` keeps the editor working in restricted/offline networks: the
      // yaml worker gets no schemaRequestService and never fetches over the network. But the yaml
      // language server resolves an inline `# yaml-language-server: $schema=<url>` modeline in
      // preference to these fileMatch associations, and that resolution goes through the (absent)
      // request service — yielding "Unable to load schema from '<url>'. No schema request service
      // available" on the modeline. Files scaffolded by assignment-action carry exactly such a
      // modeline pointing at a version-tagged raw.githubusercontent.com URL. Registering the
      // bundled schema a second time under the modeline's own URL puts it in the worker's schema
      // cache, so the modeline resolves locally with no request at all — but only for URLs the
      // bundled copy actually matches (isKnownSchemaUrl).
      const modelineUri = model && schemaModelineUri(model.getValue());
      if (modelineUri && modelineUri !== cfg.uri && isKnownSchemaUrl(modelineUri, cfg.kind)) {
        schemas.push({ uri: modelineUri, fileMatch: [modelUri], schema: cfg.schema as Record<string, unknown> });
      }
    }
    // monaco-yaml supports only one configured instance at a time, and configureMonacoYaml
    // registers a full set of language providers on every call. Configure once, then update() —
    // which swaps the worker's createData (dropping its schema cache) and revalidates.
    const options = { enableSchemaRequest: false, schemas };
    const existing = monacoYamlRef.current;
    if (existing) {
      existing.update(options).catch(() => {
        // A reconfigure race (unmount mid-update) is not actionable; markers refresh on the
        // next onDidChangeMarkers regardless.
      });
    } else {
      monacoYamlRef.current = configureMonacoYaml(monaco, options);
    }
  }, []);

  const handleBeforeMount = useCallback(() => {
    window.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        switch (label) {
          case "editorWorkerService":
            return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
          case "yaml":
            return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
          default:
            throw new Error(`Unknown Monaco worker label: ${label}`);
        }
      }
    };
  }, []);

  const refreshMarkers = useCallback((monaco: Monaco) => {
    const model = editorRef.current?.getModel();
    if (!model) {
      setMarkerErrors([]);
      setSchemaWarnings([]);
      return;
    }
    // Block on errors AND warnings: the yaml language server reports JSON-Schema
    // violations (unknown/missing keys, wrong types) at Warning severity, and those should
    // prevent committing an invalid config file.
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    const messages = markers
      .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
      .map((m) => `Line ${m.startLineNumber}: ${m.message}`);
    // "…No schema request service available" means the file's $schema modeline points somewhere
    // we can't resolve offline (an unrecognized host or filename — recognized ones are aliased to
    // the bundled schema in applySchema). The file itself may be perfectly valid, so surface this
    // as a notice and keep saving available; the structural guard still runs on pawtograder.yml.
    setSchemaWarnings(messages.filter((m) => SCHEMA_REQUEST_UNAVAILABLE_RE.test(m)));
    setMarkerErrors(messages.filter((m) => !SCHEMA_REQUEST_UNAVAILABLE_RE.test(m)));
  }, []);

  const handleMount = useCallback(
    (editor: import("monaco-editor").editor.IStandaloneCodeEditor, monaco: Monaco) => {
      monacoRef.current = monaco;
      editorRef.current = editor;
      // Expose monaco for tests/devtools (mirrors the gradebook expression editor).
      (window as unknown as { monaco?: Monaco }).monaco = monaco;
      applySchema(monaco);
      refreshMarkers(monaco);
      // Track listeners so they can be disposed on unmount/remount (avoids leaking
      // listeners and duplicate marker-refresh work).
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [
        monaco.editor.onDidChangeMarkers(() => refreshMarkers(monaco)),
        // The model is swapped when the edited file changes; re-bind schema + markers.
        editor.onDidChangeModel(() => {
          applySchema(monaco);
          refreshMarkers(monaco);
        })
      ];
    },
    [applySchema, refreshMarkers]
  );

  // Dispose Monaco listeners and the monaco-yaml configuration on unmount. monaco-yaml registers
  // its providers on the process-global monaco instance, so leaving it configured would leak a
  // provider set (and this component's schemas) for the rest of the session.
  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
      monacoYamlRef.current?.dispose();
      monacoYamlRef.current = null;
    };
  }, []);

  // The modeline URL the current text points at, if any. Keyed on separately from `content` so
  // editing the file body doesn't re-register schemas (see the effect below).
  const modelineUri = useMemo(() => schemaModelineUri(content), [content]);

  // Re-apply schema when the selected file changes (a fallback alongside onDidChangeModel), or
  // when the file's schema modeline changes (its URL needs registering as an alias for the
  // bundled schema). Deferred so the model swap has committed. Intentionally NOT keyed on
  // `content` itself: the schema is derived from the model URI plus the modeline, not the body,
  // and configureMonacoYaml reconfigures the process-global monaco-yaml service — re-running it
  // on every keystroke leaks/churns registrations. Live marker updates already arrive via the
  // onDidChangeMarkers listener.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const id = setTimeout(() => {
      applySchema(monaco);
      refreshMarkers(monaco);
    }, 0);
    return () => clearTimeout(id);
  }, [currentPath, modelineUri, applySchema, refreshMarkers]);

  // Save-time structural guard, in addition to the live monaco-yaml schema markers.
  const structuralError = useMemo(() => {
    if (loading || loadError) return undefined;
    let parsed: unknown;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      return `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (isPawtograderYml(currentPath)) {
      const result = validatePawtograderConfig(parsed);
      if (!result.isValid) {
        return `Invalid pawtograder.yml: ${result.error}`;
      }
    }
    return undefined;
  }, [content, currentPath, loading, loadError]);

  const blockingErrors = useMemo(() => {
    const errs = [...markerErrors];
    if (structuralError) errs.push(structuralError);
    return errs;
  }, [markerErrors, structuralError]);

  const canSave = dirty && !saving && !loading && blockingErrors.length === 0 && commitMessage.trim().length > 0;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    const supabase = createClient();
    try {
      const res = await repositoryWriteFile(
        { courseId, orgName, repoName, path: currentPath, content, message: commitMessage.trim(), sha },
        supabase
      );
      setSha(res.content_sha);
      setDirty(false);
      toaster.create({
        title: "File saved",
        description: `Committed ${currentPath} to ${orgName}/${repoName}.`,
        type: "success"
      });
      onSaved?.(res.content_sha);
    } catch (err) {
      const message = err instanceof EdgeFunctionError || err instanceof Error ? err.message : String(err);
      if (message.includes("changed since you loaded")) {
        toaster.create({
          title: "File changed on GitHub",
          description: "Reloading the latest version. Re-apply your edits and save again.",
          type: "warning"
        });
        await loadFile();
      } else {
        toaster.create({ title: "Failed to save file", description: message, type: "error" });
      }
    } finally {
      setSaving(false);
    }
  }, [canSave, courseId, orgName, repoName, currentPath, content, commitMessage, sha, onSaved, loadFile]);

  return (
    <VStack align="stretch" gap={3} data-testid="repo-file-editor">
      <HStack justify="space-between" wrap="wrap" gap={2}>
        <VStack align="start" gap={0}>
          <Text fontSize="sm" fontWeight="medium">
            {orgName}/{repoName}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {currentPath}
          </Text>
        </VStack>
        {paths && paths.length > 0 && (
          <Field label="File" w="auto">
            {/* Disable while a save is in flight (or a load is pending): switching files mid-save
                would let the in-flight save's setSha/setDirty resolve against the newly-loaded
                file, clobbering its sha and corrupting optimistic-concurrency on the next save. */}
            <NativeSelect.Root size="sm" w="320px" disabled={saving || loading}>
              <NativeSelect.Field
                aria-label="Select file to edit"
                value={currentPath}
                onChange={(e) => setCurrentPath(e.target.value)}
              >
                {paths.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.label}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field>
        )}
      </HStack>

      {loadError && (
        <Alert status="error" title="Failed to load file">
          {loadError}
        </Alert>
      )}

      <Box borderWidth="1px" borderColor="border.emphasized" borderRadius="md" overflow="hidden">
        {loading || !loaderReady ? (
          <HStack p={6} justify="center">
            <Spinner size="sm" />
            <Text fontSize="sm" color="fg.muted">
              Loading {currentPath}…
            </Text>
          </HStack>
        ) : (
          <Editor
            height="420px"
            width="100%"
            path={currentPath}
            defaultLanguage="yaml"
            language="yaml"
            value={content}
            theme={colorMode === "dark" ? "vs-dark" : "vs"}
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            onChange={(value) => {
              setContent(value ?? "");
              setDirty(true);
            }}
            options={{
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 14,
              tabSize: 2,
              insertSpaces: true,
              wordWrap: "on",
              lineNumbers: "on",
              folding: true,
              automaticLayout: true
            }}
          />
        )}
      </Box>

      {blockingErrors.length > 0 && (
        <Alert status="error" title="Fix validation errors before saving" data-testid="repo-file-editor-errors">
          <List.Root>
            {blockingErrors.map((e, i) => (
              <List.Item key={i} fontSize="sm">
                {e}
              </List.Item>
            ))}
          </List.Root>
        </Alert>
      )}

      {schemaWarnings.length > 0 && (
        <Alert status="warning" title="Schema could not be loaded" data-testid="repo-file-editor-schema-warning">
          <VStack align="stretch" gap={1}>
            <Text fontSize="sm">
              This file&apos;s <code>$schema</code> comment points at a schema this editor cannot fetch, so live
              schema-based validation is off for it. You can still edit and commit.
            </Text>
            <List.Root>
              {schemaWarnings.map((e, i) => (
                <List.Item key={i} fontSize="sm">
                  {e}
                </List.Item>
              ))}
            </List.Root>
          </VStack>
        </Alert>
      )}

      <Field label="Commit message">
        <Input
          size="sm"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          placeholder={`Update ${currentPath} via Pawtograder`}
        />
      </Field>

      <HStack justify="flex-end" gap={2}>
        <Button variant="outline" size="sm" onClick={() => loadFile()} disabled={saving || loading}>
          Reload
        </Button>
        <Button
          colorPalette="green"
          size="sm"
          onClick={handleSave}
          loading={saving}
          disabled={!canSave}
          data-testid="repo-file-editor-save"
        >
          Save &amp; commit
        </Button>
      </HStack>
    </VStack>
  );
}
