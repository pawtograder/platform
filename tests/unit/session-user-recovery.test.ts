import { installSessionUserRecovery, isConfirmedAbsentSession, isForeignSessionUser } from "@/lib/sessionUserRecovery";

describe("isForeignSessionUser", () => {
  it("flags a session that belongs to a different user than the render", () => {
    // The pair from the production report: the page was rendered for the first
    // user, the live session had been replaced by the second.
    expect(isForeignSessionUser("fd0aad59-dd20-4dd8-85ca-5b466e14396c", "4feae240-67f4-45fc-9e07-b04e7c3d00d0")).toBe(
      true
    );
  });

  it("does not flag the same user (a plain token refresh keeps the id)", () => {
    expect(isForeignSessionUser("user-a", "user-a")).toBe(false);
  });

  it("does not flag a missing session — sign-out has its own redirect path", () => {
    expect(isForeignSessionUser("user-a", undefined)).toBe(false);
    expect(isForeignSessionUser("user-a", null)).toBe(false);
  });

  it("does not flag a missing rendered user", () => {
    expect(isForeignSessionUser(undefined, "user-b")).toBe(false);
  });
});

// The whole reason #902 left cross-tab sign-out alone: a null session means
// either "signed out" or "the refresh failed", and only the error channel tells
// them apart. Getting this predicate wrong throws people off a working page on
// every network blip.
describe("isConfirmedAbsentSession", () => {
  it("confirms a clean read that found no session", () => {
    expect(isConfirmedAbsentSession(null)).toBe(true);
    expect(isConfirmedAbsentSession(undefined)).toBe(true);
    expect(isConfirmedAbsentSession(null, null)).toBe(true);
  });

  it("refuses to confirm when the read reported an error — a failed refresh looks identical", () => {
    expect(isConfirmedAbsentSession(null, new Error("refresh_token_not_found"))).toBe(false);
    expect(isConfirmedAbsentSession(undefined, { message: "network error" })).toBe(false);
  });

  it("is never true while a session exists", () => {
    expect(isConfirmedAbsentSession("user-a")).toBe(false);
    expect(isConfirmedAbsentSession("user-a", new Error("boom"))).toBe(false);
  });
});

