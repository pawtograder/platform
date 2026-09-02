// Shared helpers for the design-sync grading mock layer.
/* eslint-disable @typescript-eslint/no-explicit-any */

// A fake TableController: list()/getById() return canned data + a no-op
// unsubscribe; CRUD methods resolve. Enough for static render + inert handlers.
export function mockTable(data: any[] = []): any {
  return {
    list: (cb?: (d: any[], delta: any) => void) => {
      if (cb) cb(data, { entered: [], left: [], updated: [] });
      return { unsubscribe: () => {}, data };
    },
    getById: (id: any, cb?: (d: any) => void) => {
      const row = data.find((r) => r.id === id);
      if (cb) cb(row);
      return { data: row, unsubscribe: () => {} };
    },
    getByIdSync: (id: any) => data.find((r) => r.id === id),
    create: async () => {},
    update: async () => {},
    delete: async () => {},
    rows: data,
    readyPromise: Promise.resolve(),
    isReady: true,
    ready: true,
    close: () => {}
  };
}

// Inert chainable proxy — every property access / call returns another inert
// proxy, so an accidental `supabase.from(...).select(...)` during render is a
// harmless no-op rather than a crash.
export function inertProxy(): any {
  const fn = () => inertProxy();
  return new Proxy(fn, {
    get: (_t, k) => {
      if (k === "then") return undefined; // not a thenable
      return inertProxy();
    },
    apply: () => inertProxy()
  });
}
