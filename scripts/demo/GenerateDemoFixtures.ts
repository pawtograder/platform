/* eslint-disable no-console */
/**
 * GenerateDemoFixtures — build-time, dev-only.
 *
 * Calls Claude to brainstorm realistic discussion threads, private posts,
 * help requests, and survey freeform answers for one or more course
 * archetypes. The output is written to scripts/demo/fixtures/<archetype>/
 * and committed to the repo so run-time provisioning never needs an API key.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx scripts/demo/GenerateDemoFixtures.ts \
 *       --archetype program-design-and-implementation-ii
 *
 * Defaults to all archetypes listed in scripts/demo/canned-repos.json.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import type {
  CannedArchetype,
  CannedRepoManifest,
  DiscussionThreadFixture,
  FixtureBundle,
  HelpRequestFixture,
  PrivatePostFixture
} from "./fixtures.types";

dotenv.config({ path: ".env.local", quiet: true });

const MODEL_NAME = "claude-sonnet-4-6";
const ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "demo", "canned-repos.json");
const FIXTURE_ROOT = path.join(ROOT, "scripts", "demo", "fixtures");

function loadManifest(): CannedRepoManifest {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  return JSON.parse(raw) as CannedRepoManifest;
}

function parseArgs(): { archetypes?: string[]; force: boolean } {
  const args = process.argv.slice(2);
  const out: { archetypes?: string[]; force: boolean } = { force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--archetype" && args[i + 1]) {
      out.archetypes = (out.archetypes ?? []).concat(args[++i]);
    } else if (args[i] === "--force" || args[i] === "-f") {
      out.force = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "Usage: ANTHROPIC_API_KEY=... npx tsx scripts/demo/GenerateDemoFixtures.ts " +
          "[--archetype program-design-and-implementation-ii] [--force]\n" +
          "  --force regenerates fixture files that already exist (default: skip)."
      );
      process.exit(0);
    }
  }
  return out;
}

function archetypeSystemPrompt(name: string, archetype: CannedArchetype): string {
  const slugList = archetype.assignments.map((a) => `${a.slug} (${a.title})`).join(", ");
  return [
    `You are helping seed a realistic-looking demo class for the Pawtograder course operations platform.`,
    `The course archetype is "${name}": ${archetype.courseTitle}.`,
    archetype.description ?? "",
    `It has these assignments: ${slugList}.`,
    `Generate believable, specific content — references to the actual stack (language, libraries, concepts) the course teaches, not generic placeholder text. Vary tone: confused first-years, confident know-it-alls, helpful peers, kind but firm instructors. No lorem ipsum.`,
    `Output ONLY valid JSON, no markdown fences, no commentary.`
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface ContentTypeSpec<T> {
  name: keyof FixtureBundle;
  prompt: string;
  validate: (parsed: unknown) => T;
}

const DISCUSSION_PROMPT = `Produce a JSON array of 40 discussion threads, each shaped like:
{
  "topic": "<one of the assignment slugs OR a general topic like 'Assignments' / 'Logistics' / 'Memes' / 'Office Hours' / 'Exam Prep' / 'Q&A' / 'Announcements'>",
  "subject": "...",
  "body": "<2-6 sentences, may include code-like snippets in plain text>",
  "isQuestion": true|false,
  "anonymous": true|false,
  "replies": [
    { "body": "...", "isInstructorReply": true|false, "anonymous": true|false, "isAnswer": true|false }
  ]
}

Distribute as follows:
- ~60% questions (isQuestion=true), ~40% announcements/discussions
- Mix anonymous and non-anonymous posts (~30% anonymous)
- Per thread: 0-5 replies. Roughly 30% of questions should have at least one reply marked isAnswer=true
- About 25% of replies should be from instructors
- Cover ALL the assignment slugs at least twice, plus a healthy mix of the general topics listed above
- Topics like "Memes" should have short, funny, in-jokes specific to the course's tech stack`;

const PRIVATE_POSTS_PROMPT = `Produce a JSON array of 8 instructor-only discussion threads (instructors_only=true). Each entry shaped like:
{
  "topic": "<one of the general topics, often 'Logistics' or 'Q&A'>",
  "subject": "...",
  "body": "<2-5 sentences>",
  "replies": [ { "body": "...", "fromRole": "instructor" | "grader" } ]
}

These are sensitive staff-only discussions: suspected academic integrity issues, accommodation requests, grading-policy debates, struggling-student check-ins, sharing rubric calibration notes, scheduling. Keep the language professional, specific to the course's content where possible. 1-4 replies per post.`;

const HELP_REQUESTS_PROMPT = `Produce a JSON array of 30 office-hours help requests, each shaped like:
{
  "assignmentSlug": "<one of the assignment slugs, or omit>",
  "isPrivate": true|false,
  "resolved": true|false,
  "durationMinutes": <integer 1-40, skewed toward shorter>,
  "request": "<the student's question, 1-4 sentences>",
  "replies": [
    { "message": "...", "isFromInstructor": true|false, "instructorsOnly": true|false }
  ]
}

Distribution:
- ~50% resolved, ~50% open
- ~30% private
- 0-8 replies per request; resolved ones tend to have more
- Reference real concepts from the course (e.g. specific Java collection methods, Python list comprehensions, React hook names) — not generic CS terms`;

const SURVEY_FREEFORM_PROMPT = `Produce a JSON array of 40 short open-ended survey responses (1-3 sentences each) suitable to plug into "What did you find most valuable about this course?" / "What concept was confusing?" / "Suggestions for improvement?" style questions. Vary tone (positive, frustrated, neutral). Reference specific course concepts. Return as a flat JSON array of strings.`;

// Minimal per-item shape guards so a malformed LLM generation fails fast here
// rather than partway through seeding. We only check the fields seeding relies
// on, not every optional property.
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function requireStringFields(item: unknown, fields: string[], label: string): void {
  if (!isRecord(item)) throw new Error(`${label}: expected object`);
  for (const f of fields) {
    if (typeof item[f] !== "string") throw new Error(`${label}: missing/invalid string field "${f}"`);
  }
}

function requireArrayField(item: Record<string, unknown>, field: string, label: string): void {
  if (!Array.isArray(item[field])) throw new Error(`${label}: missing/invalid array field "${field}"`);
}

function buildSpecs(): ContentTypeSpec<unknown>[] {
  return [
    {
      name: "discussions",
      prompt: DISCUSSION_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("discussions: expected array");
        parsed.forEach((item, i) => {
          requireStringFields(item, ["topic", "subject", "body"], `discussions[${i}]`);
          requireArrayField(item as Record<string, unknown>, "replies", `discussions[${i}]`);
        });
        return parsed as DiscussionThreadFixture[];
      }
    },
    {
      name: "privatePosts",
      prompt: PRIVATE_POSTS_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("privatePosts: expected array");
        parsed.forEach((item, i) => {
          requireStringFields(item, ["topic", "subject", "body"], `privatePosts[${i}]`);
          requireArrayField(item as Record<string, unknown>, "replies", `privatePosts[${i}]`);
        });
        return parsed as PrivatePostFixture[];
      }
    },
    {
      name: "helpRequests",
      prompt: HELP_REQUESTS_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("helpRequests: expected array");
        parsed.forEach((item, i) => {
          requireStringFields(item, ["request"], `helpRequests[${i}]`);
          requireArrayField(item as Record<string, unknown>, "replies", `helpRequests[${i}]`);
        });
        return parsed as HelpRequestFixture[];
      }
    },
    {
      name: "surveyFreeform",
      prompt: SURVEY_FREEFORM_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("surveyFreeform: expected array");
        parsed.forEach((item, i) => {
          if (typeof item !== "string") throw new Error(`surveyFreeform[${i}]: expected string`);
        });
        return parsed as string[];
      }
    }
  ];
}

async function generateForArchetype(name: string, archetype: CannedArchetype, force: boolean): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set");
  }

  const llm = new ChatAnthropic({
    model: MODEL_NAME,
    temperature: 0.85,
    // help_requests is the biggest payload — ~50 requests × multi-paragraph
    // replies routinely runs past 30KB. Sonnet 4.6 supports up to 64K output
    // tokens, so give it the headroom rather than truncating mid-string.
    maxTokens: 32768,
    // The Anthropic SDK refuses non-streaming requests whose expected runtime
    // exceeds 10 minutes (it computes this from maxTokens × per-model rate). At
    // 32K tokens we're past that line, so use streaming — langchain's .invoke
    // still returns the aggregated message but issues a streamed request.
    streaming: true,
    clientOptions: {
      defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" }
    }
  });
  // @langchain/anthropic 0.3.26 defaults topP and topK to -1 and forwards them
  // verbatim to the API. Newer Claude models reject -1 ("top_p cannot be set to
  // -1"). Clear the sentinel so the request omits both fields.
  (llm as unknown as { topP?: number; topK?: number }).topP = undefined;
  (llm as unknown as { topP?: number; topK?: number }).topK = undefined;

  const systemPrompt = archetypeSystemPrompt(name, archetype);
  const outDir = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(outDir, { recursive: true });

  const specs = buildSpecs();
  // Run all four content-type calls in parallel — they share the cached system block.
  await Promise.all(
    specs.map(async (spec) => {
      const outPath = path.join(outDir, `${spec.name}.json`);
      if (!force && fs.existsSync(outPath)) {
        console.log(`[${name}] ${spec.name}: already exists, skipping (use --force to regenerate)`);
        return;
      }
      console.log(`[${name}] generating ${spec.name}…`);
      const response = await llm.invoke([
        {
          role: "system",
          content: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }] as unknown as string
        },
        { role: "user", content: spec.prompt }
      ]);

      const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      const stripped = text
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/```\s*$/m, "")
        .trim();
      const stopReason = (response.response_metadata as { stop_reason?: string } | undefined)?.stop_reason;
      if (stopReason === "max_tokens") {
        throw new Error(
          `[${name}] ${spec.name}: model hit max_tokens (${stripped.length} chars produced). ` +
            `Bump maxTokens in GenerateDemoFixtures.ts and re-run.`
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch (e) {
        const preview = stripped.slice(0, 400);
        throw new Error(`[${name}] ${spec.name}: invalid JSON returned by model. Preview:\n${preview}\n---\n${e}`);
      }
      const validated = spec.validate(parsed);
      fs.writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n");
      console.log(`[${name}] wrote ${outPath}`);
    })
  );
}

async function main() {
  const argv = parseArgs();
  const manifest = loadManifest();
  // Skip underscore-prefixed archetypes by default — they're disabled placeholders.
  const archetypeNames = argv.archetypes ?? Object.keys(manifest).filter((k) => !k.startsWith("_"));
  for (const name of archetypeNames) {
    const archetype = manifest[name];
    if (!archetype) {
      throw new Error(`Unknown archetype '${name}' — must be one of: ${Object.keys(manifest).join(", ")}`);
    }
    await generateForArchetype(name, archetype, argv.force);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
