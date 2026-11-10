// CommitBatch: one ArrayBuffer of [u32 count][header(24 x i32) | cmd bytes padded to 4 | vtx f32 pairs]..., spec 3.2.4.
import { H, HDR_STRIDE, type ActiveArena } from '../core/arena';

const pad4 = (n: number): number => (n + 3) & ~3;

export interface Shape {
  hdr: Int32Array;
  hdrF: Float32Array;
  cmd: Uint8Array;
  vtx: Float32Array;
}

export function packBatch(a: ActiveArena, recs: Int32Array, n: number): ArrayBuffer {
  let bytes = 4;
  for (let i = 0; i < n; i++) {
    const b = recs[i] * HDR_STRIDE;
    bytes += HDR_STRIDE * 4 + pad4(a.hdr[b + H.CMD_COUNT]) + a.hdr[b + H.VTX_COUNT] * 8;
  }
  const buf = new ArrayBuffer(bytes);
  new Uint32Array(buf, 0, 1)[0] = n;
  let off = 4;
  for (let i = 0; i < n; i++) {
    const b = recs[i] * HDR_STRIDE;
    const cmdN = a.hdr[b + H.CMD_COUNT];
    const vtxN = a.hdr[b + H.VTX_COUNT];
    const hdr = new Int32Array(buf, off, HDR_STRIDE);
    hdr.set(a.hdr.subarray(b, b + HDR_STRIDE));
    hdr[H.VTX_OFF] = 0; // offsets are positional inside a batch
    hdr[H.CMD_OFF] = 0;
    off += HDR_STRIDE * 4;
    const cmdOff = a.hdr[b + H.CMD_OFF];
    new Uint8Array(buf, off, cmdN).set(a.cmd.subarray(cmdOff, cmdOff + cmdN));
    off += pad4(cmdN);
    const vo = 2 * a.hdr[b + H.VTX_OFF];
    new Float32Array(buf, off, 2 * vtxN).set(a.vtx.subarray(vo, vo + 2 * vtxN));
    off += vtxN * 8;
  }
  return buf;
}

/** Zero-copy views over the batch buffer. */
export function unpackBatch(buf: ArrayBuffer): Shape[] {
  const n = new Uint32Array(buf, 0, 1)[0];
  const out: Shape[] = [];
  let off = 4;
  for (let i = 0; i < n; i++) {
    const hdr = new Int32Array(buf, off, HDR_STRIDE);
    const hdrF = new Float32Array(buf, off, HDR_STRIDE);
    off += HDR_STRIDE * 4;
    const cmdN = hdr[H.CMD_COUNT];
    const vtxN = hdr[H.VTX_COUNT];
    const cmd = new Uint8Array(buf, off, cmdN);
    off += pad4(cmdN);
    const vtx = new Float32Array(buf, off, 2 * vtxN);
    off += vtxN * 8;
    out.push({ hdr, hdrF, cmd, vtx });
  }
  return out;
}
