// CommitBatch: one ArrayBuffer of [u32 count][header(24 x i32) | cmd bytes padded to 4 | vtx f32 pairs]..., spec 3.2.4.
import { F_GRADIENT, H, HDR_STRIDE, type ActiveArena } from '../core/arena';

const pad4 = (n: number): number => Math.ceil(n / 4) * 4; // not bitwise: a corrupt count near 2^31 must not wrap negative

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

/** Packs committed shapes into a batch, translated by (dx, dy): a Repeat clone on its way to the main thread. */
export function packShapeBatch(shapes: readonly Shape[], dx = 0, dy = 0): ArrayBuffer {
  let bytes = 4;
  for (const s of shapes) bytes += HDR_STRIDE * 4 + pad4(s.cmd.length) + s.vtx.length * 4;
  const buf = new ArrayBuffer(bytes);
  new Uint32Array(buf, 0, 1)[0] = shapes.length;
  let off = 4;
  for (const s of shapes) {
    const hdr = new Int32Array(buf, off, HDR_STRIDE);
    const hdrF = new Float32Array(buf, off, HDR_STRIDE);
    hdr.set(s.hdr);
    hdr[H.VTX_COUNT] = s.vtx.length / 2;
    hdr[H.CMD_COUNT] = s.cmd.length;
    hdrF[H.BB_MIN_X] += dx; hdrF[H.BB_MAX_X] += dx; hdrF[H.BB_MIN_Y] += dy; hdrF[H.BB_MAX_Y] += dy;
    if (hdr[H.FLAGS] & F_GRADIENT) { hdrF[H.GX1] += dx; hdrF[H.GX2] += dx; hdrF[H.GY1] += dy; hdrF[H.GY2] += dy; }
    off += HDR_STRIDE * 4;
    new Uint8Array(buf, off, s.cmd.length).set(s.cmd);
    off += pad4(s.cmd.length);
    const v = new Float32Array(buf, off, s.vtx.length);
    for (let i = 0; i < v.length; i += 2) { v[i] = s.vtx[i] + dx; v[i + 1] = s.vtx[i + 1] + dy; }
    off += s.vtx.length * 4;
  }
  return buf;
}

/** Zero-copy views over the batch buffer. */
export function unpackBatch(buf: ArrayBuffer): Shape[] {
  const fail = (what: string): never => {
    throw new RangeError(`corrupt CommitBatch: ${what}`);
  };
  if (buf.byteLength < 4) fail('shorter than its count word');
  const n = new Uint32Array(buf, 0, 1)[0];
  const out: Shape[] = [];
  let off = 4;
  for (let i = 0; i < n; i++) {
    if (off + HDR_STRIDE * 4 > buf.byteLength) fail(`record ${i} header is truncated`);
    const hdr = new Int32Array(buf, off, HDR_STRIDE);
    const hdrF = new Float32Array(buf, off, HDR_STRIDE);
    off += HDR_STRIDE * 4;
    const cmdN = hdr[H.CMD_COUNT];
    const vtxN = hdr[H.VTX_COUNT];
    if (cmdN < 0 || vtxN < 0 || off + pad4(cmdN) + vtxN * 8 > buf.byteLength) fail(`record ${i} body is truncated`);
    const cmd = new Uint8Array(buf, off, cmdN);
    off += pad4(cmdN);
    const vtx = new Float32Array(buf, off, 2 * vtxN);
    off += vtxN * 8;
    out.push({ hdr, hdrF, cmd, vtx });
  }
  return out;
}
