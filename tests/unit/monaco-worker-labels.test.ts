import { resolveMonacoWorkerKind } from "@/lib/monacoWorkers";

/**
 * Monaco asks for a worker by LANGUAGE ID, not by a fixed worker name, and every worker-backed
 * language service needs its own worker bundle. Handing back the plain editor worker makes Monaco
 * try `$loadForeignModule`, which in an ESM build throws
 * `Cannot read properties of undefined (reading 'toUrl')` as an unhandled rejection — 110 events in
 * production on the submission files viewer.
 *
 * These pin the labels that actually reach `getWorker`, taken from monaco-editor 0.52.2:
 * jsonMode/cssMode/htmlMode pass `this._defaults.languageId`, tsMode passes `this._modeId`.
 */
describe("resolveMonacoWorkerKind", () => {
  it("routes the languages students actually submit to their own workers", () => {
    // The four that produced the production crash, in descending order of how much of the
    // offending assignment they account for: .ts/.tsx, .css, .json, .html.
    expect(resolveMonacoWorkerKind("typescript")).toBe("typescript");
    expect(resolveMonacoWorkerKind("javascript")).toBe("typescript");
    expect(resolveMonacoWorkerKind("css")).toBe("css");
    expect(resolveMonacoWorkerKind("json")).toBe("json");
    expect(resolveMonacoWorkerKind("html")).toBe("html");
  });

  it("covers every language id each service registers, not just the common one", () => {
    // The css service claims scss/less too, and the html service claims handlebars/razor. Mapping
    // only the headline id leaves the others falling through to the editor worker.
    expect(resolveMonacoWorkerKind("scss")).toBe("css");
    expect(resolveMonacoWorkerKind("less")).toBe("css");
    expect(resolveMonacoWorkerKind("handlebars")).toBe("html");
    expect(resolveMonacoWorkerKind("razor")).toBe("html");
  });

  it("keeps yaml on monaco-yaml's worker", () => {
    // This was the one label the old copies did map; it must not regress.
    expect(resolveMonacoWorkerKind("yaml")).toBe("yaml");
  });

  it("serves Monaco's own services from the editor worker", () => {
    expect(resolveMonacoWorkerKind("editorWorkerService")).toBe("editor");
  });

  it("falls back to the editor worker for a language with no worker-backed service", () => {
    // Plain highlighting only: these never call createWebWorker, so the fallback is never exercised
    // for them in practice and must not throw if it is.
    expect(resolveMonacoWorkerKind("python")).toBe("editor");
    expect(resolveMonacoWorkerKind("markdown")).toBe("editor");
    expect(resolveMonacoWorkerKind("plaintext")).toBe("editor");
    expect(resolveMonacoWorkerKind("")).toBe("editor");
  });
});
