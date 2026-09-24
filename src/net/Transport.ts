/** Payloads are JSON strings (reliable messages) or ArrayBuffers (commands, snapshots). */
export type Payload = string | ArrayBuffer;

/**
 * A two-way message pipe between a client and the host. `reliable` sends are delivered in order;
 * unreliable sends may be dropped or reordered (snapshots, commands), when the link supports it.
 */
export interface Transport {
  send(data: Payload, reliable: boolean): void;
  onMessage: ((data: Payload, reliable: boolean) => void) | null;
  onClose: ((reason: string) => void) | null;
  close(): void;
  readonly closed: boolean;
}

/** In-process pair (tests): whatever one end sends, the other receives synchronously. */
export class LoopbackTransport implements Transport {
  onMessage: ((data: Payload, reliable: boolean) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  closed = false;
  peer!: LoopbackTransport;
  /** Drop this fraction of unreliable sends (0..1), using `rand`. */
  loss = 0;
  /** Hold back this fraction of unreliable sends until after the next one (reordering). */
  reorder = 0;
  rand = Math.random;
  sent = 0;
  private held: Payload | null = null;

  static pair(): [LoopbackTransport, LoopbackTransport] {
    const a = new LoopbackTransport();
    const b = new LoopbackTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data: Payload, reliable: boolean): void {
    if (this.closed) return;
    this.sent++;
    if (!reliable && this.loss > 0 && this.rand() < this.loss) return;
    const copy = data instanceof ArrayBuffer ? data.slice(0) : data;
    if (!reliable && this.reorder > 0) {
      if (this.held === null && this.rand() < this.reorder) {
        this.held = copy;
        return;
      }
      this.peer.onMessage?.(copy, false);
      if (this.held !== null) {
        const late = this.held;
        this.held = null;
        this.peer.onMessage?.(late, false);
      }
      return;
    }
    this.peer.onMessage?.(copy, reliable);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.('closed');
    this.peer.close();
  }
}

interface PortMessage {
  d?: Payload;
  r?: boolean;
  bye?: string;
}

/** One end of a MessageChannel (host tab ↔ host worker). */
export class PortTransport implements Transport {
  onMessage: ((data: Payload, reliable: boolean) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  closed = false;

  constructor(private port: MessagePort) {
    port.onmessage = (e: MessageEvent<PortMessage>) => {
      const m = e.data;
      if (m.bye !== undefined) this.shut(m.bye, false);
      else if (m.d !== undefined) this.onMessage?.(m.d, !!m.r);
    };
    port.start();
  }

  send(data: Payload, reliable: boolean): void {
    if (this.closed) return;
    const msg: PortMessage = { d: data, r: reliable };
    if (data instanceof ArrayBuffer) this.port.postMessage(msg, [data]);
    else this.port.postMessage(msg);
  }

  close(reason = 'closed'): void {
    this.shut(reason, true);
  }

  private shut(reason: string, tell: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (tell) this.port.postMessage({ bye: reason } satisfies PortMessage);
    this.port.close();
    this.onClose?.(reason);
  }
}

/** Connect two transports back to back (the host tab relays a remote peer to the worker). */
export function pipe(a: Transport, b: Transport): void {
  a.onMessage = (d, r) => b.send(d, r);
  b.onMessage = (d, r) => a.send(d, r);
  a.onClose = () => b.close();
  b.onClose = () => a.close();
}
