import { installSessionUserRecovery, isForeignSessionUser } from "@/lib/sessionUserRecovery";

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
    const unsubscribe = jest.fn();
    const sessionFor = (userId: string | null): Session => (userId === null ? null : { user: { id: userId } });
    const client = {
      auth: {
        onAuthStateChange: (cb: typeof handler) => {
          handler = cb;
          return { data: { subscription: { unsubscribe } } };
        },
        getSession: async () => ({ data: { session } })
      }
    };
    return {
      client: client as never,
      unsubscribe,
      setSession: (userId: string | null) => {
        session = sessionFor(userId);
      },
      emit: (userId: string | null) => {
        session = sessionFor(userId);
        handler?.("SIGNED_IN", session);
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
