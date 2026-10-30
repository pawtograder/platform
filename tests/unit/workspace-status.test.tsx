import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { WorkspaceStatus } from "@/components/workspace/WorkspaceStatus";
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
    expect(await client.open(1)).toEqual({ status: "starting", step: "git_setup" });
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
    expect(await client.open(1)).toEqual({ status: "starting", step: "git_setup" });
  });

  it("keeps each assignment's workspace separate", async () => {
    const client = createSimulatedWorkspaceClient({ stepMs: 1000 });
    await client.open(1);
    jest.advanceTimersByTime(1000);
    expect(await client.getStatus(1)).toEqual({ status: "starting", step: "clone" });
    expect(await client.getStatus(2)).toEqual({ status: "not_started" });
  });

  it("labels every step", () => {
    for (const step of WORKSPACE_STEPS) {
      expect(workspaceStepLabel(step.id)).toBe(step.label);
    }
  });
});

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
      jest.advanceTimersByTime(1000);
    });
    expect(
      await screen.findByText(/Clone your repository/, { selector: "[data-testid=workspace-status]" })
    ).toBeVisible();

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    const link = await screen.findByRole("link", { name: "Open in VS Code" });
    expect(link).toHaveAttribute("href", "https://editor.example");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    const callsWhenReady = client.getStatus.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(client.getStatus.mock.calls.length).toBe(callsWhenReady);
  });

  it("marks steps done, failed and pending, and retries a failed workspace", async () => {
    const client = stubClient({
      initial: { status: "failed", step: "clone", message: "Clone broke." },
      opened: { status: "starting", step: "git_setup" }
    });
    const { container } = renderCard(client);
    expect(await screen.findByText("Workspace not ready: Clone your repository failed.")).toBeInTheDocument();
    expect(screen.getByText(/Clone broke\./)).toBeInTheDocument();
    expect(container.querySelector('[data-step="git_setup"]')).toHaveAttribute("data-mark", "done");
    expect(container.querySelector('[data-step="clone"]')).toHaveAttribute("data-mark", "failed");
    expect(container.querySelector('[data-step="editor"]')).toHaveAttribute("data-mark", "pending");
    expect(screen.queryByRole("link", { name: "Open in VS Code" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Starting your workspace/)).toBeInTheDocument();
    expect(client.open).toHaveBeenCalledTimes(1);
  });

  it("announces status changes to screen readers", async () => {
    renderCard(stubClient({ initial: { status: "not_started" } }));
    const status = await screen.findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Your workspace is not running.");
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
