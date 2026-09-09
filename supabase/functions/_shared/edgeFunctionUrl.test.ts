/**
 * Getting this wrong is silent: every cross-function call 404s and nothing is ever created.
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { edgeFunctionEndpoint } from "./edgeFunctionUrl.ts";

Deno.test("edgeFunctionEndpoint: an origin that already carries the prefix is not doubled", () => {
  // Khoury prod's actual shape. Appending the prefix unconditionally would produce
  // /functions/v1/functions/v1/... and 404 on every repair.
  assertEquals(
    edgeFunctionEndpoint("https://api.example.edu/functions/v1", "assignment-create-solution-repo"),
    "https://api.example.edu/functions/v1/assignment-create-solution-repo"
  );
});

Deno.test("edgeFunctionEndpoint: a bare Kong origin gets the prefix added", () => {
  // What export-preview-agent-env.sh sets. Kong routes functions only below /functions/v1/.
  assertEquals(
    edgeFunctionEndpoint("https://api.example.edu", "assignment-create-solution-repo"),
    "https://api.example.edu/functions/v1/assignment-create-solution-repo"
  );
});

Deno.test("edgeFunctionEndpoint: trailing slashes are normalized in both shapes", () => {
  assertEquals(edgeFunctionEndpoint("https://api.example.edu/", "f"), "https://api.example.edu/functions/v1/f");
  assertEquals(
    edgeFunctionEndpoint("https://api.example.edu/functions/v1//", "f"),
    "https://api.example.edu/functions/v1/f"
  );
});