describe("installSessionUserRecovery", () => {
  let reloadCalls: number;
  const reload = () => {
    reloadCalls += 1;
  };

  /**
   * Stub of the Supabase auth client: hands back the emitter for the test, and
   * a `setSession` that changes what `getSession` reports *without* emitting —
   * that silence is exactly the server-action sign-in the poll exists for.
   */
  function fakeClient() {
    type Session = { user: { id: string } } | null;
    let handler: ((event: string, session: Session) => void) | undefined;
    let session: Session = null;
    // The discriminator between "signed out" and "a refresh failed": supabase-js
    // reports the latter as an error alongside the null session.
    let error: unknown = null;
    let rejects = false;
    const unsubscribe = jest.fn();
    const sessionFor = (userId: string | null): Session => (userId === null ? null : { user: { id: userId } });
    const client = {
      auth: {
        onAuthStateChange: (cb: typeof handler) => {
          handler = cb;
          return { data: { subscription: { unsubscribe } } };
        },
        getSession: async () => {
          if (rejects) throw new Error("network down");
          return { data: { session }, error };
        }
      }
    };
    return {
      client: client as never,
      unsubscribe,
      setSession: (userId: string | null) => {
        session = sessionFor(userId);
      },
      /** Null session *with* an error — a failed refresh, not a sign-out. */
      setSessionReadError: (err: unknown) => {
        session = null;
        error = err;
      },
      setRejects: (value: boolean) => {
        rejects = value;
      },
      emit: (userId: string | null) => {
        session = sessionFor(userId);
        handler?.(userId === null ? "SIGNED_OUT" : "SIGNED_IN", session);
      }
    };
  }

  beforeEach(() => {
    reloadCalls = 0;
    window.sessionStorage.clear();
  });

  it("reloads once when the session switches to another user", () => {
    const { client, emit } = fakeClient();
    const uninstall = installSessionUserRecovery({ client, renderedUserId: "user-a", reload });

    emit("user-b");
    expect(reloadCalls).toBe(1);

    // Loop guard: Supabase re-emits SIGNED_IN on every focus/refresh tick, and
    // the reload itself takes a moment — none of that may reload again.
    emit("user-b");
    expect(reloadCalls).toBe(1);

    uninstall();
  });

  it("leaves the tab alone while the session stays with the rendered user", () => {
    const { client, emit } = fakeClient();
    const uninstall = installSessionUserRecovery({ client, renderedUserId: "user-a", reload });

    emit("user-a");
    emit(null);
    expect(reloadCalls).toBe(0);

    uninstall();
  });

  it("still recovers when a second, different user takes over during the cooldown", () => {
    const { client, emit } = fakeClient();
    const uninstall = installSessionUserRecovery({ client, renderedUserId: "user-a", reload });

    // A → B reloads. Before the reload lands, B → C: a mismatch we have never
    // acted on, so the loop guard must not swallow it — otherwise the tab stays
    // rendered for B while its requests authenticate as C.
    emit("user-b");
    emit("user-c");

    expect(reloadCalls).toBe(2);

    uninstall();
  });

  it("reloads when the session is swapped with no auth event, as a server action does", async () => {
    jest.useFakeTimers();
    try {
      const { client, setSession } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setSession("user-b");
      expect(reloadCalls).toBe(0);

      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(1);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not poll a hidden tab — supabase-js re-reads the session when it comes back", async () => {
    jest.useFakeTimers();
    const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const { client, setSession } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setSession("user-b");
      await jest.advanceTimersByTimeAsync(5000);
      expect(reloadCalls).toBe(0);

      uninstall();
    } finally {
      visibility.mockRestore();
      jest.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------
  // Cross-tab sign-out (issue #911). signOutAction clears the shared cookie
  // for every tab and redirects only the tab it ran in; the others keep a
  // rendered, authenticated page full of private data until someone reloads
  // by hand.
  // ---------------------------------------------------------------------

  it("reloads a tab whose session was signed out in another tab", async () => {
    jest.useFakeTimers();
    try {
      const { client, setSession } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setSession("user-a");
      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(0);

      // Another tab signs out: the shared cookie is gone, no auth event fires.
      setSession(null);
      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(1);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not reload when the session read errored — a failed refresh is not a sign-out", async () => {
    jest.useFakeTimers();
    try {
      const { client, setSessionReadError } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setSessionReadError(new Error("refresh_token_not_found"));
      await jest.advanceTimersByTimeAsync(5000);
      expect(reloadCalls).toBe(0);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not reload when the session read rejects outright", async () => {
    jest.useFakeTimers();
    try {
      const { client, setRejects } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setRejects(true);
      await jest.advanceTimersByTimeAsync(5000);
      expect(reloadCalls).toBe(0);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  // The loop this bound exists for: if the server keeps rendering authenticated
  // while the browser cannot read the cookie, the reload lands on the same page
  // with the same absent session. One extra reload is acceptable; a 60s reload
  // loop forever is not.
  it("reloads at most once per tab for a sign-out that does not converge", async () => {
    jest.useFakeTimers();
    try {
      const { client, setSession } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setSession(null);
      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(1);

      // The reload did not fix anything — the session is still absent.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(reloadCalls).toBe(1);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  it("recovers again after a later sign-out once a valid session has been seen", async () => {
    jest.useFakeTimers();
    try {
      const { client, setSession } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: "user-a",
        reload,
        pollIntervalMs: 1000
      });

      setSession(null);
      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(1);

      // Signed back in as the same user: the tab is consistent again, so the
      // one-per-tab marker must be dropped...
      setSession("user-a");
      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(1);

      // ...otherwise this second sign-out would be silently swallowed.
      setSession(null);
      await jest.advanceTimersByTimeAsync(1000);
      expect(reloadCalls).toBe(2);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  // The initiating tab is mid-redirect to /sign-in when the cookie clears, and
  // the sign-in page renders no user. Acting there would reload the page the
  // user is being sent to.
  it("leaves a tab with no rendered user alone when there is no session", async () => {
    jest.useFakeTimers();
    try {
      const { client, setSession } = fakeClient();
      const uninstall = installSessionUserRecovery({
        client,
        renderedUserId: null,
        reload,
        pollIntervalMs: 1000
      });

      setSession(null);
      await jest.advanceTimersByTimeAsync(5000);
      expect(reloadCalls).toBe(0);

      uninstall();
    } finally {
      jest.useRealTimers();
    }
  });

  // INITIAL_SESSION arrives with a null session on any page that legitimately
  // has none yet, so the event path must stay inert; only a poll tick is a
  // positive statement about the session right now.
  it("does not act on a null session delivered as an auth event", () => {
    const { client, emit } = fakeClient();
    const uninstall = installSessionUserRecovery({ client, renderedUserId: "user-a", reload });

    emit(null);
    expect(reloadCalls).toBe(0);

    uninstall();
  });

  it("unsubscribes and stops polling on uninstall", async () => {
    jest.useFakeTimers();
    try {
      const { client, unsubscribe, setSession } = fakeClient();
      installSessionUserRecovery({ client, renderedUserId: "user-a", reload, pollIntervalMs: 1000 })();
      expect(unsubscribe).toHaveBeenCalled();

      setSession("user-b");
      await jest.advanceTimersByTimeAsync(5000);
      expect(reloadCalls).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
