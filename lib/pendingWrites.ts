// Writes a document has to stay alive for, which `reloadOnceReachable` waits out before it reloads. Only
// what's passed to `trackPendingWrite` counts: today that's the survey page's autosave chain as it
// unmounts, and its Complete. Any other request in flight, in any other page, isn't known here.
const pendingWrites = new Set<Promise<void>>();

/** The write's own caller handles its failure. A failed write isn't pending, so here it only counts as over. */
export function trackPendingWrite(write: PromiseLike<unknown>): void {
  const finished = () => {
    pendingWrites.delete(tracked);
  };
  const tracked: Promise<void> = Promise.resolve(write).then(finished, finished);
  pendingWrites.add(tracked);
}

/** Resolves once none is left, including any tracked during the wait. Never rejects, and may never resolve. */
export async function pendingWritesSettled(): Promise<void> {
  while (pendingWrites.size > 0) await Promise.all(pendingWrites);
}
