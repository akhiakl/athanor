// Active-layer renderer with dirty-rect clearing, spec 2.4.
import { H, HDR_STRIDE } from '../core/arena';
import type { Engine } from '../engine/engine';
import { drawRecord, type Ctx2D } from './draw';

interface Rect { x0: number; y0: number; x1: number; y1: number }

export class ActiveRenderer {
  private prev: Rect | null = null;
  private readonly now: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  render(ctx: Ctx2D, e: Engine): void {
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
    const p = this.prev;
    if (!any && !p) return;
    // clear union(prev, now), redraw only what intersects it
    const x0 = any ? (p ? Math.min(p.x0, now.x0) : now.x0) : p!.x0;
    const y0 = any ? (p ? Math.min(p.y0, now.y0) : now.y0) : p!.y0;
    const x1 = any ? (p ? Math.max(p.x1, now.x1) : now.x1) : p!.x1;
    const y1 = any ? (p ? Math.max(p.y1, now.y1) : now.y1) : p!.y1;
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
    ctx.restore();
    this.prev = any ? { x0: now.x0, y0: now.y0, x1: now.x1, y1: now.y1 } : null;
  }
}
