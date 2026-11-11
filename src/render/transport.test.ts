import { describe, expect, it } from 'vitest';
import type { ToWorker } from './protocol';
import { Transport } from './transport';

const msg = (n: number): ToWorker => ({ type: 'tick', activeCount: n });

describe('Transport', () => {
  it('queues until attached, then flushes in order with transfer lists intact', () => {
    const t = new Transport();
    const buf = new ArrayBuffer(8);
    t.send(msg(1));
    t.send({ type: 'commit', batchId: 1, buffer: buf }, [buf]);
    t.send(msg(3));
    expect(t.queued).toBe(3);
    const got: Array<[ToWorker, Transferable[] | undefined]> = [];
    t.attach((m, tr) => got.push([m, tr]));
    expect(got.map(([m]) => m.type)).toEqual(['tick', 'commit', 'tick']);
    expect(got[1][1]).toEqual([buf]);
    expect(buf.byteLength).toBe(8); // nothing was transferred while queued
    expect(t.queued).toBe(0);
  });
  it('sends straight through once attached', () => {
    const t = new Transport();
    const got: ToWorker[] = [];
    t.attach((m) => got.push(m));
    t.send(msg(7));
    expect(got).toEqual([msg(7)]);
  });
  it('re-attaching swaps the target (worker replaced by the local host) without replaying old messages', () => {
    const t = new Transport();
    const a: ToWorker[] = [];
    const b: ToWorker[] = [];
    t.attach((m) => a.push(m));
    t.send(msg(1));
    t.attach((m) => b.push(m));
    t.send(msg(2));
    expect(a).toEqual([msg(1)]);
    expect(b).toEqual([msg(2)]);
  });
});
