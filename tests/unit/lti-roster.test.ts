/**
 * @jest-environment node
 *
 * Unit coverage for the roster-sync drop guard in lib/lti/roster.ts. A class with
 * multiple LTI contexts (e.g. separate lecture + lab Canvas courses) must NOT let
 * one context's sync drop class-wide members, and a failed/indeterminate count
 * must fail safe (never drop) — getting this wrong mass-disables students owned
 * by sibling contexts.
 */
// roster.ts's only non-pure imports are the DB client and the NRPS HTTP module;
// stub both so importing the module (for the pure canDropMissing helper) doesn't
// pull in the service-role client / network chain.
jest.mock("@/lib/lti/db", () => ({ ltiAdminClient: jest.fn() }));
jest.mock("@/lib/lti/nrps", () => ({ fetchMemberships: jest.fn(), mapRoster: jest.fn() }));

import { canDropMissing, buildSectionConfig, type ContextLinkRow } from "@/lib/lti/roster";

describe("canDropMissing", () => {
  test("drops when this is the sole linked context", () => {
    expect(canDropMissing(1, null)).toBe(true);
  });

  test("does NOT drop when the class has multiple linked contexts", () => {
    expect(canDropMissing(2, null)).toBe(false);
    expect(canDropMissing(5, null)).toBe(false);
  });

  test("fails safe (no drop) when the count query errored", () => {
    expect(canDropMissing(1, new Error("boom"))).toBe(false);
    // even a count that would otherwise permit dropping must not drop on error
    expect(canDropMissing(0, { message: "transient" })).toBe(false);
  });

  test("fails safe (no drop) when the count is null/undefined", () => {
    expect(canDropMissing(null, null)).toBe(false);
    expect(canDropMissing(undefined, null)).toBe(false);
  });

  test("drops on a zero count (degenerate sole-context case)", () => {
    expect(canDropMissing(0, null)).toBe(true);
  });
});

describe("buildSectionConfig — batched CRN resolution", () => {
  // A fake db that records from() calls and .in() filters so we can assert the
  // section id -> sis_crn resolution is batched (one query per section table)
  // rather than a per-id single-row lookup (the old N+1).
  function makeRosterDb(fixtures: Record<string, { data: unknown }>) {
    const fromCalls: string[] = [];
    const inCalls: Array<{ table: string; col: string; vals: unknown }> = [];
    const from = (table: string) => {
      fromCalls.push(table);
      const result = fixtures[table] ?? { data: [] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = (col: string, vals: unknown) => {
        inCalls.push({ table, col, vals });
        return builder;
      };
      // A per-id lookup would call maybeSingle(); fail loudly if the batched
      // refactor regresses to that.
      builder.maybeSingle = () => {
        throw new Error(`unexpected per-id maybeSingle() on ${table} — buildSectionConfig must batch`);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      builder.then = (resolve: any, reject: any) =>
        Promise.resolve({ data: result.data, error: null }).then(resolve, reject);
      return builder;
    };
    return { db: { from } as unknown as Parameters<typeof buildSectionConfig>[1], fromCalls, inCalls };
  }

  test("resolves split-by-member section CRNs with one batched query per table", async () => {
    const link: ContextLinkRow = {
      id: 1,
      platform_id: 10,
      class_id: 100,
      context_id: "ctx",
      nrps_url: "https://canvas.test/nrps",
      roster_sync_enabled: true,
      section_role: "lab",
      class_section_id: 200,
      lab_section_id: null,
      split_by_member_section: true
    };
    const { db, fromCalls, inCalls } = makeRosterDb({
      lti_context_section_map: {
        data: [
          { canvas_section_name: "Sec A", class_section_id: 200, lab_section_id: 300 },
          { canvas_section_name: "Sec B", class_section_id: 201, lab_section_id: 301 }
        ]
      },
      class_sections: {
        data: [
          { id: 200, sis_crn: 1111 },
          { id: 201, sis_crn: 2222 }
        ]
      },
      lab_sections: {
        data: [
          { id: 300, sis_crn: 3333 },
          { id: 301, sis_crn: 4444 }
        ]
      }
    });

    const cfg = await buildSectionConfig(link, db);

    // Each section table is hit exactly once (batched), not once per id.
    expect(fromCalls.filter((t) => t === "class_sections")).toHaveLength(1);
    expect(fromCalls.filter((t) => t === "lab_sections")).toHaveLength(1);
    // The batched .in() carries every unique id (context-level + per-member map).
    expect(new Set(inCalls.find((c) => c.table === "class_sections")?.vals as number[])).toEqual(new Set([200, 201]));
    expect(new Set(inCalls.find((c) => c.table === "lab_sections")?.vals as number[])).toEqual(new Set([300, 301]));

    // CRNs are resolved correctly into the config.
    expect(cfg.classSectionCrn).toBe(1111); // link.class_section_id = 200
    expect(cfg.labSectionCrn).toBeNull(); // link.lab_section_id = null
    expect(cfg.nameMap.get("Sec A")).toEqual({ classSectionCrn: 1111, labSectionCrn: 3333 });
    expect(cfg.nameMap.get("Sec B")).toEqual({ classSectionCrn: 2222, labSectionCrn: 4444 });
  });
});
