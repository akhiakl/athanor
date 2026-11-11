import { describe, expect, it } from 'vitest';
import { LINE, MOVE } from '../core/arena';
import { mkShape, squareShape } from '../test/helpers';
import { CommittedStore } from './committed';
import { BURST_MS, HistoryLog } from './history';
import { limitAffect, randomAffect } from './affects';

function setup(maxSteps = 200) {
  const store = new CommittedStore(256, 512, 512);
  let t = 0;
  const log = new HistoryLog(store, maxSteps, () => t);
  store.journal = log;
  return { store, log, at: (ms: number) => (t = ms) };
}
const alive = (s: CommittedStore): number[] => s.aliveIds();

describe('undo and redo (8.5)', () => {
  it('a pointer gesture is one group: undo removes everything it committed, redo brings it back', () => {
    const { store, log } = setup();
    log.begin();
    store.add(squareShape(0, 0));
    store.add(squareShape(20, 0)); // e.g. a create shape and its Mirror clone
    log.end();
    expect(alive(store)).toEqual([0, 1]);
    expect(log.undo()).toBe(true);
    expect(alive(store)).toEqual([]);
    expect(log.canUndo).toBe(false);
    expect(log.canRedo).toBe(true);
    expect(log.redo()).toBe(true);
    expect(alive(store)).toEqual([0, 1]);
  });
  it('keeps z-order: a revived shape returns to its original place', () => {
    const { store, log } = setup();
    for (let i = 0; i < 3; i++) log.scope(() => store.add(squareShape(i * 30, 0)));
    log.undo(); // removes id 2
    log.undo(); // removes id 1
    log.redo();
    expect(alive(store)).toEqual([0, 1]);
    expect(store.tileIds(0).filter((id) => store.entries[id].alive)).toEqual([0, 1]);
  });
  it('a new operation after an undo clears the redo stack', () => {
    const { store, log } = setup();
    log.scope(() => store.add(squareShape(0, 0)));
    log.undo();
    expect(log.canRedo).toBe(true);
    log.scope(() => store.add(squareShape(50, 0)));
    expect(log.canRedo).toBe(false);
    expect(log.redo()).toBe(false);
  });
  it('is ignored while a stroke is in progress', () => {
    const { store, log } = setup();
    log.scope(() => store.add(squareShape(0, 0)));
    log.begin();
    store.add(squareShape(50, 0));
    expect(log.undo()).toBe(false);
    expect(alive(store)).toEqual([0, 1]);
    log.end();
    expect(log.undo()).toBe(true);
    expect(alive(store)).toEqual([0]);
  });
  it('clear is one op and undo restores every shape', () => {
    const { store, log } = setup();
    for (let i = 0; i < 4; i++) log.scope(() => store.add(squareShape(i * 20, 0)));
    log.clearAll();
    expect(store.aliveCount).toBe(0);
    log.undo();
    expect(alive(store)).toEqual([0, 1, 2, 3]);
    log.redo();
    expect(store.aliveCount).toBe(0);
    log.clearAll(); // nothing to clear: no empty group
    expect(log.canRedo).toBe(false);
  });
  it('Limit removals triggered by a commit share its group', () => {
    const { store, log } = setup();
    const limit = limitAffect({ limit: 2 });
    const commit = () => log.scope(() => { store.add(squareShape(0, 0)); limit.committed?.(store); });
    commit(); commit(); commit(); // the third removes the oldest
    expect(alive(store)).toEqual([1, 2]);
    log.undo(); // one step undoes the add AND the removal it caused
    expect(alive(store)).toEqual([0, 1]);
  });
  it('drops the oldest groups past maxSteps, moving the undo horizon', () => {
    const { store, log } = setup(3);
    for (let i = 0; i < 5; i++) log.scope(() => store.add(squareShape(i * 20, 0)));
    let n = 0;
    while (log.undo()) n++;
    expect(n).toBe(3);
    expect(alive(store)).toEqual([0, 1]); // the two oldest are past the horizon
  });
});

describe('mutations (hover affects)', () => {
  it('restores the pre-image on undo and the post-image on redo', () => {
    const { store, log } = setup();
    log.scope(() => store.add(mkShape([MOVE, LINE], [100, 100, 140, 100])));
    log.willMutate(0, store.entries[0].shape); // what an affect does before it moves vertices
    store.entries[0].shape.vtx[2] = 999;
    store.touch(0);
    expect(store.entries[0].shape.vtx[2]).toBe(999);
    log.undo();
    expect(store.entries[0].shape.vtx[2]).toBe(140);
    log.redo();
    expect(store.entries[0].shape.vtx[2]).toBe(999);
  });
  it('copies a shape once per group however often it is mutated (copy on first write)', () => {
    const { store, log, at } = setup();
    log.scope(() => store.add(mkShape([MOVE, LINE], [100, 100, 140, 100])));
    for (let i = 0; i < 20; i++) { at(i * 10); store.willMutate(0); store.entries[0].shape.vtx[2] += 1; store.touch(0); }
    log.undo(); // one burst, one step
    expect(store.entries[0].shape.vtx[2]).toBe(140);
    expect(log.undo()).toBe(true); // the add
    expect(log.undo()).toBe(false);
  });
  it('a hover burst closes after 500 ms of quiet and starts a new group', () => {
    const { store, log, at } = setup();
    log.scope(() => store.add(mkShape([MOVE, LINE], [100, 100, 140, 100])));
    at(1000); store.willMutate(0); store.entries[0].shape.vtx[2] = 150; store.touch(0);
    at(1000 + BURST_MS + 1); store.willMutate(0); store.entries[0].shape.vtx[2] = 160; store.touch(0);
    log.undo();
    expect(store.entries[0].shape.vtx[2]).toBe(150);
    log.undo();
    expect(store.entries[0].shape.vtx[2]).toBe(140);
  });
  it('the live shape never aliases history: mutating after an undo does not corrupt redo', () => {
    const { store, log } = setup();
    log.scope(() => store.add(mkShape([MOVE, LINE], [100, 100, 140, 100])));
    store.willMutate(0); store.entries[0].shape.vtx[2] = 150; store.touch(0);
    log.undo();
    store.entries[0].shape.vtx[2] = 777; // in-place change of the restored shape (no willMutate: it is a test of aliasing)
    log.redo();
    expect(store.entries[0].shape.vtx[2]).toBe(150);
  });
  it('Random records a pre-image through the store hook', () => {
    const { store, log } = setup();
    log.scope(() => store.add(mkShape([MOVE, LINE, LINE], [100, 100, 160, 100, 130, 160]))); // a triangle: a line has no area to hit
    const before = Array.from(store.entries[0].shape.vtx);
    randomAffect(1, { distortion: 50 }).hover?.(store, 130, 110, 0);
    expect(Array.from(store.entries[0].shape.vtx)).not.toEqual(before);
    log.undo();
    expect(Array.from(store.entries[0].shape.vtx)).toEqual(before);
  });
});
