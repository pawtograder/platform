/**
 * Unit test for the unified submission ingestion core (SubmissionIngestion.ts).
 *
 * Builds a small in-memory zip (one text file + one binary file, both under a
 * top-level dir like a GitHub zipball) and runs `ingestSubmissionFilesFromZip`
 * against a thin in-memory fake of the admin Supabase client. Asserts:
 *   - the text file is written inline to submission_files.contents,
 *   - the binary file is uploaded to the submission-files storage bucket at the
 *     expected submission-scoped key, and its submission_files row references it,
 *   - the combined empty-hash matches an independent recomputation,
 *   - the fileFilter restricts ingestion,
 *   - empty detection flips isEmpty when the handout-hash table matches.
 *
 * Run from supabase/functions:  deno test _shared/SubmissionIngestion.test.ts
 * (it pulls npm:jszip + npm:unzipper from the global deno cache; no DB needed).
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import JSZip from "npm:jszip@3.10.1";

// SubmissionIngestion.ts imports cloneRepository from GitHubWrapper.ts, which
// constructs an Octokit App at module load and requires a non-empty private key.
// This unit test never calls cloneRepository (it exercises the zip path only),
// but the import still triggers that ctor — so we provide a throwaway, runtime-
// generated RSA key BEFORE the module is imported, then dynamic-import the
// function under test. (Mirrors the dummy-RSA-key approach the e2e harness uses.)
async function generateDummyPkcs8Pem(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
Deno.env.set("GITHUB_PRIVATE_KEY_STRING", await generateDummyPkcs8Pem());
Deno.env.set("GITHUB_APP_ID", "1");

const { ingestSubmissionFilesFromZip } = await import("./SubmissionIngestion.ts");

// ---- helpers -------------------------------------------------------------

function sha256Hex(buf: Uint8Array): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

function combinedHash(fileHashes: Record<string, string>): string {
  const input = Object.keys(fileHashes)
    .sort()
    .map((n) => `${n}\0${fileHashes[n]}\n`)
    .join("");
  return sha256Hex(Buffer.from(input, "utf-8"));
}

type InsertedFileRow = {
  submission_id: number;
  name: string;
  profile_id: string | null;
  assignment_group_id: number | null;
  contents: string | null;
  class_id: number;
  is_binary: boolean;
  file_size: number;
  mime_type?: string;
  storage_key?: string;
};

type StorageUpload = { key: string; size: number; contentType?: string };

/**
 * Minimal fake of the admin Supabase client covering exactly the surface
 * SubmissionIngestion uses: submission_files insert, assignment_handout_file_hashes
 * select chain, and storage upload/remove.
 */
