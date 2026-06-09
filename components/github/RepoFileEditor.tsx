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

function isPawtograderYml(path: string): boolean {
  return /(^|\/)pawtograder\.ya?ml$/i.test(path);
}

function isWorkflowFile(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
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

  const [currentPath, setCurrentPath] = useState(path);
  const [content, setContent] = useState<string>("");
  const [sha, setSha] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [markerErrors, setMarkerErrors] = useState<string[]>([]);
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
      const res = await repositoryGetFile({ courseId, orgName, repoName, path: currentPath }, supabase);
      setContent(res.content ?? "");
      setSha(res.sha);
      setDirty(false);
      setCommitMessage(`Update ${currentPath} via Pawtograder`);
    } catch (err) {
      const message = err instanceof EdgeFunctionError || err instanceof Error ? err.message : String(err);
      // A missing file is an editable starting point (create-on-save), not a hard error.
      if (message === "Not Found") {
        setContent("");
        setSha(undefined);
        setDirty(false);
        setCommitMessage(`Create ${currentPath} via Pawtograder`);
      } else {
        setLoadError(message);
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
    let cfg: { uri: string; schema: unknown } | undefined;
    if (modelUri && isPawtograderYml(modelUri)) {
      cfg = { uri: PAWTOGRADER_SCHEMA_URI, schema: pawtograderSchema };
    } else if (modelUri && isWorkflowFile(modelUri)) {
      cfg = { uri: GITHUB_WORKFLOW_SCHEMA_URI, schema: githubWorkflowSchema };
    }
    configureMonacoYaml(monaco, {
      enableSchemaRequest: false,
      schemas:
        cfg && modelUri ? [{ uri: cfg.uri, fileMatch: [modelUri], schema: cfg.schema as Record<string, unknown> }] : []
    });
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
      return;
    }
    // Block on errors AND warnings: the yaml language server reports JSON-Schema
    // violations (unknown/missing keys, wrong types) at Warning severity, and those should
    // prevent committing an invalid config file.
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    const errors = markers
      .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
      .map((m) => `Line ${m.startLineNumber}: ${m.message}`);
    setMarkerErrors(errors);
  }, []);

  const handleMount = useCallback(
    (editor: import("monaco-editor").editor.IStandaloneCodeEditor, monaco: Monaco) => {
      monacoRef.current = monaco;
      editorRef.current = editor;
      // Expose monaco for tests/devtools (mirrors the gradebook expression editor).
      (window as unknown as { monaco?: Monaco }).monaco = monaco;
      applySchema(monaco);
      refreshMarkers(monaco);
      monaco.editor.onDidChangeMarkers(() => refreshMarkers(monaco));
      // The model is swapped when the edited file changes; re-bind schema + markers.
      editor.onDidChangeModel(() => {
        applySchema(monaco);
        refreshMarkers(monaco);
      });
    },
    [applySchema, refreshMarkers]
  );

  // Re-apply schema when the selected file changes (a fallback alongside onDidChangeModel,
  // and after the new model's content settles). Deferred so the model swap has committed.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const id = setTimeout(() => {
      applySchema(monaco);
      refreshMarkers(monaco);
    }, 0);
    return () => clearTimeout(id);
  }, [currentPath, content, applySchema, refreshMarkers]);

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
            <NativeSelect.Root size="sm" w="320px">
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
