import Peer, { type DataConnection } from 'peerjs';
import type { GameParams } from '../core/urlParams';
import type { SaveData } from '../sim/save';
import type { HostWorkerMsg, HostWorkerReply } from './host.worker';
import { pipe, PortTransport, type Payload, type Transport } from './Transport';

/** Room codes are PeerJS ids on the public broker, namespaced to this game and protocol. */
const PEER_PREFIX = 'endless-city-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
/** Id of the extra, unreliable data channel both ends open on the same peer connection. */
const FAST_CHANNEL_ID = 100;

/** `?peerdebug=3` logs PeerJS signalling to the console. */
function peerOptions(): { debug: 0 | 1 | 2 | 3 } {
  const d = Number(new URLSearchParams(location.search).get('peerdebug') ?? 0);
  return { debug: (d >= 0 && d <= 3 ? d : 0) as 0 | 1 | 2 | 3 };
}

function makeCode(): string {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  for (const v of r) s += CODE_ALPHABET[v % CODE_ALPHABET.length];
  return s;
}

/** Normalise what someone typed or pasted (a code or an invite link). */
export function parseCode(input: string): string | null {
  let s = input.trim();
  const m = /[?&]join=([^&#]+)/.exec(s);
  if (m) s = decodeURIComponent(m[1]);
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === CODE_LENGTH ? s : null;
}

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?join=${code}`;
}

/**
 * A PeerJS data connection plus a second, negotiated channel with no retransmits: PeerJS'
 * own "unreliable" option still retransmits, which is the wrong trade for snapshots.
 */
class RtcTransport implements Transport {
  onMessage: ((data: Payload, reliable: boolean) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  closed = false;
  private fast: RTCDataChannel;

  constructor(private conn: DataConnection) {
    const pc = conn.peerConnection;
    this.fast = pc.createDataChannel('fast', { negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
    this.fast.binaryType = 'arraybuffer';
    this.fast.onmessage = (e: MessageEvent<Payload>) => this.onMessage?.(e.data, false);
    conn.on('data', (d) => this.onMessage?.(d as Payload, true));
    conn.on('close', () => this.shut('The game ended or the connection was lost.'));
    conn.on('error', (err) => this.shut(`Connection error: ${err.message}`));
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') this.shut('The connection was lost');
    });
  }

  send(data: Payload, reliable: boolean): void {
    if (this.closed) return;
    if (!reliable && this.fast.readyState === 'open') {
      // Don't queue stale snapshots behind a congested link.
      if (this.fast.bufferedAmount < 256 * 1024) this.fast.send(data as ArrayBuffer);
      return;
    }
    void this.conn.send(data);
  }

  close(): void {
    this.shut('closed');
  }

  private shut(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.fast.close();
      this.conn.close();
    } catch {
      /* already gone */
    }
    this.onClose?.(reason);
  }
}

function peerError(err: { type?: string; message?: string }): string {
  switch (err.type) {
    case 'peer-unavailable':
      return 'No game with that code. Check the code, or ask the host for a new one.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the matchmaking server. Check your connection and try again.';
    case 'browser-incompatible':
      return 'This browser does not support WebRTC.';
    default:
      return err.message || 'Connection failed';
  }
}

/**
 * Hosting: the authoritative game runs in a worker; the host's own game talks to it over a
 * MessageChannel, and each friend who joins is relayed to it from their WebRTC connection.
 */
export class HostSession {
  code = '';
  private peer: Peer | null = null;
  private worker: Worker;
  private remotes = new Set<Transport>();
  private saves = new Map<number, (r: HostWorkerReply) => void>();
  private saveId = 1;
  /** Called when the room code changes or the broker connection drops. */
  onStatus: ((text: string) => void) | null = null;

  /** Start the game, fresh or continuing `save`. */
  constructor(params: GameParams, save: SaveData | null = null) {
    this.worker = new Worker(new URL('./host.worker.ts', import.meta.url), { type: 'module', name: 'host' });
    this.worker.onmessage = (e: MessageEvent<HostWorkerReply>) => {
      const r = e.data;
      if (r.type !== 'saved') return;
      this.saves.get(r.id)?.(r);
      this.saves.delete(r.id);
    };
    this.worker.onerror = (e) => {
      console.error(`host game error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
    };
    this.post({ type: 'start', params, save });
  }

  /** Ask the game for a save from the host's side. Rejects with the reason it can't. */
  requestSave(explored: number[], manual: boolean): Promise<SaveData> {
    const id = this.saveId++;
    return new Promise((resolve, reject) => {
      this.saves.set(id, (r) => (r.save ? resolve(r.save) : reject(new Error(r.error ?? 'Could not save.'))));
      this.post({ type: 'save', id, explored, manual });
    });
  }

  /** The host's own connection to its game. */
  localTransport(): Transport {
    return this.attach();
  }

  /** Register with the broker under a fresh room code. Resolves with the code. */
  open(): Promise<string> {
    return new Promise((resolve, reject) => {
      const attempt = (tries: number) => {
        const code = makeCode();
        const peer = new Peer(PEER_PREFIX + code, peerOptions());
        peer.on('open', () => {
          this.peer = peer;
          this.code = code;
          resolve(code);
        });
        peer.on('connection', (conn) => this.accept(conn));
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && tries < 5) {
            peer.destroy();
            attempt(tries + 1);
          } else if (!this.peer) {
            peer.destroy();
            reject(new Error(peerError(err)));
          } else {
            this.onStatus?.(peerError(err));
          }
        });
        peer.on('disconnected', () => {
          // Lost the broker: players already in keep playing; try to be joinable again.
          this.onStatus?.('Reconnecting to the matchmaking server…');
          setTimeout(() => {
            if (!peer.destroyed) peer.reconnect();
          }, 2000);
        });
      };
      attempt(0);
    });
  }

  private accept(conn: DataConnection): void {
    conn.on('open', () => {
      const rtc = new RtcTransport(conn);
      this.remotes.add(rtc);
      const toWorker = this.attach();
      pipe(rtc, toWorker);
      const onClose = rtc.onClose;
      rtc.onClose = (r) => {
        this.remotes.delete(rtc);
        onClose?.(r);
      };
    });
  }

  private attach(): Transport {
    const ch = new MessageChannel();
    this.post({ type: 'connect', port: ch.port2 }, [ch.port2]);
    return new PortTransport(ch.port1);
  }

  private post(msg: HostWorkerMsg, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  close(): void {
    for (const r of this.remotes) r.close();
    this.remotes.clear();
    this.peer?.destroy();
    this.peer = null;
    this.post({ type: 'stop' });
  }
}

/** Joining: connect to the host's room code. Resolves with the transport once the link is up. */
export function joinSession(code: string, timeoutMs = 15000): Promise<{ transport: Transport; close: () => void }> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(peerOptions());
    let done = false;
    const fail = (msg: string) => {
      if (done) return;
      done = true;
      peer.destroy();
      reject(new Error(msg));
    };
    // First reach the broker, then give the host a while to answer.
    let timer = setTimeout(() => fail('Could not reach the matchmaking server. Check your connection and try again.'), timeoutMs);
    peer.on('error', (err) => fail(peerError(err)));
    peer.on('open', () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail('The host did not answer. Check the code and try again.'), timeoutMs);
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'raw' });
      conn.on('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const transport = new RtcTransport(conn);
        // The broker is only needed to find the host.
        peer.disconnect();
        resolve({
          transport,
          close: () => {
            transport.close();
            peer.destroy();
          },
        });
      });
      conn.on('error', (err) => fail(err.message));
    });
  });
}
