import * as Sentry from "@sentry/nextjs";

/**
 * The single `MonacoEnvironment.getWorker` for every Monaco editor in the app.
 *
 * Monaco runs each worker-backed language service in its OWN web worker, and asks for it by
 * `label`, which is the **language id** — not a fixed worker name. `jsonMode`/`cssMode`/`htmlMode`
 * pass `this._defaults.languageId` and `tsMode` passes `this._modeId`, so the labels that can
 * actually arrive are the ones in {@link resolveMonacoWorkerKind}.
 *
 * This existed in six near-identical copies, none of which mapped anything but `yaml` and
 * `editorWorkerService`, and `window.MonacoEnvironment` is a single global that the last-mounted
 * editor overwrites. So the behaviour for a `.ts` file depended on which page you had visited
 * first, and both outcomes were broken:
 *
 *   - Five copies threw `Unknown Monaco worker label: typescript`.
 *   - The grading viewer returned the plain editor worker instead. Monaco then asked that worker
 *     to `$loadForeignModule("vs/language/typescript/tsWorker")`, which in an ESM build reaches
 *     `FileAccess.toUri(moduleId, require)` with no AMD `require` present and dies on
 *     `Cannot read properties of undefined (reading 'toUrl')` — as an unhandled rejection, over
 *     and over. That was 110 events in production on the submission files viewer, where the
 *     assignment in question is ~101k .ts/.tsx, 15k .css and 8.8k .json files, i.e. essentially
 *     every file a student submits.
 *
 * The language services only exist at all once something has pulled in the full `monaco-editor`
 * (RepoFileEditor's `loader.config({ monaco })` does), which is why this reproduced by visiting a
 * manage page and then opening a submission rather than on a cold load.
 */

/** Which worker bundle serves a given Monaco language id. */
export type MonacoWorkerKind = "json" | "css" | "html" | "typescript" | "yaml" | "editor";

/**
 * Map a Monaco worker label (a language id) to the worker that can serve it.
 *
 * Split out from {@link getMonacoWorker} so the mapping is testable: the `new URL(...)` calls there
 * must stay as static literals for webpack to emit the worker bundles, which makes that function
 * impossible to exercise under jsdom.
 *
 * `editor` is returned for unknown labels as a fallback, not a fix — see {@link getMonacoWorker}.
 */
export function resolveMonacoWorkerKind(label: string): MonacoWorkerKind {
  switch (label) {
    case "json":
      return "json";
    // The css service registers itself for all three of these language ids.
    case "css":
    case "scss":
    case "less":
      return "css";
    // Likewise the html service.
    case "html":
    case "handlebars":
    case "razor":
      return "html";
    // tsMode passes the mode id, which is "javascript" for .js/.jsx and "typescript" for .ts/.tsx.
    case "typescript":
    case "javascript":
      return "typescript";
    case "yaml":
      return "yaml";
    default:
      return "editor";
  }
}

/** Labels already reported as unmapped, so one unknown language service is not one event per mount. */
const reportedUnknownLabels = new Set<string>();

export function getMonacoWorker(_moduleId: string, label: string): Worker {
  const kind = resolveMonacoWorkerKind(label);

  // An unknown label means a language service we have not mapped. Returning the editor worker
  // cannot actually serve it — only the real worker can — so this is a genuine fallback: the editor
  // still renders the file and only that language's diagnostics are lost, which beats throwing and
  // taking the grading UI down. Report it once so a newly worker-backed language shows up as a
  // named gap instead of silently regressing to the bug described above.
  if (kind === "editor" && label !== "editorWorkerService" && !reportedUnknownLabels.has(label)) {
    reportedUnknownLabels.add(label);
    console.warn(
      `[monaco] No worker mapped for language "${label}"; falling back to the editor worker. ` +
        `That language's diagnostics and completions will not work. Map it in lib/monacoWorkers.ts.`
    );
    Sentry.captureMessage(`Monaco worker label "${label}" is not mapped`, {
      level: "warning",
      fingerprint: ["monaco-unmapped-worker-label", label],
      tags: { monaco_label: label }
    });
  }

  switch (kind) {
    case "json":
      return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker", import.meta.url));
    case "css":
      return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker", import.meta.url));
    case "html":
      return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker", import.meta.url));
    case "typescript":
      return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker", import.meta.url));
    case "yaml":
      return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
    case "editor":
      return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url));
  }
}

/**
 * Install {@link getMonacoWorker} as the process-wide Monaco worker factory.
 *
 * Safe to call from every editor's `beforeMount`: `MonacoEnvironment` is one global and every
 * caller now installs the same implementation, so last-writer-wins stops mattering. That is the
 * point — it is what makes the behaviour independent of which page mounted an editor first.
 */
export function configureMonacoWorkers(): void {
  if (typeof window === "undefined") return;
  window.MonacoEnvironment = { getWorker: getMonacoWorker };
}
