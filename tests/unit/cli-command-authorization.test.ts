/**
 * @jest-environment node
 */

/**
 * Every CLI command must enforce per-class authorization.
 *
 * This is a static audit rather than a behavioral test, because the thing worth
 * preventing is an *omission*. Every CLI handler runs on the service-role client
 * (`getAdminClient()`), which bypasses RLS, so the explicit `user_roles` check is
 * the only thing standing between a grader in one course and another course's
 * data. A handler that forgets it works perfectly in every manual test — it just
 * also answers for classes the caller has nothing to do with.
 *
 * Twelve of the original twenty-four commands were missing it, including the
 * destructive `assignments.delete`, and `classes.list` returned every class on
 * the deployment. This test fails if a new command lands without a check, or if
 * an existing one loses it.
 *
 * The audit parses the command modules rather than importing them: importing a
 * command module pulls in the router, which pulls in MCPAuth and its
 * URL-imported Deno dependencies, which Jest cannot resolve.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMMANDS_DIR = join(__dirname, "../../supabase/functions/cli/commands");

/** Helpers that constitute an authorization check. */
const AUTHZ_CALLS = [
  "assertUserCanAccessClass",
  "assertUserIsClassInstructor",
  // classes.list has no single class to assert against, so it filters instead.
  "listAccessibleClassIds"
];

/**
 * Commands that legitimately have no class scope. Each needs a reason, and the
 * list should stay very short.
 */
const EXEMPT: Record<string, string> = {
  "token.info": "Reports on the caller's own token; touches no class-scoped data."
};

interface ParsedModule {
  file: string;
  source: string;
  /** function name -> body text */
  functions: Map<string, string>;
  /** command name -> handler function name */
  commands: Map<string, string>;
}

/**
 * Extracts top-level function bodies by brace matching from `function` /
 * `async function` declarations at column 0.
 */
function extractFunctions(source: string): Map<string, string> {
  const functions = new Map<string, string>();
  const declaration = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;

  for (const match of source.matchAll(declaration)) {
    const name = match[1];
    const start = source.indexOf("{", match.index! + match[0].length - 1);
    if (start === -1) continue;

    let depth = 0;
    let end = start;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    functions.set(name, source.slice(start, end + 1));
  }

  return functions;
}

/** Reads `registerCommand({ name: "...", ..., handler: fn })` blocks. */
function extractCommands(source: string): Map<string, string> {
  const commands = new Map<string, string>();
  const block = /registerCommand\(\{([\s\S]*?)\}\);/g;

  for (const match of source.matchAll(block)) {
    const body = match[1];
    const name = body.match(/name:\s*"([^"]+)"/)?.[1];
    const handler = body.match(/handler:\s*([A-Za-z0-9_$]+)/)?.[1];
    if (name && handler) commands.set(name, handler);
  }

  return commands;
}

function loadModules(): ParsedModule[] {
  return readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "base.ts")
    .map((file) => {
      const source = readFileSync(join(COMMANDS_DIR, file), "utf8");
      return {
        file,
        source,
        functions: extractFunctions(source),
        commands: extractCommands(source)
      };
    });
}

/**
 * Whether `fnName` performs an authorization check, following calls to other
 * functions defined in the same module. Several commands delegate to a shared
 * implementation (`handleCommentsImport` -> `handleCommentsPrepare`) or resolve
 * context through a helper (`handleAssignmentExport` ->
 * `resolveAssignmentExportContext`), so a direct-body-only check would produce
 * false failures.
 */
function checksAuthorization(mod: ParsedModule, fnName: string, seen = new Set<string>()): boolean {
  if (seen.has(fnName)) return false;
  seen.add(fnName);

  const body = mod.functions.get(fnName);
  if (!body) return false;

  if (AUTHZ_CALLS.some((call) => body.includes(call))) return true;

  for (const candidate of mod.functions.keys()) {
    if (candidate === fnName || seen.has(candidate)) continue;
    // Called somewhere in this body?
    if (new RegExp(`\\b${candidate}\\s*\\(`).test(body) && checksAuthorization(mod, candidate, seen)) {
      return true;
    }
  }

  return false;
}

const modules = loadModules();
const allCommands = modules.flatMap((mod) =>
  [...mod.commands.entries()].map(([name, handler]) => ({ mod, name, handler }))
);

describe("CLI command authorization audit", () => {
  it("finds the command modules and their registrations", () => {
    // Guards against the parser silently matching nothing, which would make
    // every assertion below vacuously pass.
    expect(modules.length).toBeGreaterThanOrEqual(10);
    expect(allCommands.length).toBeGreaterThanOrEqual(24);
  });

  it("resolves a handler body for every registered command", () => {
    const unresolved = allCommands.filter(({ mod, handler }) => !mod.functions.has(handler));
    expect(unresolved.map((c) => `${c.name} -> ${c.handler}`)).toEqual([]);
  });

  const enforced = allCommands.filter(({ name }) => !(name in EXEMPT));

  it.each(enforced.map(({ mod, name, handler }) => [name, mod, handler] as const))(
    "%s enforces per-class authorization",
    (name, mod, handler) => {
      expect(checksAuthorization(mod, handler)).toBe(true);
    }
  );

  it("keeps the exemption list documented and minimal", () => {
    for (const [command, reason] of Object.entries(EXEMPT)) {
      expect(allCommands.some((c) => c.name === command)).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(2);
  });

  it("checks both classes in every cross-class copy command", () => {
    // A single check would still let a grader in one class copy content into a
    // class they do not belong to.
    for (const commandName of ["assignments.copy", "flashcards.copy", "surveys.copy"]) {
      const entry = allCommands.find((c) => c.name === commandName);
      expect(entry).toBeDefined();
      const body = entry!.mod.functions.get(entry!.handler)!;
      const checks = body.match(/assertUserCanAccessClass|assertUserIsClassInstructor/g) ?? [];
      expect(checks.length).toBeGreaterThanOrEqual(2);
      expect(body).toMatch(/sourceClass\.id/);
      expect(body).toMatch(/targetClass\.id/);
    }
  });

  it("scopes classes.list to the caller's classes instead of asserting", () => {
    const entry = allCommands.find((c) => c.name === "classes.list")!;
    expect(entry.mod.functions.get(entry.handler)).toContain("listAccessibleClassIds");
  });
});
