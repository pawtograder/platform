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

Deno.test("edgeFunctionEndpoint: a direct edge-runtime service URL is left unprefixed", () => {
  // export-preview-agent-env.sh in-cluster form. This bypasses Kong entirely and serves /<function>
  // at the service port, so adding the prefix would 404 every repair in that environment.
  assertEquals(
    edgeFunctionEndpoint("http://pawtograder-functions.pawtograder-preview-pr-1.svc.cluster.local:9000", "f"),
    "http://pawtograder-functions.pawtograder-preview-pr-1.svc.cluster.local:9000/f"
  );
});

Deno.test("edgeFunctionEndpoint: an in-cluster Kong origin still gets the prefix", () => {
  // Same scheme and shape as the direct form above, different service port — which is the only
  // thing that structurally separates them.
  assertEquals(
    edgeFunctionEndpoint("http://pawtograder-kong.ns.svc.cluster.local:8000", "f"),
    "http://pawtograder-kong.ns.svc.cluster.local:8000/functions/v1/f"
  );
});

Deno.test("edgeFunctionEndpoint: an explicit non-root path is taken at its word", () => {
  assertEquals(edgeFunctionEndpoint("https://api.example.edu/edge", "f"), "https://api.example.edu/edge/f");
});
