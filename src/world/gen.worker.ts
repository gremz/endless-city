/// <reference lib="webworker" />
import { transferList } from './gen/ChunkData';
import { generateChunk } from './gen/generateChunk';
import { generateGymChunk } from './gen/gymGen';

export interface GenRequest {
  id: number;
  seed: number;
  cx: number;
  cz: number;
  kind: 'city' | 'gym';
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<GenRequest>) => {
  const { id, seed, cx, cz, kind } = e.data;
  try {
    const data = kind === 'gym' ? generateGymChunk(seed, cx, cz) : generateChunk(seed, cx, cz);
    scope.postMessage({ id, data }, { transfer: transferList(data) });
  } catch (err) {
    scope.postMessage({ id, error: String((err as Error)?.stack ?? err), cx, cz });
  }
};
