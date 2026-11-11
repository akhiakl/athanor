// Active-layer renderer with dirty-rect clearing, spec 2.4.
import { H, HDR_STRIDE } from '../core/arena';
import type { Engine } from '../engine/engine';
import type { Shape } from './batch';
import { drawRecord, drawShape, type Ctx2D } from './draw';
import { shapeBBox } from './hit';

interface Rect { x0: number; y0: number; x1: number; y1: number }

export class ActiveRenderer {
  private readonly prev: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 }; // reused: no per-frame allocation
  private hasPrev = false;
  private readonly now: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  private readonly bb = [0, 0, 0, 0];

  /** `pending`: shapes committed to the render worker but not yet acked; they stay visible here until the committed canvas shows them. */
  render(ctx: Ctx2D, e: Engine, pending: readonly Shape[] = []): void {
    const a = e.arena;
    const now = this.now;
    let any = false;
    for (let i = 0; i < e.createCount; i++) {
      const b = e.create[i] * HDR_STRIDE;
      if (a.hdr[b + H.VTX_COUNT] === 0) continue;
      const pad = a.hdrF[b + H.LINE_WIDTH] / 2 + 2;
      const x0 = a.hdrF[b + H.BB_MIN_X] - pad;
      const y0 = a.hdrF[b + H.BB_MIN_Y] - pad;
      const x1 = a.hdrF[b + H.BB_MAX_X] + pad;
      const y1 = a.hdrF[b + H.BB_MAX_Y] + pad;
      if (!any) { now.x0 = x0; now.y0 = y0; now.x1 = x1; now.y1 = y1; any = true; }
      else { now.x0 = Math.min(now.x0, x0); now.y0 = Math.min(now.y0, y0); now.x1 = Math.max(now.x1, x1); now.y1 = Math.max(now.y1, y1); }
    }
    for (const sh of pending) {
      shapeBBox(sh, this.bb);
      const [x0, y0, x1, y1] = this.bb;
      if (!any) { now.x0 = x0; now.y0 = y0; now.x1 = x1; now.y1 = y1; any = true; }
      else { now.x0 = Math.min(now.x0, x0); now.y0 = Math.min(now.y0, y0); now.x1 = Math.max(now.x1, x1); now.y1 = Math.max(now.y1, y1); }
    }
    const p = this.prev;
    if (!any && !this.hasPrev) return;
    // Clear union(prev, now). Every active record lies inside it, so all are redrawn under the clip.
    const x0 = !any ? p.x0 : this.hasPrev ? Math.min(p.x0, now.x0) : now.x0;
    const y0 = !any ? p.y0 : this.hasPrev ? Math.min(p.y0, now.y0) : now.y0;
    const x1 = !any ? p.x1 : this.hasPrev ? Math.max(p.x1, now.x1) : now.x1;
    const y1 = !any ? p.y1 : this.hasPrev ? Math.max(p.y1, now.y1) : now.y1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    for (let i = 0; i < e.createCount; i++) {
      const r = e.create[i];
      const b = r * HDR_STRIDE;
      if (a.hdr[b + H.VTX_COUNT] === 0) continue;
      drawRecord(ctx, a.hdr[b + H.RGBA], a.hdr[b + H.FLAGS], a.hdrF[b + H.LINE_WIDTH],
        a.cmd, a.hdr[b + H.CMD_OFF], a.hdr[b + H.CMD_COUNT], a.vtx, a.hdr[b + H.VTX_OFF]);
    }
    for (const sh of pending) drawShape(ctx, sh);
    ctx.restore();
    if (any) { p.x0 = now.x0; p.y0 = now.y0; p.x1 = now.x1; p.y1 = now.y1; }
    this.hasPrev = any;
  }
}
