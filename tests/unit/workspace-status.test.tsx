import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { WorkspaceStatus } from "@/components/workspace/WorkspaceStatus";
import { POLL_MIN_MS } from "@/hooks/useWorkspaceStatus";
import {
  createSimulatedWorkspaceClient,
  WORKSPACE_STEPS,
  WorkspaceClient,
  WorkspaceState,
  workspaceStepLabel
} from "@/lib/workspaceStatus";

describe("createSimulatedWorkspaceClient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("is not started until opened", async () => {
    const client = createSimulatedWorkspaceClient();
    expect(await client.getStatus(1)).toEqual({ status: "not_started" });
  });

  it("walks every step in order, then is ready with the editor URL", async () => {
    const client = createSimulatedWorkspaceClient({ stepMs: 1000, editorUrl: "https://editor.example" });
    expect(await client.open(1)).toEqual({ status: "starting", step: "build" });
    jest.advanceTimersByTime(1000);
    expect(await client.getStatus(1)).toEqual({ status: "starting", step: "git_setup" });
    jest.advanceTimersByTime(1000);
    expect(await client.getStatus(1)).toEqual({ status: "starting", step: "clone" });
    jest.advanceTimersByTime(1000);
    expect(await client.getStatus(1)).toEqual({ status: "starting", step: "editor" });
    jest.advanceTimersByTime(1000);
    expect(await client.getStatus(1)).toEqual({ status: "ready", url: "https://editor.example" });
    jest.advanceTimersByTime(60_000);
    expect(await client.getStatus(1)).toEqual({ status: "ready", url: "https://editor.example" });
  });

  it.each(WORKSPACE_STEPS.map((s, i) => [s.id, i] as const))(
    "stops at %s when told to fail there, and never becomes ready",
    async (step, index) => {
      const client = createSimulatedWorkspaceClient({ stepMs: 1000, failAt: step });
      await client.open(1);
      for (let i = 0; i < index; i++) {
        expect(await client.getStatus(1)).toEqual({ status: "starting", step: WORKSPACE_STEPS[i].id });
        jest.advanceTimersByTime(1000);
      }
      const failed = await client.getStatus(1);
      expect(failed).toMatchObject({ status: "failed", step });
      expect((failed as Extract<WorkspaceState, { status: "failed" }>).message.length).toBeGreaterThan(0);
      jest.advanceTimersByTime(60_000);
      expect(await client.getStatus(1)).toMatchObject({ status: "failed", step });
    }
  );

  it("restarts from the first step when opened again (Retry)", async () => {
    const client = createSimulatedWorkspaceClient({ stepMs: 1000, failAt: "clone" });
    await client.open(1);
    jest.advanceTimersByTime(5000);
    expect(await client.getStatus(1)).toMatchObject({ status: "failed" });
    expect(await client.open(1)).toEqual({ status: "starting", step: "build" });
  });

  it.each([-5, 0, Infinity, NaN])("falls back to the default step length for stepMs=%s", async (stepMs) => {
    const client = createSimulatedWorkspaceClient({ stepMs });
    expect(await client.open(1)).toEqual({ status: "starting", step: "build" });
    jest.advanceTimersByTime(1500);
    expect(await client.getStatus(1)).toEqual({ status: "starting", step: "git_setup" });
  });

  it("keeps each assignment's workspace separate", async () => {
    const client = createSimulatedWorkspaceClient({ stepMs: 1000 });
    await client.open(1);
    jest.advanceTimersByTime(1000);
    expect(await client.getStatus(1)).toEqual({ status: "starting", step: "git_setup" });
    expect(await client.getStatus(2)).toEqual({ status: "not_started" });
  });

  it("labels every step", () => {
    for (const step of WORKSPACE_STEPS) {
      expect(workspaceStepLabel(step.id)).toBe(step.label);
    }
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
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Open in VS Code" })).not.toBeInTheDocument();
  });

  it("opens, polls while starting, and stops polling once ready", async () => {
    const client = stubClient({
      initial: { status: "not_started" },
      opened: { status: "starting", step: "git_setup" },
      polls: [
        { status: "starting", step: "clone" },
        { status: "ready", url: "https://editor.example" }
      ]
    });
    renderCard(client);
    fireEvent.click(await screen.findByRole("button", { name: "Open workspace" }));
    expect(await screen.findByText(/Starting your workspace: Sign in to the course git server/)).toBeInTheDocument();
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
      opened: { status: "starting", step: "git_setup" }
    });
    const { container } = renderCard(client);
    expect(await screen.findByText("Workspace not ready: Clone your repository failed.")).toBeInTheDocument();
    expect(screen.getByText(/Try again, and if it keeps failing/)).toHaveTextContent("Clone broke.");
    expect(container.querySelector('[data-step="git_setup"]')).toHaveAttribute("data-mark", "done");
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
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
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
    const openButton = await screen.findByRole("button", { name: "Open workspace" });
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
    const openButton = await screen.findByRole("button", { name: "Open workspace" });
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
    fireEvent.click(await screen.findByRole("button", { name: "Open workspace" }));

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
    fireEvent.click(await screen.findByRole("button", { name: "Open workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach your workspace: network down");
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeEnabled();
  });
});
