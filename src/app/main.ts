// Minimal canvas page for Appendix B step 2: pointer capture -> InputRing -> Engine -> RenderCore.
// shortcut: dev-only keys (1-5 select module, C clears) until the real shortcut map and HUD land (step 4).
import { InputRing, KIND_MOUSE, KIND_PEN, KIND_TOUCH, META_COALESCED, META_HW_PRESSURE, PHASE_CANCEL, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import { Engine } from '../engine/engine';
import { createModules } from '../modules/registry';
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

engine.select(createModules[0].make());

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  // Cap backing area at 16.7 Mpx (iOS Safari limit), spec 7.2.
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16.7e6 / (w * h)));
  for (const [c, ctx] of [[committedCanvas, committedCtx], [activeCanvas, activeCtx]] as const) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  core.redraw(w, h);
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
  if (down) request(); // idle when no stroke is active (2.3 step 7)
}

function write(ev: PointerEvent, phase: number, extra = 0): void {
  const rect = stage.getBoundingClientRect();
  const kind = ev.pointerType === 'pen' ? KIND_PEN : ev.pointerType === 'touch' ? KIND_TOUCH : KIND_MOUSE;
  // Hardware pressure: pens always; touch only when it reports something other than the 0.5 default.
  const hw = kind === KIND_PEN ? ev.pressure > 0 : kind === KIND_TOUCH && ev.pressure > 0 && ev.pressure !== 0.5;
  ring.write(ev.clientX - rect.left, ev.clientY - rect.top, ev.timeStamp - epoch, ev.pressure, ev.tiltX, ev.tiltY, ev.buttons,
    packMeta(kind, phase, extra | (hw ? META_HW_PRESSURE : 0)));
}

stage.addEventListener('pointerdown', (ev) => {
  if (!ev.isPrimary || ev.button !== 0) return;
  stage.setPointerCapture(ev.pointerId);
  down = true;
  write(ev, PHASE_DOWN);
  request();
});
stage.addEventListener('pointermove', (ev) => {
  if (!down || !ev.isPrimary) return;
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

window.addEventListener('keydown', (ev) => {
  if (down || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const n = Number(ev.key);
  if (n >= 1 && n <= createModules.length) engine.select(createModules[n - 1].make());
  else if (ev.key === 'c') core.clear();
});

new ResizeObserver(resize).observe(stage);
resize();

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__athanor = { engine, core, ring };
