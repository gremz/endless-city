/// <reference lib="webworker" />
import { paintMaterial, type PaintedMaps } from './texturePaint';

/** Paints material textures off the main thread: receives material ids, posts back pixels. */
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<number[]>) => {
  for (const id of e.data) {
    try {
      const maps = paintMaterial(id);
      const transfer = [maps.map, maps.normalMap, maps.emissiveMap].filter((p) => !!p).map((p) => p!.data.buffer);
      scope.postMessage(maps satisfies PaintedMaps, { transfer });
    } catch (err) {
      scope.postMessage({ material: id, error: String((err as Error)?.stack ?? err) });
    }
  }
};
