import { describe, expect, it } from 'vitest';
import { CLOSE, LINE, MOVE, QUAD } from '../core/arena';
import { InputRing, KIND_MOUSE, PHASE_DOWN, PHASE_MOVE, packMeta } from '../core/inputRing';
import { detachShapes } from '../modules/create/detach';
import { pressureShapes } from '../modules/create/pressure';
import { scrawlShapes } from '../modules/create/scrawl';
import { shapes } from '../modules/create/shapes';
import { speedShapes } from '../modules/create/speed';
import { createModules } from '../modules/registry';
import { CaptureSink, close4, stroke } from '../test/helpers';
import { Engine } from './engine';
import { SyntheticPressure } from './pressure';

const setup = (m: Parameters<Engine['select']>[0]) => {
  const sink = new CaptureSink();
  const e = new Engine(1, sink);
  e.select(m);
  return { e, sink };
};

describe('T1 Shapes through the engine', () => {
  it('commits the warmup/gating stream on up', () => {
    const { e, sink } = setup(shapes());
    stroke(e, [[0, 0, 0], [10, 0, 8], [20, 0, 16], [30, 0, 24], [40, 0, 32], [42, 0, 40], [50, 0, 48], [60, 5, 56], [61, 5, 64]]);
    expect(sink.commits).toHaveLength(1);
    expect(sink.commits[0].cmd).toEqual([MOVE, LINE, LINE, LINE, LINE, QUAD, QUAD]);
    close4(sink.commits[0].vtx, [0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 40, 0, 45, 0, 50, 0, 55, 2.5]);
  });
});

describe('T2 SpeedShapes', () => {
  it('projects the drag by speed * multiplier', () => {
    const { e, sink } = setup(speedShapes({ multiplier: 15, freeform: false }));
    // 10 ms apart so the 120 Hz resampler passes every sample
    stroke(e, [[0, 0, 0], [10, 0, 10], [10, 10, 20], [10, 10, 30]]);
    expect(sink.commits[0].cmd).toEqual([MOVE, LINE, LINE]);
    close4(sink.commits[0].vtx, [0, 0, 85, 0, 10, 85]);
  });
});

describe('T3 PressureShapes', () => {
  it('builds the closed ribbon from hardware pressure', () => {
    const { e, sink } = setup(pressureShapes({ amount: 4 }));
    stroke(e, [[0, 0, 0], [10, 0, 8], [20, 0, 16], [21, 0, 24]], { pen: true });
    expect(sink.commits[0].cmd).toEqual([MOVE, LINE, LINE, LINE, LINE, CLOSE]);
    close4(sink.commits[0].vtx, [0, 0, 10, -4, 20, -4, 10, 4, 0, 4]);
  });
  it('a mouse gets width 1 when synthetic pressure is off', () => {
    const { e, sink } = setup(pressureShapes({ amount: 25 }));
    e.attrs.syntheticPressure = false;
    stroke(e, [[0, 0, 0], [10, 0, 8], [20, 0, 16], [21, 0, 24]]);
    close4(sink.commits[0].vtx, [0, 0, 10, -1, 20, -1, 10, 1, 0, 1]);
  });
});

describe('T7 DetachShapes', () => {
  it('drags the tether behind the pen', () => {
    const { e, sink } = setup(detachShapes({ distance: 100 }));
    stroke(e, [[100, 100, 0], [300, 100, 8], [300, 300, 16], [300, 300, 24]]);
    expect(sink.commits[0].cmd).toEqual([MOVE, LINE]);
    close4(sink.commits[0].vtx, [200, 100, 255, 210]);
  });
});

describe('T8 ScrawlShapes', () => {
  it('interpolates detail-1 points toward the pen', () => {
    const { e, sink } = setup(scrawlShapes({ flow: 10, detail: 10, noise: 0 }));
    stroke(e, [[0, 0, 0], [100, 50, 10], [100, 50, 20]]);
    expect(sink.commits[0].cmd).toEqual([MOVE, LINE, LINE, LINE, LINE, QUAD, QUAD, QUAD, QUAD, QUAD]);
    close4(sink.commits[0].vtx, [0, 0, 10, 5, 20, 10, 30, 15, 40, 20, 40, 20, 45, 22.5, 50, 25, 55, 27.5, 60, 30, 65, 32.5, 70, 35, 75, 37.5, 80, 40, 85, 42.5]);
  });
});

describe('synthetic pressure', () => {
  it('starts at 0.6, thins when fast and thickens when slow', () => {
    const sp = new SyntheticPressure();
    expect(sp.next(0, 0, 0)).toBe(0.6);
    let fast = 0;
    for (let i = 1; i <= 40; i++) fast = sp.next(i * 30, 0, i); // 30 px/ms
    expect(fast).toBeCloseTo(0.15, 5);
    let slow = 0;
    for (let i = 41; i <= 200; i++) slow = sp.next(1200, 0, i);
    expect(slow).toBeGreaterThan(0.99);
  });
});

describe('split-commit', () => {
  it('a very long Shapes stroke commits in continuous pieces within the vertex cap', () => {
    const { e, sink } = setup(shapes());
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 6000; i++) pts.push([i * 10, 0, i]);
    pts.push([60000, 0, 6000]);
    stroke(e, pts);
    expect(sink.commits.length).toBeGreaterThan(1);
    for (const c of sink.commits) expect(c.vtx.length).toBeLessThanOrEqual(2 * 4096);
    for (let i = 1; i < sink.commits.length; i++) {
      const prev = sink.commits[i - 1].vtx;
      const lastX = prev[prev.length - 2];
      expect(sink.commits[i].vtx[0]).toBeGreaterThanOrEqual(lastX - 10); // continues where the last piece ended
    }
  });
  it('a very long Pressure stroke splits with overlapping spine points and no overflow', () => {
    const { e, sink } = setup(pressureShapes({ amount: 4 }));
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 3000; i++) pts.push([i * 10, 0, i]);
    pts.push([30000, 0, 3000]);
    stroke(e, pts, { pen: true });
    expect(sink.commits.length).toBeGreaterThan(1);
    for (const c of sink.commits) {
      expect(c.vtx.length).toBeLessThanOrEqual(2 * 4096);
      expect(c.cmd[c.cmd.length - 1]).toBe(CLOSE);
    }
  });
});

describe('tap', () => {
  it('a single-point stroke is a down + up and commits a one-point shape', () => {
    const { e, sink } = setup(shapes());
    stroke(e, [[5, 7, 0]]);
    expect(sink.commits).toHaveLength(1);
    expect(sink.commits[0].cmd).toEqual([MOVE]);
    close4(sink.commits[0].vtx, [5, 7]);
  });
});

describe('engine plumbing', () => {
  it('selecting another module commits an unfinished stroke', () => {
    const { e, sink } = setup(shapes());
    const ring = new InputRing();
    ring.write(0, 0, 0, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_DOWN));
    ring.write(30, 0, 8, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_MOVE));
    e.tick(ring); // pen still down: nothing committed yet
    expect(sink.commits).toHaveLength(0);
    e.select(speedShapes());
    expect(sink.commits).toHaveLength(1);
    close4(sink.commits[0].vtx, [0, 0, 30, 0]);
  });
  it('registry lists the five create modules in spec order', () => {
    expect(createModules.map((m) => m.id)).toEqual([
      'create.shapes', 'create.speedShapes', 'create.detachShapes', 'create.pressureShapes', 'create.scrawlShapes',
    ]);
    for (const d of createModules) expect(d.make().id).toBe(d.id);
  });
});
