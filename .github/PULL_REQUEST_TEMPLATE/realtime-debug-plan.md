### Purpose

Add comprehensive realtime logging to localize flaky E2E failures asserting realtime connectivity. This PR targets `111-course-controller-refactor` to instrument the new realtime architecture.

### What was added

- A scoped `DebugLogger` with timestamped, scoped logs enabled via `NEXT_PUBLIC_DEBUG_LOG=1` or `localStorage['debug']` containing `realtime`.
- High-signal logs in:
  - `RealtimeChannelManager`: subscribe/unsubscribe, status events, routing, network/visibility hooks, reconnection/backoff, health checks.
  - `ClassRealTimeController`: construction, initialization, per-channel subscribe, status transitions, broadcast summaries, connection status snapshots, lifecycle close.
  - `OfficeHoursRealTimeController`: global channels, per-request and per-queue channels, status transitions, broadcast summaries.
  - Providers `CourseControllerProvider` and `OfficeHoursControllerProvider`: mount/init and cleanup points.

### Scientific debugging process

We’ll collect logs from CI (production build, headless browser) to test hypotheses and converge on root cause. The approach:

1. Instrumentation-phase data we will collect

- Channel lifecycle per topic: SUBSCRIBED, CLOSED, TIMED_OUT, CHANNEL_ERROR with error payloads.
- Manager-level triggers: online/offline, focus/blur, visibilitychange, disconnectAllChannels, resubscribeToAllChannels.
- Reconnection details: backoff delays, attempts, stuck-channel detection, resubscribe outcomes.
- Session state for realtime: getSession result, token set events.
- Broadcast meta: type/table/op summaries to ensure traffic is flowing post-connect (not a blocker for connectivity but confirms end-to-end).
- Provider lifecycle: mount/unmount logs to detect premature cleanup in headless environments.
- Periodic “status snapshot” logs reporting overall=connected|partial|disconnected and each channel’s state.

2. Hypotheses to test (with expected signatures)

- Headless environment triggers visibility/blur/offline events that prompt manager to disconnect: expect logs showing `offline` or `disconnectAllChannels` near CLOSED transitions.
- Immediate cleanup after subscribe due to provider lifecycle: expect provider cleanup log right after subscribe logs.
- Auth policy rejection: expect lack of SUBSCRIBED and CHANNEL_ERROR with an error; no CLOSED from our side.
- Phoenix/socket instability: repeated TIMED_OUT followed by reconnection attempts; verify backoff and eventual SUBSCRIBED or persistent error.

3. Evaluation method in CI

- Run E2E with `NEXT_PUBLIC_DEBUG_LOG=1` set in the test environment so logs are emitted.
- Parse CI logs for sequences per channel topic:
  - SUBSCRIBED → CLOSED patterns and the preceding manager/provider events.
  - Any `offline`/`visibilitychange`/`disconnectAllChannels` timestamps correlating with state flips.
  - Presence or absence of CHANNEL_ERROR messages and their payloads.
- Inspect final status snapshots to confirm whether all required channels (class:user, class:staff when applicable, help_queues in office hours) stabilized to `joined`.

4. Decision rules for next change after data collection

- If CLOSED events correlate with our manager’s `offline` or `disconnectAllChannels`, we will gate those in headless/CI (e.g., ignore blur/visibility in CI or add debounce before disconnect).
- If provider cleanup fires spuriously, we will guard providers to initialize once and close strictly on true unmount.
- If errors are server-side (CHANNEL_ERROR), we will inspect RLS and auth function inputs (class_id, profile_id) as logged.
- If reconnection loops persist, we’ll tune backoff and add a debounce on the overall status calculation to avoid transient red states.

### How to read logs

- All lines are prefixed with ISO timestamp and a scope, e.g.:
  - `[2025-08-10T12:34:56.789Z] [INFO] [ClassRealTimeController] subscribed { channel: 'class:34:user:…' }`
  - `[2025-08-10T12:34:56.800Z] [WARN] [RealtimeChannelManager] offline event detected; notifying subscriptions as CLOSED`
- Look for `status` snapshots emitted by `ClassRealTimeController` with per-channel states.

### CI knobs

- Ensure `NEXT_PUBLIC_DEBUG_LOG=1` is set for E2E jobs to maximize log output.

### Risk

- Logging only; functional behavior unchanged. Minimal performance overhead due to conditional logging.

### Rollback

- Revert this branch to remove logging.
