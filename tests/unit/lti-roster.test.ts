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

import { canDropMissing, buildSectionConfig, syncContextRoster, type ContextLinkRow } from "@/lib/lti/roster";
import { fetchMemberships, mapRoster } from "@/lib/lti/nrps";

const fetchMembershipsMock = fetchMemberships as jest.Mock;
const mapRosterMock = mapRoster as jest.Mock;

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

describe("syncContextRoster — cross-drop guard counts only sync-eligible contexts", () => {
  /** A course_wide link with no sections, so buildSectionConfig/upsertLtiUsers issue
   *  no queries and the only lti_context_links read is the cross-drop count query. */
  const link: ContextLinkRow = {
    id: 1,
    platform_id: 10,
    class_id: 100,
    context_id: "ctx",
    nrps_url: "https://canvas.test/nrps",
    roster_sync_enabled: true,
    section_role: "course_wide",
    class_section_id: null,
    lab_section_id: null,
    split_by_member_section: false
  };

  /** Fake db: records the cross-drop COUNT query's filters and the sis_sync_enrollment
   *  rpc args; the count select resolves to `eligibleCount`. */
  function makeContextDb(eligibleCount: number) {
    const countFilters: Record<string, unknown> = {};
    const rpcCalls: Array<{ fn: string; args: unknown }> = [];
    const from = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = { _isCount: false, _update: undefined };
      b.select = (_col: string, opts?: { count?: string; head?: boolean }) => {
        if (opts && (opts.count || opts.head)) b._isCount = true;
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        if (b._isCount) countFilters[col] = val;
        return b;
      };
      b.not = (col: string, op: string, val: unknown) => {
        if (b._isCount) countFilters[col] = `${op}.${val}`;
        return b;
      };
      b.in = () => b;
      b.update = (payload: unknown) => {
        b._update = payload;
        return b;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      b.then = (resolve: any, reject: any) => {
        const out = b._isCount ? { count: eligibleCount, error: null } : { data: null, error: null };
        return Promise.resolve(out).then(resolve, reject);
      };
      return b;
    };
    const rpc = async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { data: {}, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { db: { from, rpc } as any, countFilters, rpcCalls };
  }

  beforeEach(() => {
    fetchMembershipsMock.mockReset().mockResolvedValue({ members: [] });
    mapRosterMock.mockReset().mockReturnValue({ roster: [], unmapped: [] });
  });

  test("the count query filters to roster_sync_enabled + non-null nrps_url (not every link on the class)", async () => {
    const { db, countFilters } = makeContextDb(1);
    await syncContextRoster(link, db);
    expect(countFilters.class_id).toBe(100);
    expect(countFilters.roster_sync_enabled).toBe(true);
    // .not("nrps_url", "is", null) → recorded as the operator+value
    expect(countFilters.nrps_url).toBe("is.null");
  });

  test("drops missing members when this is the sole ELIGIBLE context (count = 1)", async () => {
    const { db, rpcCalls } = makeContextDb(1);
    await syncContextRoster(link, db);
    const sync = rpcCalls.find((c) => c.fn === "sis_sync_enrollment");
    expect((sync?.args as { p_sync_options: { drop_missing: boolean } }).p_sync_options.drop_missing).toBe(true);
  });

  test("does NOT drop when more than one eligible context exists (count = 2)", async () => {
    const { db, rpcCalls } = makeContextDb(2);
    await syncContextRoster(link, db);
    const sync = rpcCalls.find((c) => c.fn === "sis_sync_enrollment");
    expect((sync?.args as { p_sync_options: { drop_missing: boolean } }).p_sync_options.drop_missing).toBe(false);
  });
});