function makeFakeSupabase(opts: { handoutHashesByAssignment?: Map<number, Set<string>> } = {}) {
  const insertedFiles: InsertedFileRow[] = [];
  const storageUploads: StorageUpload[] = [];
  const handoutHashesByAssignment = opts.handoutHashesByAssignment ?? new Map<number, Set<string>>();

  const handoutQuery = {
    _assignmentId: undefined as number | undefined,
    _combinedHash: undefined as string | undefined,
    eq(col: string, val: unknown) {
      if (col === "assignment_id") this._assignmentId = val as number;
      if (col === "combined_hash") this._combinedHash = val as string;
      return this;
    },
    limit() {
      return this;
    },
    // deno-lint-ignore require-await
    async maybeSingle() {
      // Honor BOTH assignment_id and combined_hash: a hash recorded under one assignment must
      // not satisfy a lookup scoped to a different assignment. This catches a regression where
      // ingestSubmissionFilesFromZip queries the handout hashes under the wrong assignment.
      const hashes = this._assignmentId !== undefined ? handoutHashesByAssignment.get(this._assignmentId) : undefined;
      const match = this._combinedHash !== undefined && hashes !== undefined && hashes.has(this._combinedHash);
      // reset for any subsequent use
      this._assignmentId = undefined;
      this._combinedHash = undefined;
      return { data: match ? { id: 1 } : null, error: null };
    }
  };

  const client = {
    from(table: string) {
      if (table === "submission_files") {
        return {
          // deno-lint-ignore require-await
          async insert(row: InsertedFileRow) {
            insertedFiles.push(row);
            return { error: null };
          }
        };
      }
      if (table === "assignment_handout_file_hashes") {
        return {
          select() {
            return handoutQuery;
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from(bucket: string) {
        assertEquals(bucket, "submission-files");
        return {
          // deno-lint-ignore require-await
          async upload(key: string, contents: Buffer, options?: { contentType?: string }) {
            storageUploads.push({ key, size: contents.length, contentType: options?.contentType });
            return { error: null };
          },
          // deno-lint-ignore require-await
          async remove(_keys: string[]) {
            return { error: null };
          }
        };
      }
    }
  };

  return { client, insertedFiles, storageUploads };
}

async function buildZip(entries: Record<string, Uint8Array | string>, topDir = "repo-main"): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(entries)) {
    zip.file(`${topDir}/${path}`, contents);
  }
  const out = await zip.generateAsync({ type: "uint8array" });
  return Buffer.from(out);
}

// ---- tests ---------------------------------------------------------------

const TEXT_CONTENTS = "package com.example;\n\npublic class Main {}\n";
// A tiny valid-ish PNG header + bytes (content is opaque to the ingester; it's
// classified binary purely by the .png extension).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

Deno.test("ingestSubmissionFilesFromZip: text inline, binary→storage, combined hash", async () => {
  const zipBuffer = await buildZip({
    "src/Main.java": TEXT_CONTENTS,
    "assets/logo.png": PNG_BYTES
  });

  const { client, insertedFiles, storageUploads } = makeFakeSupabase();

  const result = await ingestSubmissionFilesFromZip({
    // deno-lint-ignore no-explicit-any
    adminSupabase: client as any,
    zipBuffer,
    submissionId: 42,
    classId: 7,
    profileId: "profile-abc",
    groupId: null,
    detectEmptyForAssignmentId: 99
  });

  // Two rows written: one text, one binary.
  assertEquals(insertedFiles.length, 2);

  const textRow = insertedFiles.find((r) => r.name === "src/Main.java");
  assert(textRow, "text row should exist");
  assertEquals(textRow!.is_binary, false);
  assertEquals(textRow!.contents, TEXT_CONTENTS);
  assertEquals(textRow!.storage_key, undefined);
  assertEquals(textRow!.submission_id, 42);
  assertEquals(textRow!.class_id, 7);
  assertEquals(textRow!.profile_id, "profile-abc");
  assertEquals(textRow!.file_size, Buffer.from(TEXT_CONTENTS, "utf-8").length);

  const binRow = insertedFiles.find((r) => r.name === "assets/logo.png");
  assert(binRow, "binary row should exist");
  assertEquals(binRow!.is_binary, true);
  assertEquals(binRow!.contents, null);
  assertEquals(binRow!.mime_type, "image/png");
  // Submission-scoped key shape that can_access_submission_storage_path authorizes.
  assertEquals(binRow!.storage_key, "classes/7/profiles/profile-abc/submissions/42/files/assets/logo.png");

  // The binary blob was uploaded to the bucket at the same key.
  assertEquals(storageUploads.length, 1);
  assertEquals(storageUploads[0].key, "classes/7/profiles/profile-abc/submissions/42/files/assets/logo.png");
  assertEquals(storageUploads[0].size, PNG_BYTES.length);
  assertEquals(storageUploads[0].contentType, "image/png");

  // Combined hash matches an independent recomputation over the two files.
  const expected = combinedHash({
    "src/Main.java": sha256Hex(Buffer.from(TEXT_CONTENTS, "utf-8")),
    "assets/logo.png": sha256Hex(Buffer.from(PNG_BYTES))
  });
  assertEquals(result.combinedHash, expected);

  // No handout hash recorded → not empty.
  assertEquals(result.isEmpty, false);
});

Deno.test("ingestSubmissionFilesFromZip: group submissions key on group id", async () => {
  const zipBuffer = await buildZip({ "a.png": PNG_BYTES });
  const { client, insertedFiles } = makeFakeSupabase();

  await ingestSubmissionFilesFromZip({
    // deno-lint-ignore no-explicit-any
    adminSupabase: client as any,
    zipBuffer,
    submissionId: 5,
    classId: 1,
    profileId: null,
    groupId: 88
  });

  assertEquals(insertedFiles.length, 1);
  assertEquals(insertedFiles[0].assignment_group_id, 88);
  assertEquals(insertedFiles[0].profile_id, null);
  // storageProfileKey falls back to the group id when profileId is null.
  assertEquals(insertedFiles[0].storage_key, "classes/1/profiles/88/submissions/5/files/a.png");
});

Deno.test("ingestSubmissionFilesFromZip: fileFilter restricts ingestion", async () => {
  const zipBuffer = await buildZip({
    "keep.java": "keep\n",
    "skip.txt": "skip\n"
  });
  const { client, insertedFiles } = makeFakeSupabase();

  const result = await ingestSubmissionFilesFromZip({
    // deno-lint-ignore no-explicit-any
    adminSupabase: client as any,
    zipBuffer,
    submissionId: 1,
    classId: 1,
    profileId: "p",
    groupId: null,
    fileFilter: (rel) => rel.endsWith(".java")
  });

  assertEquals(insertedFiles.length, 1);
  assertEquals(insertedFiles[0].name, "keep.java");
  // No detectEmptyForAssignmentId → isEmpty is null, but combinedHash still computed.
  assertEquals(result.isEmpty, null);
  assertEquals(result.combinedHash, combinedHash({ "keep.java": sha256Hex(Buffer.from("keep\n", "utf-8")) }));
});

Deno.test("ingestSubmissionFilesFromZip: empty detection flips when handout hash matches", async () => {
  const zipBuffer = await buildZip({ "Main.java": TEXT_CONTENTS });
  const matchingHash = combinedHash({ "Main.java": sha256Hex(Buffer.from(TEXT_CONTENTS, "utf-8")) });

  const { client } = makeFakeSupabase({ handoutHashesByAssignment: new Map([[123, new Set([matchingHash])]]) });

  const result = await ingestSubmissionFilesFromZip({
    // deno-lint-ignore no-explicit-any
    adminSupabase: client as any,
    zipBuffer,
    submissionId: 1,
    classId: 1,
    profileId: "p",
    groupId: null,
    detectEmptyForAssignmentId: 123
  });

  assertEquals(result.combinedHash, matchingHash);
  assertEquals(result.isEmpty, true);
});

Deno.test("ingestSubmissionFilesFromZip: empty detection ignores a hash recorded under a different assignment", async () => {
  const zipBuffer = await buildZip({ "Main.java": TEXT_CONTENTS });
  const matchingHash = combinedHash({ "Main.java": sha256Hex(Buffer.from(TEXT_CONTENTS, "utf-8")) });

  // The handout hash is recorded for assignment 999, but ingestion is scoped to assignment 123,
  // so it must NOT be treated as empty — the lookup is assignment-scoped.
  const { client } = makeFakeSupabase({ handoutHashesByAssignment: new Map([[999, new Set([matchingHash])]]) });

  const result = await ingestSubmissionFilesFromZip({
    // deno-lint-ignore no-explicit-any
    adminSupabase: client as any,
    zipBuffer,
    submissionId: 1,
    classId: 1,
    profileId: "p",
    groupId: null,
    detectEmptyForAssignmentId: 123
  });

  assertEquals(result.combinedHash, matchingHash);
  assertEquals(result.isEmpty, false);
});
