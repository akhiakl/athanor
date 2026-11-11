// Session recording, spec 8.4: on each interval, if the page changed since the last snapshot, copy it into a new 'session' page placed
// after the previous snapshot; optionally clear the page afterwards. Replaces the legacy timer that appended to a PDF on disk (F13).
// shortcut: the timer runs while the tab is hidden (8.7 asks for it to pause and keep elapsed time), and there is no countdown ring yet.
import { signal } from '@preact/signals';
import type { Docs } from '../doc/docs';
import type { RenderClient } from '../render/client';
import type { Pages } from './pages';

export const INTERVALS = [10, 30, 60, 120, 300] as const;
const KEY = 'athanor.session';

interface Prefs { intervalSec: number; autoClear: boolean; prefix: string }
const DEFAULTS: Prefs = { intervalSec: 60, autoClear: false, prefix: 'session-' };

const load = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      intervalSec: INTERVALS.includes(p.intervalSec as never) ? (p.intervalSec as number) : DEFAULTS.intervalSec,
      autoClear: p.autoClear === true,
      prefix: typeof p.prefix === 'string' && p.prefix.length <= 40 ? p.prefix : DEFAULTS.prefix,
    };
  } catch {
    return DEFAULTS; // blocked storage or a damaged value
  }
};

const stamp = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function createSession(docs: Docs, pages: Pages, client: RenderClient, announce: (msg: string) => void, now: () => Date = () => new Date()) {
  const prefs = load();
  const recording = signal(false);
  const intervalSec = signal(prefs.intervalSec);
  const autoClear = signal(prefs.autoClear);
  /** Bumped on every snapshot: the pill pulses its record dot for 500 ms (legacy parity). */
  const pulse = signal(0);
  const count = signal(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const seen = new Map<string, number>(); // page id -> revision at the last snapshot
  const last = new Map<string, string>(); // page id -> its newest snapshot, so snapshots accumulate in order

  const save = (): void => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ intervalSec: intervalSec.value, autoClear: autoClear.value, prefix: prefs.prefix }));
    } catch { /* the setting just is not remembered */ }
  };

  /** One interval: snapshot the open page if it changed. Never overlaps itself, and a failure only skips this round. */
  async function tick(): Promise<void> {
    if (busy || !pages.ready.value || !pages.current.value) return;
    busy = true;
    try {
      const pageId = pages.current.value;
      const { revision } = await client.flushPage();
      if (seen.get(pageId) === revision) return; // nothing changed since the last snapshot
      const snap = await docs.snapshotPage(pageId, `${prefs.prefix}${stamp(now())}`, last.get(pageId));
      last.set(pageId, snap.id);
      count.value++;
      pulse.value++;
      let rev = revision;
      if (autoClear.value) {
        client.clear(); // one undoable history group (8.4)
        rev = (await client.flushPage()).revision; // the cleared page is the new baseline, or the next round would snapshot a blank page
      }
      seen.set(pageId, rev);
      await pages.reload();
      announce(`Saved a snapshot, ${count.value} so far`);
    } catch (err) {
      announce(`Could not save a snapshot: ${err instanceof Error ? err.message : 'storage error'}`);
    } finally {
      busy = false;
    }
  }

  function arm(): void {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => void tick(), intervalSec.value * 1000);
  }

  async function start(): Promise<void> {
    if (recording.value) return;
    recording.value = true;
    count.value = 0;
    seen.clear();
    last.clear();
    try {
      if (pages.current.value) seen.set(pages.current.value, (await client.flushPage()).revision); // what is on the page now is the baseline
    } catch { /* the first round will simply snapshot it */ }
    arm();
    announce('Recording');
  }

  function stop(): void {
    if (!recording.value) return;
    recording.value = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
    announce(`Recording stopped, ${count.value} snapshot${count.value === 1 ? '' : 's'}`);
  }

  return {
    recording, intervalSec, autoClear, pulse, count,
    start, stop, tick,
    toggle: (): Promise<void> | void => (recording.value ? stop() : start()),
    setInterval(sec: number): void {
      if (!INTERVALS.includes(sec as never)) return;
      intervalSec.value = sec;
      if (recording.value) arm(); // the new period starts now
      save();
    },
    setAutoClear(on: boolean): void {
      autoClear.value = on;
      save();
    },
  };
}
export type Session = ReturnType<typeof createSession>;
