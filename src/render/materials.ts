import * as THREE from 'three';
import { MATERIAL_COUNT } from '../world/gen/ChunkData';
import { makeMaterialTexture } from './textures';

/** One shared Lambert material per world material id (textures are generated once). */
export class MaterialLibrary {
  readonly materials: THREE.MeshLambertMaterial[] = [];

  constructor(anisotropy: number) {
    for (let i = 0; i < MATERIAL_COUNT; i++) {
      this.materials.push(
        new THREE.MeshLambertMaterial({
          map: makeMaterialTexture(i, anisotropy),
          vertexColors: true,
        }),
      );
    }
  }

  get(id: number): THREE.MeshLambertMaterial {
    return this.materials[id] ?? this.materials[0];
  }

  dispose(): void {
    for (const m of this.materials) {
      m.map?.dispose();
      m.dispose();
    }
  }
}
