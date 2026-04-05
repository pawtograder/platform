/**
 * In-memory BroadcastChannel polyfill for jsdom, which lacks native BroadcastChannel.
 * Maintains a static registry so instances with the same channel name can communicate.
 */

type MessageHandler = ((event: { data: unknown }) => void) | null;

const registry = new Map<string, Set<MockBroadcastChannel>>();

export class MockBroadcastChannel {
  readonly name: string;
  onmessage: MessageHandler = null;

  constructor(name: string) {
    this.name = name;
    if (!registry.has(name)) {
      registry.set(name, new Set());
    }
    registry.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    const peers = registry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && peer.onmessage) {
        peer.onmessage({ data });
      }
    }
  }

  close(): void {
    const peers = registry.get(this.name);
    if (peers) {
      peers.delete(this);
      if (peers.size === 0) {
        registry.delete(this.name);
      }
    }
  }
}

/** Remove all channels from the registry. Call in afterEach/afterAll for test cleanup. */
export function resetAllChannels(): void {
  registry.clear();
}

/** Assign MockBroadcastChannel to globalThis so code that references BroadcastChannel works in jsdom. */
export function setupMockBroadcastChannel(): void {
  (globalThis as Record<string, unknown>).BroadcastChannel = MockBroadcastChannel;
}
