// Storage byte copy: managed -> self-hosted, via the Storage API.
// Invoked by 30-sync-storage.sh with creds in the environment. Reads the
// (bucket_id,name) CSV produced in step 1, downloads each object from the
// managed project with the service-role key, and re-uploads it to the
// self-hosted instance at the identical bucket/path (upsert).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const {
  MANAGED_API_URL,
  MANAGED_SERVICE_ROLE_KEY,
  SELF_API_URL,
  SELF_SERVICE_ROLE_KEY,
  CSV,
  CONCURRENCY = "8"
} = process.env;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const src = createClient(MANAGED_API_URL, MANAGED_SERVICE_ROLE_KEY, opts);
const dst = createClient(SELF_API_URL, SELF_SERVICE_ROLE_KEY, opts);

// Minimal CSV parse: two columns, header row, no embedded commas expected in
// bucket_id; object names never contain unescaped newlines in Supabase storage.
const rows = readFileSync(CSV, "utf8")
  .split("\n")
  .slice(1)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const i = l.indexOf(",");
    return { bucket: l.slice(0, i), name: l.slice(i + 1).replace(/^"(.*)"$/, "$1") };
  });

let ok = 0;
let done = 0;
const failures = [];

async function copyOne({ bucket, name }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await src.storage.from(bucket).download(name);
    if (error) {
      if (attempt === 3) return failures.push({ bucket, name, stage: "download", error: error.message });
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    const up = await dst.storage
      .from(bucket)
      .upload(name, data, { upsert: true, contentType: data.type || "application/octet-stream" });
    if (up.error) {
      if (attempt === 3) return failures.push({ bucket, name, stage: "upload", error: up.error.message });
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    ok++;
    return;
  }
}

async function worker(iter) {
  for (const row of iter) {
    await copyOne(row);
    if (++done % 100 === 0) console.log(`   ${done}/${rows.length} (${ok} ok, ${failures.length} failed)`);
  }
}

const it = rows[Symbol.iterator]();
await Promise.all(Array.from({ length: Number(CONCURRENCY) }, () => worker(it)));

console.log(`\nDone: ${ok}/${rows.length} copied, ${failures.length} failed.`);
if (failures.length) {
  console.error("Failures (first 25):");
  for (const f of failures.slice(0, 25)) console.error(`  [${f.stage}] ${f.bucket}/${f.name} — ${f.error}`);
  process.exit(1);
}
