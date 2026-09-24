import { copyCmd, type UserCmd } from '../input/UserCmd';
import type { BuyItem } from '../weapons/weaponDefs';
import {
  Bin,
  binKind,
  CMD_REDUNDANCY,
  decodeSnapshot,
  encodeCmds,
  PROTOCOL_VERSION,
  type NetParams,
  type SeqCmd,
  type ServerMsg,
  type Snapshot,
} from './protocol';
import type { Payload, Transport } from './Transport';

export interface Welcome {
  actorId: number;
  params: NetParams;
}

/**
 * A client's connection to the host: sends hello, commands and requests; collects the host's
 * messages and the newest snapshot for the game to apply once per frame. DOM-free.
 */
export class NetClient {
  actorId = -1;
  params: NetParams | null = null;
  /** Why the connection ended (rejected, host left...), or null while connected. */
  closedReason: string | null = null;
  private seq = 0;
  private recent: SeqCmd[] = [];
  private inbox: ServerMsg[] = [];
  private snapshot: Snapshot | null = null;
  /** Newest snapshot tick received (older ones arriving late are dropped). */
  lastTick = 0;
  /** Sequence of the newest command sent. */
  get cmdSeq(): number {
    return this.seq;
  }
  // Stats for the debug overlay.
  snapshotsIn = 0;
  bytesIn = 0;
  bytesOut = 0;
  /** Round trip in ms: command sent → snapshot acknowledging it (smoothed). */
  rtt = 0;
  private sentAt = new Float64Array(256);
  private waiters: { resolve: (w: Welcome) => void; reject: (e: Error) => void }[] = [];

  constructor(
    private transport: Transport,
    readonly name: string,
    autoBhop: boolean,
  ) {
    transport.onMessage = (d) => this.receive(d);
    transport.onClose = (reason) => this.onClosed(reason || 'Connection closed');
    this.sendJson({ t: 'hello', name, version: PROTOCOL_VERSION, autoBhop });
  }

  get connected(): boolean {
    return this.closedReason === null;
  }

  /** Resolves once the host accepts us, rejects if it refuses or the link drops. */
  welcome(): Promise<Welcome> {
    if (this.params) return Promise.resolve({ actorId: this.actorId, params: this.params });
    if (this.closedReason) return Promise.reject(new Error(this.closedReason));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /**
   * Send this tick's input (with the previous few again, in case packets are lost). `viewTime`
   * is the host time others are drawn at here. Returns the command's sequence number.
   */
  sendCmd(cmd: UserCmd, viewTime = 0): number {
    if (!this.connected) return this.seq;
    this.seq++;
    this.recent.push({ seq: this.seq, cmd: copyCmd(cmd) });
    if (this.recent.length > CMD_REDUNDANCY) this.recent.shift();
    this.sentAt[this.seq & 255] = performance.now();
    const buf = encodeCmds({ ackSnapshot: this.lastTick, viewTime, cmds: this.recent });
    this.bytesOut += buf.byteLength;
    this.transport.send(buf, false);
    return this.seq;
  }

  sendBuy(item: BuyItem): void {
    this.sendJson({ t: 'buy', item });
  }

  sendChat(text: string): void {
    this.sendJson({ t: 'chat', text });
  }

  /** Reliable messages received since the last call, in order. */
  takeMessages(): ServerMsg[] {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }

  /** The newest snapshot not yet taken, if any. */
  takeSnapshot(): Snapshot | null {
    const s = this.snapshot;
    this.snapshot = null;
    return s;
  }

  close(): void {
    this.transport.close();
  }

  private sendJson(msg: unknown): void {
    if (!this.connected) return;
    const json = JSON.stringify(msg);
    this.bytesOut += json.length;
    this.transport.send(json, true);
  }

  private receive(data: Payload): void {
    if (data instanceof ArrayBuffer) {
      this.bytesIn += data.byteLength;
      if (binKind(data) !== Bin.Snapshot) return;
      const s = decodeSnapshot(data);
      if (s.tick <= this.lastTick) return;
      this.lastTick = s.tick;
      this.snapshot = s;
      this.snapshotsIn++;
      if (s.ackCmd > 0 && this.seq - s.ackCmd < 256) {
        const rtt = performance.now() - this.sentAt[s.ackCmd & 255];
        this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.1 : rtt;
      }
      return;
    }
    this.bytesIn += data.length;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data) as ServerMsg;
    } catch {
      return;
    }
    if (msg.t === 'welcome') {
      this.actorId = msg.actorId;
      this.params = msg.params;
      for (const w of this.waiters.splice(0)) w.resolve({ actorId: msg.actorId, params: msg.params });
      return;
    }
    if (msg.t === 'reject') {
      this.onClosed(msg.reason);
      return;
    }
    this.inbox.push(msg);
  }

  private onClosed(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const w of this.waiters.splice(0)) w.reject(new Error(reason));
  }
}
