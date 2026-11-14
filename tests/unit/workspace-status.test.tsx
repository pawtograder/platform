import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { WorkspaceStatus } from "@/components/workspace/WorkspaceStatus";
import { POLL_MIN_MS } from "@/hooks/useWorkspaceStatus";
import {
  cloudWorkspacesEnabled,
  createWorkspaceClient,
  toWorkspaceState,
  WORKSPACE_STEPS,
  WorkspaceClient,
  WorkspaceState,
  workspaceStepLabel
} from "@/lib/workspaceStatus";
import type { WorkspaceOpenResponse } from "@/supabase/functions/_shared/FunctionTypes.js";

describe("toWorkspaceState", () => {
  it.each([
    [{ status: "not_started" }, { status: "not_started" }],
    [
      { status: "starting", step: "clone" },
      { status: "starting", step: "clone" }
    ],
    [{ status: "starting" }, { status: "starting", step: "build" }],
    [
      { status: "restarting", step: "build" },
      { status: "starting", step: "build", restarting: true }
    ],
    [
      { status: "ready", redirect_url: "https://coder.example/vscode" },
      { status: "ready", url: "https://coder.example/vscode" }
    ],
    [
      { status: "failed", step: "clone", message: "Git Clone failed: repository not found" },
      { status: "failed", step: "clone", message: "Git Clone failed: repository not found" }
    ],
    [
      { status: "needs_linking", authenticate_url: "https://coder.example/external-auth/forgejo", message: "Link it." },
      { status: "needs_linking", url: "https://coder.example/external-auth/forgejo", message: "Link it." }
    ],
    [
      { status: "account_conflict", message: "Ask staff." },
      { status: "account_conflict", message: "Ask staff." }
    ]
  ] as [WorkspaceOpenResponse, WorkspaceState][])("maps %j", (res, expected) => {
    expect(toWorkspaceState(res)).toEqual(expected);
  });

  it("gives a failure with no message a generic reason", () => {
    expect(toWorkspaceState({ status: "failed", step: "editor" })).toEqual({
      status: "failed",
      step: "editor",
      message: "The workspace could not start."
    });
  });

  it("refuses a ready reply with no editor link, and needs_linking with no link", () => {
    expect(() => toWorkspaceState({ status: "ready" })).toThrow(/no editor link/);
    expect(() => toWorkspaceState({ status: "needs_linking" })).toThrow(/no link/);
  });

  it("labels every step", () => {
    for (const step of WORKSPACE_STEPS) {
      expect(workspaceStepLabel(step.id)).toBe(step.label);
    }
  });
});

describe("createWorkspaceClient", () => {
  it("reads status from workspace-status and opens through workspace-open", async () => {
    const invoke = jest
      .fn()
      .mockResolvedValueOnce({ data: { status: "not_started" }, error: null })
      .mockResolvedValueOnce({ data: { status: "starting", step: "build" }, error: null });
    const client = createWorkspaceClient({ functions: { invoke } } as unknown as Parameters<
      typeof createWorkspaceClient
    >[0]);
    expect(await client.getStatus(7)).toEqual({ status: "not_started" });
    expect(await client.open(7)).toEqual({ status: "starting", step: "build" });
    expect(invoke).toHaveBeenNthCalledWith(1, "workspace-status", { body: { assignment_id: 7 } });
    expect(invoke).toHaveBeenNthCalledWith(2, "workspace-open", { body: { assignment_id: 7 } });
  });
});

describe("cloudWorkspacesEnabled", () => {
  it.each([
    [[{ name: "cloud-workspaces", enabled: true }], true],
    [[{ name: "cloud-workspaces", enabled: false }], false],
    [[{ name: "cloud-workspaces", enabled: "true" }], false],
    [
      [
        { name: "cloud-workspaces", enabled: false },
        { name: "cloud-workspaces", enabled: true }
      ],
      false
    ],
    [[], false],
    [null, false],
    [{ name: "cloud-workspaces", enabled: true }, false]
  ])("%j is %s", (features, expected) => {
    expect(cloudWorkspacesEnabled(features)).toBe(expected);
  });
});

