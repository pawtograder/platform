/**
 * Giving timers a turn during a long synchronous loop.
 *
 * The exam worker holds its message on a lease that a timer renews every 5 s (examWorkerLease.ts,
 * #1158). A loop that keeps the CPU for longer than the lease, such as lining a large batch up with
 * its template (#1292), stops that timer from firing, so the lease lapses and another reader takes
 * the message. Call the returned function once per step: it waits for a 0 ms timer, letting due
 * timers run first, at most once every `everyMs`.
 */
export function timerYielder(everyMs: number, now: () => number = () => performance.now()): () => Promise<void> {
  let last = now();
  return async () => {
    if (now() - last < everyMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = now();
  };
}
