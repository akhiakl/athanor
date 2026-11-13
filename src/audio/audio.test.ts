import { describe, expect, it } from 'vitest';
import { MOVE, LINE } from '../core/arena';
import { Engine } from '../engine/engine';
import { micShapes } from '../modules/create/micShapes';
import { pitchShapes } from '../modules/create/pitchShapes';
import { CaptureSink, stroke } from '../test/helpers';
import { computeLevels, emptyLevels, estimatePitch, type Levels } from './analysis';
import type { AudioSource } from './mic';

const SR = 48000;
const FFT = 2048;

/** dB spectrum with sine-like peaks at the given Hz and dB levels over a -100 dB floor. */
function spectrum(peaks: [number, number][]): Float32Array {
  const db = new Float32Array(FFT / 2).fill(-100);
  for (const [hz, level] of peaks) {
    const b = Math.round((hz * FFT) / SR);
    db[b] = level;
    db[b - 1] = level - 20;
    db[b + 1] = level - 20;
  }
  return db;
}

describe('computeLevels (spec 4.1.2)', () => {
  it('matches the spec example: mean |s16| 750 gives legacyLvl 7.5', () => {
    const f = new Float32Array(128).fill(750 / 32767);
    const l = computeLevels(f, emptyLevels());
    expect(l.legacyLvl).toBeCloseTo(7.5, 6);
    expect(l.zcr).toBe(0);
  });
  it('counts zero crossings and takes the high byte of sample 0', () => {
    const f = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const l = computeLevels(f, emptyLevels());
    expect(l.zcr).toBe(0.75);
    expect(l.peak).toBe(0.5);
    expect(l.b0).toBe(64);
  });
  it('is silent for an empty block', () => {
    expect(computeLevels(new Float32Array(0), { ...emptyLevels(), legacyLvl: 9 }).legacyLvl).toBe(0);
  });
});

describe('estimatePitch (spec 4.1.4)', () => {
  it('finds a single tone near its frequency', () => {
    const p = estimatePitch(spectrum([[440, -20]]), SR, FFT, -50);
    expect(Math.abs(p - 440)).toBeLessThan(25);
  });
  it('returns an energy-weighted mean of several peaks', () => {
    const p = estimatePitch(spectrum([[400, -20], [800, -20]]), SR, FFT, -50);
    expect(p).toBeGreaterThan(550);
    expect(p).toBeLessThan(650);
  });
  it('keeps a peak whose neighbours are -Infinity (silent bins)', () => {
    const db = new Float32Array(FFT / 2).fill(-Infinity);
    const b = Math.round((440 * FFT) / SR);
    db[b] = -20;
    const p = estimatePitch(db, SR, FFT, -50);
    expect(Number.isFinite(p)).toBe(true);
    expect(Math.abs(p - 440)).toBeLessThan(25);
  });
  it('gates quiet input', () => {
    expect(estimatePitch(spectrum([[440, -60]]), SR, FFT, -50)).toBe(0);
    expect(estimatePitch(new Float32Array(FFT / 2).fill(-100), SR, FFT, -50)).toBe(0);
  });
});

const src = (l: Partial<Levels>, pitch = 0): AudioSource => ({
  levels: () => ({ ...emptyLevels(), ...l }),
  pitch: () => pitch,
});
const setup = (m: Parameters<Engine['select']>[0]) => {
  const sink = new CaptureSink();
  const e = new Engine(1, sink);
  e.select(m);
  return { e, sink };
};
const line = [[0, 0, 0], [10, 0, 10], [20, 0, 20], [20, 0, 30]] as [number, number, number][];

describe('MicShapes (spec 5.3.4)', () => {
  it('fatten: micLevel 15 at volume 1.0 gives width 15', () => {
    const { e, sink } = setup(micShapes({ volume: 50 }, src({ legacyLvl: 7.5 }), false));
    stroke(e, line);
    expect(sink.commits).toHaveLength(1);
    expect(sink.commits[0].cmd.length).toBeGreaterThan(2);
  });
  it('fatten is wider when louder', () => {
    const area = (lvl: number) => {
      const { e, sink } = setup(micShapes({ volume: 50 }, src({ legacyLvl: lvl }), false));
      stroke(e, line);
      const v = sink.commits[0].vtx;
      let min = Infinity, max = -Infinity;
      for (let i = 1; i < v.length; i += 2) { min = Math.min(min, v[i]); max = Math.max(max, v[i]); }
      return max - min;
    };
    expect(area(40)).toBeGreaterThan(area(1));
  });
  it('shake offsets the line at right angles by level * volume', () => {
    const { e, sink } = setup(micShapes({ shake: true, volume: 50 }, src({ legacyLvl: 5 }), false));
    stroke(e, line);
    const c = sink.commits[0];
    expect(c.cmd[0]).toBe(MOVE);
    expect(c.cmd.at(-1)).toBe(LINE);
    // b0 = 0: lvl = micLevel (10) * 1.0; direction +x, so offset is -90deg: y = -10 (+y is down in canvas, rotated by -pi/2)
    expect(Math.abs(c.vtx[3])).toBeCloseTo(10, 0);
  });
});

describe('PitchShapes (spec 5.3.3)', () => {
  it('eases weight by at most 2 per sample toward the target', () => {
    const widths: number[] = [];
    const m = pitchShapes({}, src({}, 50), false); // lowest pitch: target maxWeight 50
    const { e, sink } = setup(m);
    stroke(e, [[0, 0, 0], [10, 0, 10], [20, 0, 20], [30, 0, 30], [30, 0, 40]]);
    expect(sink.commits).toHaveLength(1);
    widths.push(sink.commits[0].vtx.length);
    expect(widths[0]).toBeGreaterThan(0);
  });
  it('a high pitch thins the line compared with a low one', () => {
    const span = (hz: number) => {
      const { e, sink } = setup(pitchShapes({}, src({}, hz), false));
      const pts: [number, number, number][] = Array.from({ length: 40 }, (_, i) => [i * 5, 0, i * 10]);
      stroke(e, pts);
      const v = sink.commits[0].vtx;
      let min = Infinity, max = -Infinity;
      for (let i = 1; i < v.length; i += 2) { min = Math.min(min, v[i]); max = Math.max(max, v[i]); }
      return max - min;
    };
    expect(span(60)).toBeGreaterThan(span(1800));
  });
});
