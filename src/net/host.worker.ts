/// <reference lib="webworker" />
import type { GameParams } from '../core/urlParams';
import type { SaveData } from '../sim/save';
import { generateChunk } from '../world/gen/generateChunk';
import { WorkerChunkSource } from '../world/WorkerChunkSource';
import { PortTransport } from './Transport';
import { ServerGame } from './ServerGame';

/** Messages from the host tab. */
export type HostWorkerMsg =
  | { type: 'start'; params: GameParams; save: SaveData | null }
  | { type: 'connect'; port: MessagePort }
  | { type: 'save'; id: number; explored: number[]; manual: boolean }
  | { type: 'stop' };

/** Replies to the host tab. */
export type HostWorkerReply = { type: 'saved'; id: number; save: SaveData | null; error: string | null };

/**
 * The host's authoritative game, off the main thread: it keeps running at full rate even when
 * the host's tab is in the background (where the page itself gets throttled).
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
let server: ServerGame | null = null;
let timer = 0;

scope.onmessage = (e: MessageEvent<HostWorkerMsg>) => {
  const msg = e.data;
  if (msg.type === 'start' && !server) {
    server = new ServerGame(msg.params, new WorkerChunkSource(msg.params.seed, 'city', generateChunk), undefined, msg.save);
    const s = server;
    // Ticks are paced by the fixed loop; poll often so they run close to on time.
    timer = setInterval(() => {
      try {
        s.update(performance.now() / 1000);
      } catch (err) {
        // Keep the game running for everyone; report what went wrong.
        console.error('host tick failed', (err as Error)?.stack ?? err);
      }
    }, 4) as unknown as number;
  } else if (msg.type === 'connect' && server) {
    server.connect(new PortTransport(msg.port));
  } else if (msg.type === 'save') {
    const r = server ? server.save(msg.explored, msg.manual) : 'The game is not running.';
    const reply: HostWorkerReply = typeof r === 'string' ? { type: 'saved', id: msg.id, save: null, error: r } : { type: 'saved', id: msg.id, save: r, error: null };
    scope.postMessage(reply);
  } else if (msg.type === 'stop') {
    clearInterval(timer);
    server?.dispose();
    server = null;
    scope.close();
  }
};