type Settle = { resolve: (s: WorkspaceState) => void; reject: (e: Error) => void };

describe("WorkspaceStatus", () => {
  function stubClient(states: { initial: WorkspaceState; polls?: WorkspaceState[]; opened?: WorkspaceState }) {
    const polls = [...(states.polls ?? [])];
    let last = states.initial;
    let first = true;
    const client: WorkspaceClient & { getStatus: jest.Mock; open: jest.Mock } = {
      getStatus: jest.fn(async () => {
        if (first) {
          first = false;
          return last;
        }
        last = polls.shift() ?? last;
        return last;
      }),
      open: jest.fn(async () => {
        last = states.opened ?? last;
        return last;
      })
    };
    return client;
  }

  function renderCard(client: WorkspaceClient) {
    return render(
      <ChakraProvider value={defaultSystem}>
        <WorkspaceStatus assignmentId={7} client={client} />
      </ChakraProvider>
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("offers to open a workspace that is not running, with no editor link", async () => {
    renderCard(stubClient({ initial: { status: "not_started" } }));
    expect(await screen.findByText("Your workspace is not running.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in Coder" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Open in VS Code" })).not.toBeInTheDocument();
  });

  it("opens, polls while starting, and stops polling once ready", async () => {
    const client = stubClient({
      initial: { status: "not_started" },
      opened: { status: "starting", step: "build" },
      polls: [
        { status: "starting", step: "clone" },
        { status: "ready", url: "https://editor.example" }
      ]
    });
    renderCard(client);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Coder" }));
    expect(await screen.findByText(/Starting your workspace: Prepare the workspace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(client.open).toHaveBeenCalledWith(7);

    await act(async () => {
      jest.advanceTimersByTime(POLL_MIN_MS);
    });
    expect(
      await screen.findByText(/Clone your repository/, { selector: "[data-testid=workspace-status]" })
    ).toBeVisible();

    await act(async () => {
      jest.advanceTimersByTime(POLL_MIN_MS * 1.5);
    });
    const link = await screen.findByRole("link", { name: "Open in VS Code (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "https://editor.example");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const callsWhenReady = client.getStatus.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(client.getStatus.mock.calls.length).toBe(callsWhenReady);
  });

  it("waits for each poll to settle before sending the next", async () => {
    const pending: Array<(s: WorkspaceState) => void> = [];
    const client: WorkspaceClient = {
      getStatus: jest
        .fn()
        .mockResolvedValueOnce({ status: "starting", step: "build" })
        .mockImplementation(() => new Promise<WorkspaceState>((resolve) => pending.push(resolve))),
      open: jest.fn()
    };
    renderCard(client);
    await screen.findByText(/Starting your workspace/);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
  });

  it("drops a status reply that started before Retry", async () => {
    let resolveSlow: (s: WorkspaceState) => void = () => {};
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: "failed", step: "clone", message: "Clone broke." } as WorkspaceState)
      .mockImplementationOnce(() => new Promise<WorkspaceState>((resolve) => (resolveSlow = resolve)))
      .mockResolvedValue({ status: "starting", step: "build" } as WorkspaceState);
    const open = jest.fn(async () => ({ status: "starting", step: "build" }) as WorkspaceState);
    renderCard({ getStatus, open });
    await screen.findByRole("button", { name: "Retry" });

    // A status check starts (the tab became visible), then the student presses Retry.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(getStatus).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Starting your workspace: Prepare the workspace/);

    // The old check lands with the old answer and must not flip the card back to Failed.
    await act(async () => {
      resolveSlow({ status: "failed", step: "clone", message: "Clone broke." });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Starting your workspace: Prepare the workspace");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("marks steps done, failed and pending, and retries a failed workspace", async () => {
    const client = stubClient({
      initial: { status: "failed", step: "clone", message: "Clone broke." },
      opened: { status: "starting", step: "build" }
    });
    const { container } = renderCard(client);
    expect(await screen.findByText("Workspace not ready: Clone your repository failed.")).toBeInTheDocument();
    expect(screen.getByText(/Try again, and if it keeps failing/)).toHaveTextContent("Clone broke.");
    expect(container.querySelector('[data-step="build"]')).toHaveAttribute("data-mark", "done");
    expect(container.querySelector('[data-step="clone"]')).toHaveAttribute("data-mark", "failed");
    expect(container.querySelector('[data-step="editor"]')).toHaveAttribute("data-mark", "pending");
    expect(screen.queryByRole("link", { name: "Open in VS Code" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Starting your workspace/)).toBeInTheDocument();
    expect(client.open).toHaveBeenCalledTimes(1);
  });

  it("announces status changes in the same live region", async () => {
    renderCard(stubClient({ initial: { status: "not_started" }, opened: { status: "starting", step: "build" } }));
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Your workspace is not running.");
    fireEvent.click(screen.getByRole("button", { name: "Open in Coder" }));
    await screen.findByText(/Starting your workspace/);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Starting your workspace: Prepare the workspace…");
  });

  it("reads the failure reason out in the live region", async () => {
    renderCard(stubClient({ initial: { status: "failed", step: "clone", message: "Clone broke." } }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Workspace not ready: Clone your repository failed. Clone broke."
    );
  });

  it("keeps focus inside the card after Open and after Retry", async () => {
    const client = stubClient({
      initial: { status: "not_started" },
      opened: { status: "failed", step: "clone", message: "Clone broke." }
    });
    renderCard(client);
    const openButton = await screen.findByRole("button", { name: "Open in Coder" });
    openButton.focus();
    fireEvent.click(openButton);
    await screen.findByRole("button", { name: "Retry" });
    expect(document.activeElement).toBe(screen.getByRole("status"));

    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    await act(async () => {});
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("status").closest("div")?.contains(document.activeElement)).toBe(true);
  });

  it("sends one open request for a double click", async () => {
    let resolveOpen: (s: WorkspaceState) => void = () => {};
    const client: WorkspaceClient & { open: jest.Mock } = {
      getStatus: jest.fn(async () => ({ status: "not_started" }) as WorkspaceState),
      open: jest.fn(() => new Promise<WorkspaceState>((resolve) => (resolveOpen = resolve)))
    };
    renderCard(client);
    const openButton = await screen.findByRole("button", { name: "Open in Coder" });
    fireEvent.click(openButton);
    fireEvent.click(openButton);
    expect(client.open).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOpen({ status: "starting", step: "build" });
    });
    expect(await screen.findByText(/Starting your workspace/)).toBeInTheDocument();
  });

  it("offers Try again when the first status lookup fails, and recovers", async () => {
    const getStatus = jest
      .fn()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValue({ status: "not_started" } as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach your workspace: timed out");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your workspace is not running.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a poll error once a later poll succeeds", async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: "starting", step: "editor" } as WorkspaceState)
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue({ status: "ready", url: "https://editor.example" } as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    await screen.findByText(/Starting your workspace/);
    await act(async () => {
      jest.advanceTimersByTime(POLL_MIN_MS);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("network blip");
    await act(async () => {
      jest.advanceTimersByTime(POLL_MIN_MS * 1.5);
    });
    expect(await screen.findByRole("link", { name: /Open in VS Code/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["resolves with an older state", (settle: Settle) => settle.resolve({ status: "starting", step: "editor" })],
    ["rejects", (settle: Settle) => settle.reject(new Error("network blip"))]
  ])("keeps a newer ready reply when an older poll %s after it", async (_label, finishOldPoll) => {
    let oldPoll: Settle | undefined;
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: "starting", step: "editor" } as WorkspaceState)
      .mockImplementationOnce(() => new Promise<WorkspaceState>((resolve, reject) => (oldPoll = { resolve, reject })))
      .mockResolvedValue({ status: "ready", url: "https://editor.example" } as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    await screen.findByText(/Starting your workspace/);

    // A poll goes out and hangs; then the tab becomes visible and a newer check returns ready.
    await act(async () => {
      jest.advanceTimersByTime(POLL_MIN_MS);
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("link", { name: /Open in VS Code/ })).toBeInTheDocument();

    await act(async () => {
      finishOldPoll(oldPoll!);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Your workspace is ready.");
    expect(screen.getByRole("link", { name: /Open in VS Code/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the reply to Open when the tab becomes visible while Open is running", async () => {
    let finishOpen: (s: WorkspaceState) => void = () => {};
    const getStatus = jest.fn(async () => ({ status: "not_started" }) as WorkspaceState);
    const open = jest.fn(() => new Promise<WorkspaceState>((resolve) => (finishOpen = resolve)));
    renderCard({ getStatus, open });
    fireEvent.click(await screen.findByRole("button", { name: "Open in Coder" }));

    // The student switches back to the tab before Open has answered.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      finishOpen({ status: "starting", step: "build" });
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Starting your workspace: Prepare the workspace");
  });

  it("checks a ready workspace again when the tab becomes visible", async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: "ready", url: "https://editor.example" } as WorkspaceState)
      .mockResolvedValue({ status: "not_started" } as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    await screen.findByRole("link", { name: /Open in VS Code/ });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByText("Your workspace is not running.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open in VS Code/ })).not.toBeInTheDocument();
  });

  it("skips polls while the tab is hidden", async () => {
    const getStatus = jest.fn(async () => ({ status: "starting", step: "build" }) as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    await screen.findByText(/Starting your workspace/);
    const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(getStatus).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
    }
  });

  it("shows an error, and keeps the card usable, when the workspace can't be reached", async () => {
    const client: WorkspaceClient = {
      getStatus: jest.fn(async () => ({ status: "not_started" }) as WorkspaceState),
      open: jest.fn(async () => {
        throw new Error("network down");
      })
    };
    renderCard(client);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Coder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach your workspace: network down");
    expect(screen.getByRole("button", { name: "Open in Coder" })).toBeEnabled();
  });

  it("says a broken workspace is restarting, and keeps polling", async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: "starting", step: "build", restarting: true } as WorkspaceState)
      .mockResolvedValue({ status: "starting", step: "clone" } as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    expect(await screen.findByRole("status")).toHaveTextContent("Restarting your workspace…");
    await act(async () => {
      jest.advanceTimersByTime(POLL_MIN_MS);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Starting your workspace: Clone your repository…");
  });

  it("sends a student who has to link Forgejo to Coder's link page in a new tab, with no editor link", async () => {
    renderCard(
      stubClient({
        initial: {
          status: "needs_linking",
          url: "https://coder.example/external-auth/forgejo",
          message: "Link your Forgejo account in Coder, then open the workspace again."
        }
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Link your Forgejo account to open your workspace. Link your Forgejo account in Coder"
    );
    const link = screen.getByRole("link", { name: "Link Forgejo account (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "https://coder.example/external-auth/forgejo");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.queryByRole("link", { name: /Open in VS Code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("checks again when the student comes back from linking Forgejo", async () => {
    const getStatus = jest
      .fn()
      .mockResolvedValueOnce({ status: "needs_linking", url: "https://coder.example/x", message: "Link it." })
      .mockResolvedValue({ status: "not_started" } as WorkspaceState);
    renderCard({ getStatus, open: jest.fn() });
    await screen.findByRole("link", { name: /Link Forgejo account/ });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByRole("button", { name: "Open in Coder" })).toBeEnabled();
  });

  it("tells a student with a Coder account conflict to ask staff, with nothing to click", async () => {
    renderCard(stubClient({ initial: { status: "account_conflict", message: "Ask course staff to remove it." } }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your workspace can't be opened. Ask course staff to remove it."
    );
    expect(screen.getByText("Ask your course staff")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
