/**
 * Spike S4 (THROWAWAY): does `claude -p --json-schema` reliably deliver a
 * property that is an ARRAY OF OBJECTS? (Wave-2 live runs lost `barriers`
 * five times in a row with "must have required property 'barriers'".)
 */
import { execFileSync } from "node:child_process";

const schema = {
  type: "object",
  properties: {
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    barriers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          severity: { type: "string", enum: ["1", "2", "3"] },
          refs: { type: "array", items: { type: "string" } }
        },
        required: ["summary", "severity", "refs"],
        additionalProperties: false
      }
    }
  },
  required: ["title", "tags", "barriers"],
  additionalProperties: false
};

const prompt =
  "Produce structured output describing a fictional accessibility test: title 'demo', tags ['a','b'], and exactly two barriers (summary/severity/refs of your choice, refs like ['3','7']). No preamble.";

const out = execFileSync(
  "claude",
  [
    "-p",
    "--model",
    "claude-opus-4-8",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--max-turns",
    "3",
    "--strict-mcp-config"
  ],
  { input: prompt, encoding: "utf-8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }
);
const envelope = JSON.parse(out);
console.log("subtype:", envelope.subtype, "| is_error:", envelope.is_error);
console.log("structured_output:", JSON.stringify(envelope.structured_output));
