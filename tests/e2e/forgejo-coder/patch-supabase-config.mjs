// Rewrites a copied supabase/config.toml so the lane's Supabase runs as its own
// project next to a developer's stack: its own project_id (container names),
// every host port shifted by SB_PORT_OFFSET, and site_url pointing at the
// lane's Next server, which is where GoTrue sends the browser for OAuth consent.
//
// usage: node patch-supabase-config.mjs <config.toml> <offset> <site_url>
import fs from "node:fs";

const [file, offsetArg, siteUrl] = process.argv.slice(2);
const offset = Number(offsetArg);
if (!file || !Number.isInteger(offset) || !siteUrl) {
  console.error("usage: patch-supabase-config.mjs <config.toml> <offset> <site_url>");
  process.exit(2);
}

let toml = fs.readFileSync(file, "utf8");
toml = toml.replace(/^project_id\s*=.*$/m, 'project_id = "pawtograder-sso-e2e"');
toml = toml.replace(
  /^(\s*(?:port|shadow_port|smtp_port|pop3_port|inspector_port)\s*=\s*)(\d+)/gm,
  (_, key, port) => `${key}${Number(port) + offset}`
);
toml = toml.replace(/^site_url\s*=.*$/m, `site_url = "${siteUrl}"`);
toml = toml.replace(/^additional_redirect_urls\s*=.*$/m, `additional_redirect_urls = ["${siteUrl}"]`);
fs.writeFileSync(file, toml);
