/**
 * In-memory BroadcastChannel polyfill for jsdom, which lacks native BroadcastChannel.
 * Maintains a static registry so instances with the same channel name can communicate.
 *
 * Features:
 * - `_closed` tracking: closed channels ignore postMessage and don't receive
 * - `addEventListener`/`removeEventListener`/`dispatchEvent` stubs for spec completeness
 * - Static `_registry` exposed for tests that need direct registry access
 */

type MessageHandler = ((event: { data: unknown }) => void) | null;

const registry = new Map<string, Set<MockBroadcastChannel>>();

export class MockBroadcastChannel {
  /** Exposed for tests that need direct registry access (e.g. leader-election). */
  static _registry = registry;

  readonly name: string;
  onmessage: MessageHandler = null;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    if (!registry.has(name)) {
      registry.set(name, new Set());
    }
    registry.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;
    const peers = registry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && !(peer as any)._closed && peer.onmessage) {
        peer.onmessage({ data: JSON.parse(JSON.stringify(data)) });
      }
    }
  }

  close(): void {
    this._closed = true;
    const peers = registry.get(this.name);
    if (peers) {
      peers.delete(this);
      if (peers.size === 0) {
        registry.delete(this.name);
      }
    }
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
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
