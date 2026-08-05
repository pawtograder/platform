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

  /** Stub of the Supabase auth client: hands back the emitter for the test. */
  function fakeClient() {
    let handler: ((event: string, session: { user: { id: string } } | null) => void) | undefined;
    const unsubscribe = jest.fn();
    const client = {
      auth: {
        onAuthStateChange: (cb: typeof handler) => {
          handler = cb;
          return { data: { subscription: { unsubscribe } } };
        }
      }
    };
    return {
      client: client as never,
      unsubscribe,
      emit: (userId: string | null) => handler?.("SIGNED_IN", userId === null ? null : { user: { id: userId } })
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

  it("unsubscribes on uninstall", () => {
    const { client, unsubscribe } = fakeClient();
    installSessionUserRecovery({ client, renderedUserId: "user-a", reload })();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
