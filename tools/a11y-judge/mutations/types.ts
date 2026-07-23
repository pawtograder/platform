/**
 * Shared type for seeded-defect injectors.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types. A `Mutation`
 * deterministically perturbs a driver page (via `page.addInitScript`, registered
 * before navigation so the perturbation is present from first paint) to plant a
 * single, known WCAG failure. Wave 3 wires these into the evidence driver and
 * the judge is expected to catch each planted defect (`expected: "fail"`).
 */
import type { Page } from "@playwright/test";

export type Mutation = {
  /** Stable id, e.g. "247-outline-none". */
  id: string;
  /** WCAG success-criterion number the defect targets, e.g. "2.4.7". */
  criterion: string;
  /** Human-readable description of the planted defect. */
  description: string;
  /** Every mutation is expected to make its criterion FAIL. */
  expected: "fail";
  /** Restrict to specific driver page ids; `undefined` means all pages. */
  pageIds?: string[];
  /** Apply the mutation to a page, typically via `page.addInitScript(...)`. */
  apply(page: Page): Promise<void>;
};
