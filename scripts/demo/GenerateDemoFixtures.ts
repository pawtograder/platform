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
 *       --archetype intro-cs-java
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

function parseArgs(): { archetypes?: string[] } {
  const args = process.argv.slice(2);
  const out: { archetypes?: string[] } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--archetype" && args[i + 1]) {
      out.archetypes = (out.archetypes ?? []).concat(args[++i]);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        "Usage: ANTHROPIC_API_KEY=... npx tsx scripts/demo/GenerateDemoFixtures.ts [--archetype intro-cs-java]..."
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

function buildSpecs(): ContentTypeSpec<unknown>[] {
  return [
    {
      name: "discussions",
      prompt: DISCUSSION_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("discussions: expected array");
        return parsed as DiscussionThreadFixture[];
      }
    },
    {
      name: "privatePosts",
      prompt: PRIVATE_POSTS_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("privatePosts: expected array");
        return parsed as PrivatePostFixture[];
      }
    },
    {
      name: "helpRequests",
      prompt: HELP_REQUESTS_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("helpRequests: expected array");
        return parsed as HelpRequestFixture[];
      }
    },
    {
      name: "surveyFreeform",
      prompt: SURVEY_FREEFORM_PROMPT,
      validate: (parsed) => {
        if (!Array.isArray(parsed)) throw new Error("surveyFreeform: expected array");
        return parsed as string[];
      }
    }
  ];
}

async function generateForArchetype(name: string, archetype: CannedArchetype): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY must be set");
  }

  const llm = new ChatAnthropic({
    model: MODEL_NAME,
    temperature: 0.85,
    maxTokens: 8192,
    clientOptions: {
      defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" }
    }
  });

  const systemPrompt = archetypeSystemPrompt(name, archetype);
  const outDir = path.join(FIXTURE_ROOT, name);
  fs.mkdirSync(outDir, { recursive: true });

  const specs = buildSpecs();
  // Run all four content-type calls in parallel — they share the cached system block.
  await Promise.all(
    specs.map(async (spec) => {
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripped);
      } catch (e) {
        const preview = stripped.slice(0, 400);
        throw new Error(`[${name}] ${spec.name}: invalid JSON returned by model. Preview:\n${preview}\n---\n${e}`);
      }
      const validated = spec.validate(parsed);
      const outPath = path.join(outDir, `${spec.name}.json`);
      fs.writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n");
      console.log(`[${name}] wrote ${outPath}`);
    })
  );
}

async function main() {
  const argv = parseArgs();
  const manifest = loadManifest();
  const archetypeNames = argv.archetypes ?? Object.keys(manifest);
  for (const name of archetypeNames) {
    const archetype = manifest[name];
    if (!archetype) {
      throw new Error(`Unknown archetype '${name}' — must be one of: ${Object.keys(manifest).join(", ")}`);
    }
    await generateForArchetype(name, archetype);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
