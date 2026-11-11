import { describe, expect, it } from 'vitest';
import { LINE, MOVE } from '../core/arena';
import { CommittedStore } from '../render/committed';
import { mkShape, squareShape } from '../test/helpers';
import { crc32 } from './crc32';
import { HEADER_BYTES, Kind, applySegments, concat, decodeHeader, decodeLog, encodeHeader, encodeSegment, encodeSnapshot } from './pageLog';

const header = { width: 800, height: 600, background: 0xffffff };
const fresh = () => new CommittedStore(256, 800, 600);
const state = (s: CommittedStore) => s.entries.map((e) => [e.alive, Array.from(e.shape.vtx)]);

describe('crc32', () => {
  it('matches the standard check values', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('header', () => {
  it('round-trips and rejects wrong magic, version and size', () => {
    const b = encodeHeader(header);
    expect(b.length).toBe(HEADER_BYTES);
    expect(decodeHeader(b)).toEqual(header);
    const bad = b.slice(); bad[0] = 0;
    expect(decodeHeader(bad)).toBeNull();
    const future = b.slice(); future[4] = 9;
    expect(decodeHeader(future)).toBeNull();
    expect(decodeHeader(b.subarray(0, 10))).toBeNull();
  });
});

describe('segments', () => {
  it('round-trip every kind', () => {
    const shape = squareShape(1, 2);
    const bytes = concat([
      encodeHeader(header),
      encodeSegment({ kind: Kind.Commit, shapes: [shape, squareShape(30, 2)] }),
      encodeSegment({ kind: Kind.Remove, ids: [0] }),
      encodeSegment({ kind: Kind.Revive, ids: [0] }),
      encodeSegment({ kind: Kind.Mutate, id: 1, shape: mkShape([MOVE, LINE], [5, 5, 9, 9]) }),
      encodeSegment({ kind: Kind.Clear, ids: [0, 1] }),
    ]);
    const d = decodeLog(bytes)!;
    expect(d.header).toEqual(header);
    expect(d.segments.map((s) => s.kind)).toEqual([Kind.Commit, Kind.Remove, Kind.Revive, Kind.Mutate, Kind.Clear]);
    expect(d.validBytes).toBe(bytes.length);
    const c = d.segments[0];
    expect(c.kind === Kind.Commit && c.shapes).toHaveLength(2);
    expect(c.kind === Kind.Commit && Array.from(c.shapes[0].vtx)).toEqual(Array.from(shape.vtx));
  });

  it('replays onto a store with the same ids, order and tombstones', () => {
    const a = fresh();
    a.add(squareShape(0, 0)); a.add(squareShape(30, 0)); a.add(squareShape(60, 0));
    a.remove(1);
    a.entries[2].shape.vtx[0] = 61; a.touch(2);
    const bytes = concat([
      encodeHeader(header),
      encodeSegment({ kind: Kind.Commit, shapes: [a.entries[0].shape, a.entries[1].shape, a.entries[2].shape] }),
      encodeSegment({ kind: Kind.Remove, ids: [1] }),
    ]);
    const b = fresh();
    applySegments(b, decodeLog(bytes)!.segments);
    expect(state(b)).toEqual(state(a));
    expect(b.aliveIds()).toEqual([0, 2]);
  });

  it('discards a torn tail but keeps everything before it', () => {
    const good = concat([encodeHeader(header), encodeSegment({ kind: Kind.Commit, shapes: [squareShape(0, 0)] }), encodeSegment({ kind: Kind.Remove, ids: [0] })]);
    const torn = good.subarray(0, good.length - 5); // power loss mid-write of the last segment
    const d = decodeLog(torn)!;
    expect(d.segments.map((s) => s.kind)).toEqual([Kind.Commit]);
    expect(d.validBytes).toBeLessThan(torn.length);
  });

  it('stops at a segment whose CRC fails', () => {
    const s1 = encodeSegment({ kind: Kind.Commit, shapes: [squareShape(0, 0)] });
    const s2 = encodeSegment({ kind: Kind.Remove, ids: [0] });
    const flipped = s2.slice(); flipped[flipped.length - 1] ^= 0xff;
    const d = decodeLog(concat([encodeHeader(header), s1, flipped, encodeSegment({ kind: Kind.Revive, ids: [0] })]))!;
    expect(d.segments).toHaveLength(1); // nothing after the first bad segment is trusted
  });

  it('survives garbage lengths and an empty log', () => {
    expect(decodeLog(new Uint8Array(3))).toBeNull();
    const huge = concat([encodeHeader(header), new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0, 1])]);
    expect(decodeLog(huge)!.segments).toEqual([]);
    expect(decodeLog(encodeHeader(header))!.segments).toEqual([]);
  });
});

describe('snapshot', () => {
  it('rebuilds a store exactly, dead shapes included, so later log ids still line up', () => {
    const a = fresh();
    for (let i = 0; i < 5; i++) a.add(squareShape(i * 30, 0));
    a.remove(1); a.remove(3);
    const b = fresh();
    applySegments(b, decodeLog(encodeSnapshot(a, header))!.segments);
    expect(state(b)).toEqual(state(a));
    expect(b.aliveCount).toBe(3);
    b.revive(1); // an id from before the snapshot keeps its meaning
    expect(b.aliveIds()).toEqual([0, 1, 2, 4]);
  });
  it('of an empty store is just the header', () => {
    expect(encodeSnapshot(fresh(), header)).toEqual(encodeHeader(header));
  });
});
