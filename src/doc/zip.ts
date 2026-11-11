// Store-only ZIP (no compression), spec 8.6.3: a hand-written writer and reader, so a .athanor file opens in any unzip tool and
// import validates every size and CRC. shortcut: no ZIP64 and no compression, so a single entry is limited to 4 GiB and files are large.
import { crc32 } from './crc32';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;
// Fixed DOS date 2026-01-01 00:00 keeps archives reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export interface ZipEntry { name: string; data: Uint8Array }

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const names = entries.map((e) => enc.encode(e.name));
  let size = 22;
  entries.forEach((e, i) => { size += 30 + names[i].length + e.data.length + 46 + names[i].length; });
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let off = 0;
  const offsets: number[] = [];
  entries.forEach((e, i) => {
    offsets.push(off);
    const crc = crc32(e.data);
    v.setUint32(off, LOCAL, true);
    v.setUint16(off + 4, 20, true);
    v.setUint16(off + 6, UTF8, true);
    v.setUint16(off + 8, 0, true); // method: stored
    v.setUint16(off + 10, DOS_TIME, true);
    v.setUint16(off + 12, DOS_DATE, true);
    v.setUint32(off + 14, crc, true);
    v.setUint32(off + 18, e.data.length, true);
    v.setUint32(off + 22, e.data.length, true);
    v.setUint16(off + 26, names[i].length, true);
    v.setUint16(off + 28, 0, true);
    out.set(names[i], off + 30);
    out.set(e.data, off + 30 + names[i].length);
    off += 30 + names[i].length + e.data.length;
  });
  const cdStart = off;
  entries.forEach((e, i) => {
    v.setUint32(off, CENTRAL, true);
    v.setUint16(off + 4, 20, true);
    v.setUint16(off + 6, 20, true);
    v.setUint16(off + 8, UTF8, true);
    v.setUint16(off + 10, 0, true);
    v.setUint16(off + 12, DOS_TIME, true);
    v.setUint16(off + 14, DOS_DATE, true);
    v.setUint32(off + 16, crc32(e.data), true);
    v.setUint32(off + 20, e.data.length, true);
    v.setUint32(off + 24, e.data.length, true);
    v.setUint16(off + 28, names[i].length, true);
    v.setUint32(off + 42, offsets[i], true);
    out.set(names[i], off + 46);
    off += 46 + names[i].length;
  });
  v.setUint32(off, END, true);
  v.setUint16(off + 8, entries.length, true);
  v.setUint16(off + 10, entries.length, true);
  v.setUint32(off + 12, off - cdStart, true);
  v.setUint32(off + 16, cdStart, true);
  return out;
}

export class ZipError extends Error {}

/** Reads every entry, rejecting anything this reader does not fully understand: compression, encryption, ZIP64, bad sizes or CRCs. */
export function unzip(bytes: Uint8Array, limits: { maxEntries?: number; maxEntryBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 4096;
  const maxBytes = limits.maxEntryBytes ?? 512 * 1024 * 1024;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === END) { end = i; break; }
  }
  if (end < 0) throw new ZipError('not a ZIP file');
  const count = v.getUint16(end + 10, true);
  const cdSize = v.getUint32(end + 12, true);
  const cdStart = v.getUint32(end + 16, true);
  if (count === 0xffff || cdStart === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
  if (count > maxEntries) throw new ZipError('too many entries');
  if (cdStart + cdSize > end) throw new ZipError('corrupt central directory');
  const out: ZipEntry[] = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || v.getUint32(p, true) !== CENTRAL) throw new ZipError('corrupt central directory');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    if (flags & 1) throw new ZipError('encrypted entries are not supported');
    if (method !== 0) throw new ZipError('compressed entries are not supported');
    if (csize !== usize || usize > maxBytes) throw new ZipError('entry size is invalid');
    if (p + 46 + nlen > end) throw new ZipError('corrupt central directory');
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (lho + 30 > cdStart || v.getUint32(lho, true) !== LOCAL) throw new ZipError(`entry ${name}: bad local header`);
    const dataStart = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    if (dataStart + usize > cdStart) throw new ZipError(`entry ${name}: data runs past the archive`);
    const data = bytes.slice(dataStart, dataStart + usize);
    if (crc32(data) !== crc) throw new ZipError(`entry ${name}: CRC mismatch`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
