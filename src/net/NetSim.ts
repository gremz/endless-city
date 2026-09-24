import type { Payload, Transport } from './Transport';

/**
 * Bad-network simulator for testing (`?netsim=120,5` = 120 ms round trip, 5% of unreliable
 * packets lost): delays both directions by half the round trip plus jitter, and drops some
 * unreliable messages. Reliable messages keep their order.
 */
export class NetSimTransport implements Transport {
  onMessage: ((data: Payload, reliable: boolean) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private lastReliableOut = 0;
  private lastReliableIn = 0;

  constructor(
    private inner: Transport,
    private rttMs: number,
    private loss: number,
    private jitterMs = rttMs * 0.1,
  ) {
    inner.onMessage = (d, r) => {
      if (!r && Math.random() < this.loss) return;
      const at = this.when(r, 'in');
      setTimeout(() => this.onMessage?.(d, r), at - performance.now());
    };
    inner.onClose = (reason) => this.onClose?.(reason);
  }

  get closed(): boolean {
    return this.inner.closed;
  }

  /** Delivery time: half the round trip plus jitter; reliable messages never overtake. */
  private when(reliable: boolean, dir: 'in' | 'out'): number {
    let at = performance.now() + this.rttMs / 2 + Math.random() * this.jitterMs;
    if (reliable) {
      const last = dir === 'in' ? this.lastReliableIn : this.lastReliableOut;
      at = Math.max(at, last);
      if (dir === 'in') this.lastReliableIn = at;
      else this.lastReliableOut = at;
    }
    return at;
  }

  send(data: Payload, reliable: boolean): void {
    if (!reliable && Math.random() < this.loss) return;
    const at = this.when(reliable, 'out');
    setTimeout(() => this.inner.send(data, reliable), at - performance.now());
  }

  close(): void {
    this.inner.close();
  }
}

/** Parse `?netsim=rtt,loss%` (e.g. "120,5"), or null. */
export function netSimFromUrl(search: string): { rtt: number; loss: number } | null {
  const raw = new URLSearchParams(search).get('netsim');
  if (!raw) return null;
  const [rtt, loss] = raw.split(',').map(Number);
  if (!Number.isFinite(rtt) || rtt < 0) return null;
  return { rtt, loss: Number.isFinite(loss) ? Math.max(0, Math.min(100, loss)) / 100 : 0 };
}
