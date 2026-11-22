import { assertEquals } from "jsr:@std/assert@^1";
import { forgejoGradeWorkflow } from "./forgejoGradeWorkflow.ts";

Deno.test("forgejoGradeWorkflow: is the chart's example, pointed at the given grading server", async () => {
  const example = await Deno.readTextFile(
    new URL("../../../charts/pawtograder/examples/forgejo-grade.yml", import.meta.url)
  );
  assertEquals(forgejoGradeWorkflow("https://api.pawtograder.example.com"), example);
  assertEquals(
    forgejoGradeWorkflow("https://api.staging.pawtograder.net"),
    example.replace('"https://api.pawtograder.example.com"', '"https://api.staging.pawtograder.net"')
  );
});
