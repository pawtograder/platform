/**
 * Shared identity-mode validation for privacy-controlled export commands.
 */

import { CLICommandError } from "../errors.ts";
import type { IdentityMode } from "./tokenization.ts";

export interface ExportIdentityParams {
  identity_mode?: IdentityMode;
  salt?: string;
  confirm_pii?: boolean;
}

export function validateExportIdentityParams(params: ExportIdentityParams): IdentityMode {
  const mode: IdentityMode = params.identity_mode ?? "opaque";
  if (mode !== "raw" && mode !== "hash" && mode !== "opaque") {
    throw new CLICommandError(`invalid identity_mode: ${String(mode)}`);
  }
  if (mode === "raw" && params.confirm_pii !== true) {
    throw new CLICommandError(
      "identity_mode=raw exposes real student ids, emails, and names. Re-run with confirm_pii: true to acknowledge.",
      400
    );
  }
  if (mode === "hash" || mode === "opaque") {
    if (!params.salt || typeof params.salt !== "string") {
      throw new CLICommandError(`identity_mode=${mode} requires a salt`);
    }
    if (params.salt.length < 16) {
      throw new CLICommandError(`identity_mode=${mode} requires a salt of at least 16 characters`);
    }
  }
  return mode;
}
