#!/usr/bin/env npx tsx
/* eslint-disable no-console */
import { Agent, type SDKMessage } from "@cursor/sdk";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

const requireFromWorkspace = createRequire(`${process.cwd()}/package.json`);

type CliOptions = {
  suiteRuns: number;
  diagnosticReruns: number;
  validationReruns: number;
  maxCandidates: number;
  workers?: number;
  baseUrl?: string;
  model: string;
  reportDir: string;
  projects: string[];
  grep?: string;
  dryRun: boolean;
  skipRepair: boolean;
  help: boolean;
};

type PlaywrightReport = {
  config?: { rootDir?: string };
  suites?: PlaywrightSuite[];
  errors?: PlaywrightError[];
};

type PlaywrightSuite = {
  title?: string;
  file?: string;
  line?: number;
  suites?: PlaywrightSuite[];
  specs?: PlaywrightSpec[];
};

type PlaywrightSpec = {
  title: string;
  file?: string;
  line?: number;
  tests?: PlaywrightTest[];
};

type PlaywrightTest = {
  projectName?: string;
  status?: string;
  expectedStatus?: string;
  results?: PlaywrightResult[];
};

type PlaywrightResult = {
  status?: string;
  duration?: number;
  retry?: number;
  error?: PlaywrightError;
  errors?: PlaywrightError[];
  attachments?: PlaywrightAttachment[];
  stdout?: PlaywrightOutput[];
  stderr?: PlaywrightOutput[];
};

type PlaywrightError = {
  message?: string;
  stack?: string;
  value?: string;
};

type PlaywrightAttachment = {
  name: string;
  path?: string;
  contentType?: string;
};

type PlaywrightOutput = string | { text?: string; buffer?: string };

type TestObservation = {
  key: string;
  file: string;
  line?: number;
  title: string;
  projectName?: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  errors: string[];
  attachments: AttachmentEvidence[];
};

type AttachmentEvidence = {
  name: string;
  originalPath: string;
  copiedPath?: string;
  contentType?: string;
  sha256?: string;
};

type PlaywrightRun = {
  label: string;
  exitCode: number;
  command: string;
  rawLogPath: string;
  jsonPath?: string;
  observations: TestObservation[];
  parseError?: string;
  reportErrors: string[];
};

type Candidate = {
  key: string;
  file: string;
  line?: number;
  title: string;
  projectName?: string;
  suiteStatuses: TestObservation["status"][];
  diagnosticStatuses: TestObservation["status"][];
  classification: "flaky" | "stable-failure";
  visual: VisualEvidence;
  sampleErrors: string[];
};

type VisualEvidence = {
  suspected: boolean;
  reason?: string;
  imageDiffs: ImageDiff[];
  attachments: AttachmentEvidence[];
};

