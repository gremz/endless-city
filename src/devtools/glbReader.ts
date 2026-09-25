/** Minimal glTF 2.0 binary reader: the triangles of every mesh, flattened, with their material. */

export interface GlbTriangles {
  /** One entry per primitive (triangle lists only). */
  primitives: {
    material: { name: string; color: [number, number, number] };
    positions: Float32Array;
    normals: Float32Array | null;
    indices: Uint32Array;
  }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Reads the meshes of a .glb (node transforms are ignored: export with transforms applied). */
export function readGlbTriangles(bytes: Uint8Array): GlbTriangles {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a .glb file');
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const binLen = view.getUint32(20 + jsonLen, true);
  const bin = bytes.subarray(binStart, binStart + binLen);

  const read = (index: number): Float32Array | Uint32Array => {
    const acc = json.accessors[index];
    const bv = json.bufferViews[acc.bufferView];
    const width = COMPONENTS[acc.type];
    const offset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const count = acc.count * width;
    const src = new DataView(bin.buffer, bin.byteOffset + offset);
    const stride = bv.byteStride;
    if (acc.componentType === 5126) {
      const out = new Float32Array(count);
      for (let i = 0; i < acc.count; i++) for (let c = 0; c < width; c++) out[i * width + c] = src.getFloat32((stride ?? width * 4) * i + c * 4, true);
      return out;
    }
    const size = acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = size === 4 ? src.getUint32(i * 4, true) : size === 2 ? src.getUint16(i * 2, true) : src.getUint8(i);
    return out;
  };

  const primitives: GlbTriangles['primitives'] = [];
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const m = p.material !== undefined ? json.materials[p.material] : undefined;
      const c = m?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
      const positions = read(p.attributes.POSITION) as Float32Array;
      primitives.push({
        material: { name: m?.name ?? '', color: [c[0], c[1], c[2]] },
        positions,
        normals: p.attributes.NORMAL !== undefined ? (read(p.attributes.NORMAL) as Float32Array) : null,
        indices: p.indices !== undefined ? (read(p.indices) as Uint32Array) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
      });
    }
  }
  return { primitives };
}
