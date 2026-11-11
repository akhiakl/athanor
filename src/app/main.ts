// Minimal canvas page for Appendix B step 2: pointer capture -> InputRing -> Engine -> RenderCore.
// shortcut: dev-only keys (1-5 select module, C clears) until the real shortcut map and HUD land (step 4).
import { InputRing, KIND_MOUSE, KIND_PEN, KIND_TOUCH, META_COALESCED, META_HW_PRESSURE, PHASE_CANCEL, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import { Engine } from '../engine/engine';
import { createModules } from '../modules/registry';
import { limitAffect, randomAffect, smoothAffect } from '../render/affects';
import { ActiveRenderer } from '../render/active';
import { MainThreadRenderCore } from '../render/core';

const stage = document.getElementById('stage') as HTMLElement;
const committedCanvas = document.getElementById('committed') as HTMLCanvasElement;
const activeCanvas = document.getElementById('active') as HTMLCanvasElement;
const committedCtx = committedCanvas.getContext('2d', { alpha: false, desynchronized: true })!;
const activeCtx = activeCanvas.getContext('2d', { alpha: true, desynchronized: true })!;

const urlSeed = new URLSearchParams(location.search).get('seed');
const seed = urlSeed !== null ? Number(urlSeed) | 0 : crypto.getRandomValues(new Uint32Array(1))[0];

const core = new MainThreadRenderCore(committedCtx);
const engine = new Engine(seed, core);
const ring = new InputRing();
const active = new ActiveRenderer();
const epoch = performance.now();
let down = false;
let originX = 0; // cached stage offset: reading layout per coalesced event would force reflow in a hot loop
let originY = 0;

function measure(): void {
  const r = stage.getBoundingClientRect();
  originX = r.left;
  originY = r.top;
}

engine.select(createModules[0].make());

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  measure();
  // Cap backing area at 16.7 Mpx (iOS Safari limit), spec 7.2.
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16.7e6 / (w * h)));
  for (const [c, ctx] of [[committedCanvas, committedCtx], [activeCanvas, activeCtx]] as const) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  core.resize(w, h);
  request();
}

let scheduled = false;
function request(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(frame);
}

function frame(): void {
  scheduled = false;
  engine.tick(ring);
  active.render(activeCtx, engine);
  const pending = core.replay(2); // main-thread fallback budget: 2 ms per frame (7.2)
  if (down || pending > 0) request(); // idle when no stroke is active (2.3 step 7)
}

function write(ev: PointerEvent, phase: number, extra = 0): void {
  const kind = ev.pointerType === 'pen' ? KIND_PEN : ev.pointerType === 'touch' ? KIND_TOUCH : KIND_MOUSE;
  // Hardware pressure: pens always (even a reported 0 at pointerdown); touch only when it reports something other than the 0.5 default.
  const hw = kind === KIND_PEN || (kind === KIND_TOUCH && ev.pressure > 0 && ev.pressure !== 0.5);
  ring.write(ev.clientX - originX, ev.clientY - originY, ev.timeStamp - epoch, ev.pressure, ev.tiltX, ev.tiltY, ev.buttons,
    packMeta(kind, phase, extra | (hw ? META_HW_PRESSURE : 0)));
}

stage.addEventListener('pointerdown', (ev) => {
  if (!ev.isPrimary || ev.button !== 0) return;
  stage.setPointerCapture(ev.pointerId);
  measure(); // once per stroke, covers scroll/layout shifts
  down = true;
  write(ev, PHASE_DOWN);
  request();
});
stage.addEventListener('pointermove', (ev) => {
  if (!ev.isPrimary) return;
  if (!down) {
    // hover (buttons 0) feeds the committed-domain affects directly
    if (core.affects.length > 0) {
      core.hover(ev.clientX - originX, ev.clientY - originY, ev.timeStamp - epoch);
      request();
    }
    return;
  }
  const list = ev.getCoalescedEvents?.() ?? [];
  if (list.length > 1) for (const c of list) write(c, PHASE_MOVE, META_COALESCED);
  else write(ev, PHASE_MOVE);
  request();
}, { passive: true });
const end = (phase: number) => (ev: PointerEvent) => {
  if (!down || !ev.isPrimary) return;
  down = false;
  write(ev, phase);
  request();
};
stage.addEventListener('pointerup', end(PHASE_UP));
stage.addEventListener('pointercancel', end(PHASE_CANCEL));

// dev-only toggles for the committed affects: R random, S smooth, L limit
const toggles: Record<string, string | undefined> = { r: 'affect.random', s: 'affect.smooth', l: 'affect.limit' };
const makers: Record<string, () => (typeof core.affects)[number]> = {
  'affect.random': () => randomAffect(seed),
  'affect.smooth': () => smoothAffect(),
  'affect.limit': () => limitAffect(),
};
function toggle(id: string): void {
  const i = core.affects.findIndex((a) => a.id === id);
  if (i >= 0) core.affects.splice(i, 1);
  else core.affects.push(makers[id]());
}

window.addEventListener('keydown', (ev) => {
  if (down || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const n = Number(ev.key);
  if (n >= 1 && n <= createModules.length) engine.select(createModules[n - 1].make());
  else if (ev.key.toLowerCase() === 'c') core.clear();
  else if (toggles[ev.key.toLowerCase()]) toggle(toggles[ev.key.toLowerCase()]!);
});

new ResizeObserver(resize).observe(stage);
resize();

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__athanor = { engine, core, ring };
