import { describe, expect, it } from 'vitest';
import { ZipError, unzip, zip } from './zip';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('store-only ZIP', () => {
  it('round-trips entries, including empty ones and non-ASCII names', () => {
    const entries = [{ name: 'manifest.json', data: bytes('{"a":1}') }, { name: 'pages/é.snap', data: new Uint8Array([1, 2, 3, 255]) }, { name: 'empty', data: new Uint8Array(0) }];
    const back = unzip(zip(entries));
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(back.map((e) => Array.from(e.data))).toEqual(entries.map((e) => Array.from(e.data)));
  });
  it('is a valid ZIP structure: local headers, central directory and end record', () => {
    const z = zip([{ name: 'a', data: bytes('hello') }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 12, true)).toBe(1); // one entry
  });
  it('is deterministic', () => {
    const e = [{ name: 'a', data: bytes('x') }];
    expect(zip(e)).toEqual(zip(e));
  });
  it('rejects a flipped byte through the CRC', () => {
    const z = zip([{ name: 'a', data: bytes('hello world') }]);
    z[30 + 1 + 3] ^= 1;
    expect(() => unzip(z)).toThrow(/CRC/);
  });
  it('rejects non-ZIP, truncated and lying archives', () => {
    expect(() => unzip(bytes('not a zip at all, just some text bytes'))).toThrow(ZipError);
    const z = zip([{ name: 'a', data: bytes('hello') }]);
    expect(() => unzip(z.subarray(0, z.length - 5))).toThrow(ZipError);
    const lie = z.slice();
    new DataView(lie.buffer).setUint32(lie.length - 22 + 16, 9999, true); // central directory offset past the end
    expect(() => unzip(lie)).toThrow(ZipError);
  });
  it('rejects compressed and encrypted entries and enforces limits', () => {
    const z = zip([{ name: 'a', data: bytes('hello') }]);
    const cdOff = new DataView(z.buffer).getUint32(z.length - 22 + 16, true);
    const compressed = z.slice(); new DataView(compressed.buffer).setUint16(cdOff + 10, 8, true);
    expect(() => unzip(compressed)).toThrow(/compressed/);
    const encrypted = z.slice(); new DataView(encrypted.buffer).setUint16(cdOff + 8, 1, true);
    expect(() => unzip(encrypted)).toThrow(/encrypted/);
    expect(() => unzip(z, { maxEntries: 0 })).toThrow(/too many/);
    expect(() => unzip(z, { maxEntryBytes: 2 })).toThrow(/size/);
  });
  it('an archive with no entries is valid', () => {
    expect(unzip(zip([]))).toEqual([]);
  });
});
