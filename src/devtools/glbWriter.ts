/** Minimal glTF 2.0 binary writer (enough for the placeholder character: meshes, a skin, clips). */

const FLOAT = 5126;
const UBYTE = 5121;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

type AccessorType = 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4';
const WIDTH: Record<AccessorType, number> = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };

export class GlbBuilder {
  readonly json: Record<string, any> = {
    asset: { version: '2.0', generator: 'owcs placeholder character' },
    scene: 0,
    scenes: [{ nodes: [] as number[] }],
    nodes: [],
    meshes: [],
    materials: [],
    skins: [],
    animations: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  private chunks: Uint8Array[] = [];
  private length = 0;

  private view(data: ArrayBufferView, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.chunks.push(bytes);
    const view: Record<string, number> = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.length += bytes.byteLength;
    return this.json.bufferViews.push(view) - 1;
  }

  /** Add an accessor; `minMax` records per-component bounds (required for positions and times). */
  accessor(data: Float32Array | Uint16Array | Uint8Array, type: AccessorType, opts: { minMax?: boolean; target?: 'vertex' | 'index' } = {}): number {
    const componentType = data instanceof Float32Array ? FLOAT : data instanceof Uint16Array ? USHORT : UBYTE;
    const target = opts.target === 'vertex' ? ARRAY_BUFFER : opts.target === 'index' ? ELEMENT_ARRAY_BUFFER : undefined;
    const w = WIDTH[type];
    const acc: Record<string, unknown> = { bufferView: this.view(data, target), componentType, count: data.length / w, type };
    if (opts.minMax) {
      const min = new Array<number>(w).fill(Infinity);
      const max = new Array<number>(w).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        min[i % w] = Math.min(min[i % w], data[i]);
        max[i % w] = Math.max(max[i % w], data[i]);
      }
      acc.min = min;
      acc.max = max;
    }
    return this.json.accessors.push(acc) - 1;
  }

  node(n: Record<string, unknown>): number {
    return this.json.nodes.push(n) - 1;
  }

  finish(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.json.buffers[0].byteLength = this.length;
    for (const k of ['meshes', 'materials', 'skins', 'animations'] as const) if (!this.json[k].length) delete this.json[k];
    let text = new TextEncoder().encode(JSON.stringify(this.json));
    const jsonPad = (4 - (text.length % 4)) % 4;
    if (jsonPad) {
      const padded = new Uint8Array(text.length + jsonPad).fill(0x20);
      padded.set(text);
      text = padded;
    }
    const total = 12 + 8 + text.length + 8 + this.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, text.length, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    let o = 20 + text.length;
    dv.setUint32(o, this.length, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    o += 8;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}
