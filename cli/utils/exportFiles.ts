/**
 * Shared helpers for privacy-controlled CLI export commands.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import type { Argv } from "yargs";
import { CLIError } from "./logger";

export type ExportIdentityMode = "raw" | "hash" | "opaque";

export function addExportIdentityOptions(yargs: Argv): Argv {
  return yargs
    .option("identity", {
      describe: "Subject identifier mode",
      type: "string",
      choices: ["raw", "hash", "opaque"] as const,
      default: "opaque" as const
    })
    .option("salt", {
      describe: "Salt for identity=hash (required); ignored for identity=opaque (random salt is generated per run)",
      type: "string"
    })
    .option("i-understand-pii", {
      describe: "Required to use identity=raw — acknowledges that real student PII will be written to disk",
      type: "boolean",
      default: false
    })
    .check((argv) => {
      if (argv.identity === "raw" && !argv["i-understand-pii"]) {
        throw new Error(
          "--identity raw requires --i-understand-pii to acknowledge that real student data will be written to disk"
        );
      }
      if (argv.identity === "hash" && !argv.salt) {
        throw new Error("--identity hash requires --salt (any string of length >= 16)");
      }
      if (argv.identity === "hash" && argv.salt && argv.salt.length < 16) {
        throw new Error("--salt must be at least 16 characters");
      }
      return true;
    });
}

export function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is a no-op (e.g. Windows).
  }
}

export function writeJsonArray(filePath: string, rows: unknown[]): void {
  if (rows.length === 0) {
    writeJson(filePath, []);
    return;
  }

  const fd = fs.openSync(filePath, "w", 0o600);
  try {
    fs.writeSync(fd, "[\n");
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) fs.writeSync(fd, ",\n");
      const indented = JSON.stringify(rows[i], null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      fs.writeSync(fd, indented);
    }
    fs.writeSync(fd, "\n]\n");
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is a no-op (e.g. Windows).
  }
}

export function assertExpectedCount(endRecord: Record<string, unknown>, field: string, actual: number): void {
  const counts = endRecord.counts as Record<string, unknown> | undefined;
  const expected = counts?.[field];
  if (typeof expected !== "number") return;
  if (expected !== actual) {
    throw new CLIError(
      `Stream count mismatch for ${field}: server reported ${expected} but received ${actual}. ` +
        "The dump is incomplete; do not use it for analysis."
    );
  }
}

export function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function generateRandomSalt(): string {
  const bytes = crypto.randomBytes(32);
  return base32Encode(bytes);
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is a no-op (e.g. Windows).
  }
}

export function refToken(ref: unknown): string {
  if (!ref || typeof ref !== "object") return "";
  const o = ref as Record<string, unknown>;
  if (typeof o.token === "string") return o.token;
  if (o.id !== undefined && o.id !== null) return String(o.id);
  return "";
}