type ImageDiff = {
  attachmentName: string;
  firstImage: string;
  secondImage: string;
  width?: number;
  height?: number;
  differingPixels?: number;
  diffRatio?: number;
  note?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    suiteRuns: 3,
    diagnosticReruns: 8,
    validationReruns: 5,
    maxCandidates: 10,
    model: "composer-2.5",
    reportDir: path.join("artifacts", "flaky-test-triage", timestamp()),
    projects: [],
    dryRun: false,
    skipRepair: false,
    help: false
  };

  const readValue = (args: string[], index: number, flag: string) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--suite-runs":
        options.suiteRuns = parsePositiveInt(readValue(argv, i++, arg), arg);
        break;
      case "--diagnostic-reruns":
        options.diagnosticReruns = parsePositiveInt(readValue(argv, i++, arg), arg);
        break;
      case "--validation-reruns":
        options.validationReruns = parsePositiveInt(readValue(argv, i++, arg), arg);
        break;
      case "--max-candidates":
        options.maxCandidates = parsePositiveInt(readValue(argv, i++, arg), arg);
        break;
      case "--workers":
        options.workers = parsePositiveInt(readValue(argv, i++, arg), arg);
        break;
      case "--base-url":
        options.baseUrl = readValue(argv, i++, arg);
        break;
      case "--model":
        options.model = readValue(argv, i++, arg);
        break;
      case "--report-dir":
        options.reportDir = readValue(argv, i++, arg);
        break;
      case "--project":
        options.projects.push(readValue(argv, i++, arg));
        break;
      case "--grep":
        options.grep = readValue(argv, i++, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-repair":
        options.skipRepair = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Flaky E2E triage agent

Runs the complete Playwright E2E suite repeatedly, diagnoses flaky tests,
diffs visual image artifacts when available, and hands the evidence to a
local Cursor SDK agent to repair the system under test or the flaky test.

Usage:
  npm run triage:flaky-e2e -- [options]

Options:
  --suite-runs <n>          Complete suite runs before repair (default: 3)
  --diagnostic-reruns <n>   Targeted reruns per candidate (default: 8)
  --validation-reruns <n>   Targeted reruns after repair (default: 5)
  --max-candidates <n>      Candidate tests sent to the agent (default: 10)
  --workers <n>             Override Playwright workers
  --base-url <url>          BASE_URL for Playwright
  --project <name>          Repeatable Playwright project filter
  --grep <pattern>          Optional Playwright grep filter
  --model <id>              Cursor model (default: composer-2.5)
  --report-dir <path>       Triage artifact directory
  --dry-run                 Collect evidence and write the repair prompt only
  --skip-repair             Collect evidence without invoking Cursor
`);
}

function parsePositiveInt(value: string, flag: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runPlaywright(
  label: string,
  options: CliOptions,
  extraArgs: string[],
  runDir: string
): Promise<PlaywrightRun> {
  await mkdir(runDir, { recursive: true });
  const jsonPath = path.join(runDir, "playwright-report.json");
  const configPath = path.join(runDir, "playwright.triage.config.ts");
  await writeFile(configPath, buildPlaywrightConfig(jsonPath, path.join(runDir, "playwright-html-report")));

  const args = [
    "playwright",
    "test",
    "--config",
    configPath,
    "--retries=0",
    "--output",
    path.join(runDir, "test-results")
  ];
  if (options.workers) {
    args.push("--workers", String(options.workers));
  }
  for (const project of options.projects) {
    args.push("--project", project);
  }
  if (options.grep) {
    args.push("--grep", options.grep);
  }
  args.push(...extraArgs);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ARGOS_TOKEN: process.env.ARGOS_TOKEN ?? "",
    PW_TEST_HTML_REPORT_OPEN: "never"
  };
  if (options.baseUrl) {
    env.BASE_URL = options.baseUrl;
  }

  const command = `npx ${args.map(shellQuote).join(" ")}`;
  console.log(`\n[${label}] ${command}`);
  const child = spawn("npx", args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  const rawLogPath = path.join(runDir, "playwright.raw.log");
  await writeFile(rawLogPath, stdout + stderr);

  const parsed: { report?: PlaywrightReport; error?: string } = existsSync(jsonPath)
    ? { report: JSON.parse(await readFile(jsonPath, "utf8")) as PlaywrightReport }
    : parsePlaywrightJson(stdout);
  if (!parsed.report) {
    return {
      label,
      exitCode,
      command,
      rawLogPath,
      observations: [],
      parseError: parsed.error,
      reportErrors: parsed.error ? [parsed.error] : []
    };
  }

  const observations = await flattenReport(parsed.report, runDir);

  return {
    label,
    exitCode,
    command,
    rawLogPath,
    jsonPath,
    observations,
    reportErrors: collectReportErrors(parsed.report)
  };
}

function buildPlaywrightConfig(jsonPath: string, htmlReportPath: string) {
  const argosReporter = requireFromWorkspace.resolve("@argos-ci/playwright/reporter");
  return `import baseConfig from ${JSON.stringify(path.resolve("playwright.config.ts"))};

export default {
  ...baseConfig,
  testDir: ${JSON.stringify(path.resolve("tests/e2e"))},
  reporter: [
    ["line"],
    ["json", { outputFile: ${JSON.stringify(path.resolve(jsonPath))} }],
    [${JSON.stringify(argosReporter)}, { uploadToArgos: false, token: "" }],
    ["html", { outputFolder: ${JSON.stringify(path.resolve(htmlReportPath))}, open: "never" }]
  ]
};
`;
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parsePlaywrightJson(output: string): { report?: PlaywrightReport; error?: string } {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { error: "Playwright JSON reporter did not emit a JSON object" };
  }
  try {
    return { report: JSON.parse(output.slice(start, end + 1)) as PlaywrightReport };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function flattenReport(report: PlaywrightReport, runDir: string): Promise<TestObservation[]> {
  const observations: TestObservation[] = [];

  const visitSuite = async (suite: PlaywrightSuite, parentTitles: string[]) => {
    const suiteTitles = suite.title ? [...parentTitles, suite.title] : parentTitles;
    for (const childSuite of suite.suites ?? []) {
      await visitSuite(childSuite, suiteTitles);
    }
    for (const spec of suite.specs ?? []) {
      const titlePath = [...suiteTitles, spec.title].filter(Boolean);
      for (const testCase of spec.tests ?? []) {
        const resultStatuses = testCase.results?.map((result) => result.status ?? "unknown") ?? [];
        const failedResults = testCase.results?.filter((result) => isFailureStatus(result.status)) ?? [];
        const status = statusFromTest(testCase, resultStatuses);
        const file = spec.file ?? suite.file ?? "unknown";
        const line = spec.line ?? suite.line;
        const projectName = testCase.projectName;
        const errors = collectErrors(failedResults.length > 0 ? failedResults : (testCase.results ?? []));
        const attachments = await collectAttachments(testCase.results ?? [], runDir);
        const title = titlePath.join(" › ");
        observations.push({
          key: buildTestKey(file, line, title, projectName),
          file,
          line,
          title,
          projectName,
          status,
          durationMs: (testCase.results ?? []).reduce((sum, result) => sum + (result.duration ?? 0), 0),
          errors,
          attachments
        });
      }
    }
  };

  for (const suite of report.suites ?? []) {
    await visitSuite(suite, []);
  }

  return observations;
}

function statusFromTest(testCase: PlaywrightTest, resultStatuses: string[]): TestObservation["status"] {
  if (testCase.status === "skipped" || resultStatuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (testCase.status === "expected" || resultStatuses.some((status) => status === "passed")) {
    return "passed";
  }
  return "failed";
}

function isFailureStatus(status: string | undefined) {
  return status === "failed" || status === "timedOut" || status === "interrupted";
}

function collectErrors(results: PlaywrightResult[]) {
  const messages: string[] = [];
  for (const result of results) {
    for (const error of [result.error, ...(result.errors ?? [])]) {
      const text = [error?.message, error?.value, error?.stack].filter(Boolean).join("\n");
      if (text) messages.push(text);
    }
    messages.push(...collectOutput(result.stderr));
  }
  return Array.from(new Set(messages)).slice(0, 6);
}

function collectReportErrors(report: PlaywrightReport) {
  return (report.errors ?? [])
    .map((error) => [error.message, error.value, error.stack].filter(Boolean).join("\n"))
    .filter(Boolean);
}

function collectOutput(output: PlaywrightOutput[] | undefined) {
  return (output ?? [])
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry.text) return entry.text;
      if (entry.buffer) return Buffer.from(entry.buffer, "base64").toString();
      return "";
    })
    .filter(Boolean);
}

async function collectAttachments(results: PlaywrightResult[], runDir: string): Promise<AttachmentEvidence[]> {
  const attachments: AttachmentEvidence[] = [];
  const attachmentDir = path.join(runDir, "attachments");
  for (const result of results) {
    for (const attachment of result.attachments ?? []) {
      if (!attachment.path) continue;
      const originalPath = path.resolve(attachment.path);
      const evidence: AttachmentEvidence = {
        name: attachment.name,
        originalPath,
        contentType: attachment.contentType
      };
      if (existsSync(originalPath)) {
        await mkdir(attachmentDir, { recursive: true });
        const extension = path.extname(originalPath);
        const copiedPath = path.join(
          attachmentDir,
          `${sanitizeFileName(attachment.name)}-${attachments.length}${extension}`
        );
        const bytes = await readFile(originalPath);
        await writeFile(copiedPath, bytes);
        evidence.copiedPath = copiedPath;
        evidence.sha256 = createHash("sha256").update(bytes).digest("hex");
      }
      attachments.push(evidence);
    }
  }
  return attachments;
}

function sanitizeFileName(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
}

function buildTestKey(file: string, line: number | undefined, title: string, projectName: string | undefined) {
  const location = line ? `${file}:${line}` : file;
  return [projectName, location, title].filter(Boolean).join(" › ");
}

function groupObservations(runs: PlaywrightRun[]) {
  const grouped = new Map<string, TestObservation[]>();
  for (const run of runs) {
    for (const observation of run.observations) {
      const current = grouped.get(observation.key) ?? [];
      current.push(observation);
      grouped.set(observation.key, current);
    }
  }
  return grouped;
}

async function identifyCandidates(suiteRuns: PlaywrightRun[], diagnosticRuns: PlaywrightRun[]): Promise<Candidate[]> {
  const suiteGrouped = groupObservations(suiteRuns);
  const diagnosticGrouped = groupObservations(diagnosticRuns);
  const keys = new Set<string>();
  for (const [key, observations] of suiteGrouped.entries()) {
    if (observations.some((observation) => observation.status === "failed")) {
      keys.add(key);
    }
  }
  for (const [key, observations] of diagnosticGrouped.entries()) {
    if (observations.some((observation) => observation.status === "failed")) {
      keys.add(key);
    }
  }

  const candidates: Candidate[] = [];
  for (const key of keys) {
    const suiteObservations = suiteGrouped.get(key) ?? [];
    const diagnosticObservations = diagnosticGrouped.get(key) ?? [];
    const allObservations = [...suiteObservations, ...diagnosticObservations];
    if (allObservations.length === 0) continue;
    const statuses = allObservations.map((observation) => observation.status);
    const classification = statuses.includes("passed") && statuses.includes("failed") ? "flaky" : "stable-failure";
    const first = allObservations[0];
    candidates.push({
      key,
      file: first.file,
      line: first.line,
      title: first.title,
      projectName: first.projectName,
      suiteStatuses: suiteObservations.map((observation) => observation.status),
      diagnosticStatuses: diagnosticObservations.map((observation) => observation.status),
      classification,
      visual: await collectVisualEvidence(allObservations),
      sampleErrors: Array.from(new Set(allObservations.flatMap((observation) => observation.errors))).slice(0, 5)
    });
  }

  return candidates.sort((a, b) => {
    if (a.classification !== b.classification) return a.classification === "flaky" ? -1 : 1;
    if (a.visual.suspected !== b.visual.suspected) return a.visual.suspected ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

async function collectVisualEvidence(observations: TestObservation[]): Promise<VisualEvidence> {
  const allAttachments = observations.flatMap((observation) => observation.attachments);
  const imageAttachments = allAttachments.filter(isImageAttachment);
  const text = observations
    .flatMap((observation) => observation.errors)
    .join("\n")
    .toLowerCase();
  const textSuggestsVisual =
    text.includes("screenshot") || text.includes("snapshot") || text.includes("argos") || text.includes("pixel");
  const imageDiffs = await diffImageAttachments(imageAttachments);

  return {
    suspected: textSuggestsVisual || imageDiffs.length > 0,
    reason: textSuggestsVisual
      ? "Failure output mentions screenshot/snapshot/Argos/pixel comparison"
      : imageDiffs.length > 0
        ? "Image attachments with matching names differed across reruns"
        : undefined,
    imageDiffs,
    attachments: imageAttachments
  };
}

function isImageAttachment(attachment: AttachmentEvidence) {
  return Boolean(
    attachment.copiedPath &&
      (attachment.contentType?.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(attachment.copiedPath))
  );
}

async function diffImageAttachments(attachments: AttachmentEvidence[]): Promise<ImageDiff[]> {
  const byName = new Map<string, AttachmentEvidence[]>();
  for (const attachment of attachments) {
    const current = byName.get(attachment.name) ?? [];
    current.push(attachment);
    byName.set(attachment.name, current);
  }

  const diffs: ImageDiff[] = [];
  for (const [name, namedAttachments] of byName.entries()) {
    const unique = uniqueBy(namedAttachments, (attachment) => attachment.sha256 ?? attachment.copiedPath ?? "");
    if (unique.length < 2) continue;
    for (let i = 1; i < unique.length; i++) {
      const first = unique[0].copiedPath;
      const second = unique[i].copiedPath;
      if (!first || !second) continue;
      diffs.push(await diffImages(name, first, second));
      if (diffs.length >= 8) return diffs;
    }
  }
  return diffs;
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function diffImages(attachmentName: string, firstImage: string, secondImage: string): Promise<ImageDiff> {
  try {
    const first = await sharp(firstImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const second = await sharp(secondImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (first.info.width !== second.info.width || first.info.height !== second.info.height) {
      return {
        attachmentName,
        firstImage,
        secondImage,
        width: first.info.width,
        height: first.info.height,
        note: `dimension mismatch: ${first.info.width}x${first.info.height} vs ${second.info.width}x${second.info.height}`
      };
    }

    let differingPixels = 0;
    const channels = first.info.channels;
    for (let offset = 0; offset < first.data.length; offset += channels) {
      let pixelDiffers = false;
      for (let channel = 0; channel < channels; channel++) {
        if (first.data[offset + channel] !== second.data[offset + channel]) {
          pixelDiffers = true;
          break;
        }
      }
      if (pixelDiffers) differingPixels++;
    }
    const totalPixels = first.info.width * first.info.height;
    return {
      attachmentName,
      firstImage,
      secondImage,
      width: first.info.width,
      height: first.info.height,
      differingPixels,
      diffRatio: totalPixels === 0 ? 0 : differingPixels / totalPixels
    };
  } catch (error) {
    return {
      attachmentName,
      firstImage,
      secondImage,
      note: error instanceof Error ? error.message : String(error)
    };
  }
}

function diagnosticArgsFor(candidate: Pick<Candidate, "file" | "title" | "projectName">) {
  const args = [candidate.file, "--grep", regexpEscape(candidate.title.split(" › ").at(-1) ?? candidate.title)];
  if (candidate.projectName) {
    args.push("--project", candidate.projectName);
  }
  return args;
}

function regexpEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeSummary(
  options: CliOptions,
  suiteRuns: PlaywrightRun[],
  diagnosticRuns: PlaywrightRun[],
  candidates: Candidate[]
) {
  await mkdir(options.reportDir, { recursive: true });
  const summaryPath = path.join(options.reportDir, "summary.json");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        options,
        suiteRuns: suiteRuns.map(summarizeRun),
        diagnosticRuns: diagnosticRuns.map(summarizeRun),
        candidates
      },
      null,
      2
    )
  );
  return summaryPath;
}

function summarizeRun(run: PlaywrightRun) {
  return {
    label: run.label,
    exitCode: run.exitCode,
    command: run.command,
    rawLogPath: run.rawLogPath,
    jsonPath: run.jsonPath,
    parseError: run.parseError,
    reportErrors: run.reportErrors.slice(0, 5),
    totals: {
      passed: run.observations.filter((observation) => observation.status === "passed").length,
      failed: run.observations.filter((observation) => observation.status === "failed").length,
      skipped: run.observations.filter((observation) => observation.status === "skipped").length
    }
  };
}

function buildRepairPrompt(summaryPath: string, candidates: Candidate[], options: CliOptions) {
  const visualGuidance = `
Visual flake repair rules:
- Prefer fixing nondeterminism in the system under test: deterministic ordering, stable clocks, race-free loading, deterministic data, and explicit readiness waits.
- If the only volatile piece is an intentionally variable value in a screenshot, follow the existing pattern: add data-visual-test="transparent" plus an appropriate data-visual-placeholder in the rendered component.
- Whenever masking a value for screenshots, add or preserve a Playwright assertion immediately before the visualScreenshot call that proves the real value is correct and visible. Do not mask without a behavioral assertion.
- Do not update screenshots or visual baselines merely to hide nondeterminism.
`;

  return `You are the Pawtograder flaky E2E triage agent.

Goal:
Root-cause and repair the flaky Playwright E2E tests found by this triage run. Fix the system under test when the app is nondeterministic or racy. Only repair the test when the app behavior is correct and the test is brittle.

Evidence:
- Triage summary JSON: ${summaryPath}
- Candidate tests:
${candidates
  .map((candidate, index) => {
    const visual = candidate.visual.suspected
      ? `visual suspected: ${candidate.visual.reason}; diffs=${candidate.visual.imageDiffs.length}`
      : "visual not suspected";
    return `${index + 1}. ${candidate.classification.toUpperCase()} ${candidate.key}
   suite statuses: ${candidate.suiteStatuses.join(", ") || "none"}
   diagnostic statuses: ${candidate.diagnosticStatuses.join(", ") || "none"}
   ${visual}
   sample errors: ${candidate.sampleErrors.map((message) => oneLine(message).slice(0, 350)).join(" | ") || "none"}`;
  })
  .join("\n")}

Run and repair policy:
- Read the JSON evidence and raw logs referenced from it.
- Inspect the failing tests and the app code they exercise.
- For each true flake, identify the root cause before editing.
- Prefer app fixes over weakening tests.
- After edits, run the targeted Playwright command(s) repeatedly. Use at least ${options.validationReruns} validation reruns for each repaired candidate, and run broader checks when the change could affect shared behavior.
- Leave a concise summary of root cause, repair, and validation output.
${visualGuidance}`;
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function runCursorRepairAgent(prompt: string, options: CliOptions) {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY is required unless --dry-run or --skip-repair is set");
  }

  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: {
      id: options.model,
      params: [{ id: "thinking", value: "high" }]
    },
    local: { cwd: process.cwd() }
  });

  try {
    const run = await agent.send(prompt);
    for await (const event of run.stream()) {
      printSdkEvent(event);
    }
    const result = await run.wait();
    if (result.status !== "finished") {
      throw new Error(`Cursor repair agent ended with status ${result.status}`);
    }
  } finally {
    await agent[Symbol.asyncDispose]?.();
  }
}

function printSdkEvent(event: SDKMessage) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  } else if (event.type === "tool_call") {
    const status = event.status === "completed" ? "done" : event.status;
    console.log(`\n[cursor:${status}] ${event.name}`);
  } else if (event.type === "status" && event.message) {
    console.log(`\n[cursor:${event.status}] ${event.message}`);
  } else if (event.type === "task" && event.text) {
    console.log(`\n[cursor:task] ${event.text}`);
  }
}

async function runValidation(options: CliOptions, candidates: Candidate[]) {
  const validationRuns: PlaywrightRun[] = [];
  for (const candidate of candidates) {
    for (let i = 0; i < options.validationReruns; i++) {
      validationRuns.push(
        await runPlaywright(
          `validation-${sanitizeFileName(candidate.key)}-${i + 1}`,
          options,
          diagnosticArgsFor(candidate),
          path.join(options.reportDir, "validation", sanitizeFileName(candidate.key), String(i + 1))
        )
      );
    }
  }
  const validationPath = path.join(options.reportDir, "validation-summary.json");
  await writeFile(
    validationPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runs: validationRuns.map(summarizeRun)
      },
      null,
      2
    )
  );
  return validationRuns;
}

async function listRunDirs(root: string) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root);
  const dirs: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    if ((await stat(entryPath)).isDirectory()) dirs.push(entryPath);
  }
  return dirs;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  await mkdir(options.reportDir, { recursive: true });
  const suiteRuns: PlaywrightRun[] = [];
  for (let i = 0; i < options.suiteRuns; i++) {
    suiteRuns.push(
      await runPlaywright(`suite-${i + 1}`, options, [], path.join(options.reportDir, "suite", String(i + 1)))
    );
  }

  const initialCandidates = await identifyCandidates(suiteRuns, []);
  const diagnosticRuns: PlaywrightRun[] = [];
  for (const candidate of initialCandidates.slice(0, options.maxCandidates)) {
    for (let i = 0; i < options.diagnosticReruns; i++) {
      diagnosticRuns.push(
        await runPlaywright(
          `diagnostic-${sanitizeFileName(candidate.key)}-${i + 1}`,
          options,
          diagnosticArgsFor(candidate),
          path.join(options.reportDir, "diagnostic", sanitizeFileName(candidate.key), String(i + 1))
        )
      );
    }
  }

  const candidates = (await identifyCandidates(suiteRuns, diagnosticRuns)).slice(0, options.maxCandidates);
  const summaryPath = await writeSummary(options, suiteRuns, diagnosticRuns, candidates);
  const prompt = buildRepairPrompt(summaryPath, candidates, options);
  const promptPath = path.join(options.reportDir, "cursor-repair-prompt.md");
  await writeFile(promptPath, prompt);

  console.log(`\nTriage summary: ${summaryPath}`);
  console.log(`Cursor repair prompt: ${promptPath}`);
  console.log(`Run directories: ${(await listRunDirs(options.reportDir)).join(", ")}`);
  const runnerFailures = [...suiteRuns, ...diagnosticRuns].filter(
    (run) => run.exitCode !== 0 && run.observations.length === 0
  );
  if (runnerFailures.length > 0) {
    throw new Error(
      `Playwright failed before reporting test observations; see ${runnerFailures
        .map((run) => run.rawLogPath)
        .join(", ")}`
    );
  }
  if (candidates.length === 0) {
    console.log("No failed or flaky tests were observed.");
    return;
  }

  if (options.dryRun || options.skipRepair) {
    console.log(options.dryRun ? "Dry run complete; Cursor repair agent was not invoked." : "Repair skipped.");
    return;
  }

  await runCursorRepairAgent(prompt, options);
  const validationRuns = await runValidation(options, candidates);
  const failedValidation = validationRuns.filter((run) => run.exitCode !== 0);
  if (failedValidation.length > 0) {
    throw new Error(`${failedValidation.length} validation run(s) still failed; see ${options.reportDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
