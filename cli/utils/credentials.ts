/**
 * CLI credentials path utilities
 */

import * as path from "path";
import * as os from "os";

/**
 * Get the path to the stored credentials file
 */
export function getCredentialsPath(): string {
  const home = os.homedir();
  return path.join(home, ".pawtograder", "credentials.json");
}
