import { CUBIC, CLOSE, H, HDR_STRIDE, LINE, MOVE, QUAD } from '../../core/arena';
import { recomputeEdges } from '../../core/shape';
import { setBounds } from '../../engine/clone';
import type { AffectModule, Engine } from '../../engine/engine';

const MAX_QUEUED = 64;

/** Pushes every vertex of one record away from (or toward) the record's last vertex by `speed`. */
function push(e: Engine, r: number, speed: number): void {
  const a = e.arena;
  const b = r * HDR_STRIDE;
  const spineOff = a.hdr[b + H.SPINE_OFF];
  if (spineOff >= 0) {
    const n = a.hdr[b + H.SPINE_COUNT];
    if (n === 0) return;
    const lx = a.spine[4 * (spineOff + n - 1)];
    const ly = a.spine[4 * (spineOff + n - 1) + 1];
    for (let i = 0; i < n; i++) {
      const k = 4 * (spineOff + i);
      const theta = Math.atan2(a.spine[k + 1] - ly, a.spine[k] - lx);
      a.spine[k] += speed * Math.cos(theta);
      a.spine[k + 1] += speed * Math.sin(theta);
    }
    recomputeEdges(a, r); // outline offsets follow the moved spine
    e.emitSpine(r);
    return;
  }
  const off = a.hdr[b + H.VTX_OFF];
  const count = a.hdr[b + H.VTX_COUNT];
  if (count === 0) return;
  const lx = a.vtx[2 * (off + count - 1)];
  const ly = a.vtx[2 * (off + count - 1) + 1];
  const co = a.hdr[b + H.CMD_OFF];
  let v = off;
  const move = (i: number) => {
    const theta = Math.atan2(a.vtx[2 * i + 1] - ly, a.vtx[2 * i] - lx);
    a.vtx[2 * i] += speed * Math.cos(theta);
    a.vtx[2 * i + 1] += speed * Math.sin(theta);
  };
  for (let c = 0; c < a.hdr[b + H.CMD_COUNT]; c++) {
    switch (a.cmd[co + c]) {
      case MOVE: case LINE: move(v); v += 1; break;
      case QUAD: move(v); move(v + 1); v += 2; break;
      case CUBIC: v += 3; break; // untouched (legacy parity)
      case CLOSE: break;
    }
  }
  setBounds(a, b, off, count); // the active layer clips to these bounds, so they must follow the moved vertices
}

/**
 * Displace, spec 5.4.3: while the pen is down, shoves the create geometry around its last vertex. Applied once per drag
 * event (parity mode), queued by the resampled drag and drained in the per-tick affect pass.
 */
export function displace({ displacement = 7 } = {}): AffectModule {
  let ox = 0;
  let oy = 0;
  let down = false;
  const queue = new Float32Array(MAX_QUEUED);
  let queued = 0;
  return {
    id: 'affect.displace',
    order: 0,
    rateSensitive: true,
    down(_e, s) {
      down = true;
      ox = s.x;
      oy = s.y;
      queued = 0;
    },
    drag(_e, s) {
      if (!down) return;
      if (queued < MAX_QUEUED) queue[queued++] = displacement - (Math.abs(s.x - ox) + Math.abs(s.y - oy));
      ox = s.x;
      oy = s.y;
    },
    up() {
      down = false;
      queued = 0;
    },
    affect(e) {
      for (let q = 0; q < queued; q++) {
        if (queue[q] === 0) continue;
        for (let i = 0; i < e.createCount; i++) push(e, e.create[i], queue[q]);
      }
      queued = 0;
    },
  };
}
