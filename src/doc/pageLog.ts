// Page log, spec 8.6.2: an append-only sequence of CRC-checked segments that rebuilds a page's committed store exactly
// (same ids, same z-order, same tombstones). A snapshot is the same format holding every shape in one COMMIT plus the dead ids.
// shortcut: history groups are not persisted (the u32 group id is always 0) and there is no BG segment until backgrounds exist.
import { packShapeBatch, unpackBatch, type Shape } from '../render/batch';
import type { CommittedStore } from '../render/committed';
import { crc32 } from './crc32';

export const MAGIC = 0x4c485441; // "ATHL" little-endian
export const VERSION = 1;
export const HEADER_BYTES = 20;

export const enum Kind { Commit = 1, Remove = 2, Mutate = 3, Clear = 4, Revive = 6 }

export interface PageHeader { width: number; height: number; background: number }

export type Segment =
  | { kind: Kind.Commit; shapes: Shape[] }
  | { kind: Kind.Remove | Kind.Clear | Kind.Revive; ids: number[] }
  | { kind: Kind.Mutate; id: number; shape: Shape };

export function encodeHeader(h: PageHeader): Uint8Array {
  const b = new Uint8Array(HEADER_BYTES);
  const v = new DataView(b.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint16(4, VERSION, true);
  v.setUint16(6, 0, true); // flags
  v.setUint32(8, h.width, true);
  v.setUint32(12, h.height, true);
  v.setUint32(16, h.background, true);
  return b;
}

/** Header, or null when the bytes are not a page log of a version this build understands. */
export function decodeHeader(b: Uint8Array): PageHeader | null {
  if (b.length < HEADER_BYTES) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(0, true) !== MAGIC || v.getUint16(4, true) !== VERSION) return null;
  return { width: v.getUint32(8, true), height: v.getUint32(12, true), background: v.getUint32(16, true) };
}

const idsPayload = (ids: readonly number[]): Uint8Array => {
  const b = new Uint8Array(4 + 4 * ids.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, ids.length, true);
  ids.forEach((id, i) => v.setUint32(4 + 4 * i, id, true));
  return b;
};

/** One segment: u32 byteLength (of kind + payload) | u32 crc32 (of kind + payload) | u8 kind | payload. */
export function encodeSegment(s: Segment): Uint8Array {
  let payload: Uint8Array;
  if (s.kind === Kind.Commit) {
    const batch = new Uint8Array(packShapeBatch(s.shapes));
    payload = new Uint8Array(batch.length + 4); // trailing u32: history group id, always 0 here
    payload.set(batch);
  } else if (s.kind === Kind.Mutate) {
    const batch = new Uint8Array(packShapeBatch([s.shape]));
    payload = new Uint8Array(4 + batch.length);
    new DataView(payload.buffer).setUint32(0, s.id, true);
    payload.set(batch, 4);
  } else payload = idsPayload(s.ids);
  const out = new Uint8Array(9 + payload.length);
  out[8] = s.kind;
  out.set(payload, 9);
  const body = out.subarray(8);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length, true);
  v.setUint32(4, crc32(body), true);
  return out;
}

/** A buffer that owns its bytes at offset 0: CommitBatch views need 4-byte alignment. */
const own = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

function decodeIds(p: Uint8Array): number[] | null {
  if (p.length < 4) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const n = v.getUint32(0, true);
  if (p.length !== 4 + 4 * n) return null;
  return Array.from({ length: n }, (_, i) => v.getUint32(4 + 4 * i, true));
}

export interface DecodedSegments {
  segments: Segment[];
  /** Offset just past the last good segment; a torn tail beyond it is discarded (8.6.2 crash safety). */
  validBytes: number;
}

/** Reads segments from `start` until the first length, CRC or content mismatch. */
export function decodeSegments(bytes: Uint8Array, start = 0): DecodedSegments {
  const segments: Segment[] = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = start;
  while (off + 9 <= bytes.length) {
    const len = v.getUint32(off, true);
    if (len < 1 || off + 8 + len > bytes.length) break; // torn: the length runs past the data
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (crc32(body) !== v.getUint32(off + 4, true)) break;
    const kind = body[0] as Kind;
    const payload = body.subarray(1);
    let seg: Segment | null = null;
    try {
      if (kind === Kind.Commit) seg = payload.length >= 4 ? { kind, shapes: unpackBatch(own(payload.subarray(0, payload.length - 4))) } : null;
      else if (kind === Kind.Mutate) {
        const shapes = payload.length > 4 ? unpackBatch(own(payload.subarray(4))) : [];
        seg = shapes.length === 1 ? { kind, id: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true), shape: shapes[0] } : null;
      } else if (kind === Kind.Remove || kind === Kind.Clear || kind === Kind.Revive) {
        const ids = decodeIds(payload);
        seg = ids ? { kind, ids } : null;
      }
    } catch {
      seg = null; // a structurally bad batch inside a good CRC: treat like corruption and stop here
    }
    if (!seg) break;
    segments.push(seg);
    off += 8 + len;
  }
  return { segments, validBytes: off };
}

export interface Decoded extends DecodedSegments {
  header: PageHeader;
}

/** Header plus segments. Null if the header itself is bad. */
export function decodeLog(bytes: Uint8Array): Decoded | null {
  const header = decodeHeader(bytes);
  return header ? { header, ...decodeSegments(bytes, HEADER_BYTES) } : null;
}

/** Replays segments onto a store so it matches the page as it was saved. */
export function applySegments(store: CommittedStore, segments: readonly Segment[]): void {
  for (const s of segments) {
    switch (s.kind) {
      case Kind.Commit:
        for (const sh of s.shapes) store.add(sh);
        break;
      case Kind.Remove:
      case Kind.Clear:
        for (const id of s.ids) store.remove(id);
        break;
      case Kind.Revive:
        for (const id of s.ids) store.revive(id);
        break;
      case Kind.Mutate:
        if (s.id < store.entries.length) store.replaceShape(s.id, s.shape);
        break;
    }
  }
}

/** A snapshot of the whole store: every shape (dead ones too, so ids stay stable) plus the dead ids. */
export function encodeSnapshot(store: CommittedStore, header: PageHeader): Uint8Array {
  const parts: Uint8Array[] = [encodeHeader(header)];
  const shapes = store.entries.map((e) => e.shape);
  if (shapes.length > 0) parts.push(encodeSegment({ kind: Kind.Commit, shapes }));
  const dead: number[] = [];
  store.entries.forEach((e, id) => { if (!e.alive) dead.push(id); });
  if (dead.length > 0) parts.push(encodeSegment({ kind: Kind.Remove, ids: dead }));
  return concat(parts);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
