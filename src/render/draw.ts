// Command-stream -> Canvas 2D, spec 2.4. Shared by the active layer and the committed RenderCore.
import { CLOSE, CUBIC, F_EVENODD, F_FILL, H, LINE, MOVE, QUAD } from '../core/arena';
import type { Shape } from './batch';

type Paint = string | CanvasGradient | CanvasPattern;

/** The slice of CanvasRenderingContext2D the renderer uses, so tests can record calls. */
export interface Ctx2D {
  fillStyle: Paint;
  strokeStyle: Paint;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  fill(rule?: CanvasFillRule): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  save(): void;
  restore(): void;
}

const cssCache = new Map<number, string>();

/** Packed 0xRRGGBBAA -> CSS. Small cache so the hot path builds no strings per frame. */
export function rgbaToCss(rgba: number): string {
  let s = cssCache.get(rgba);
  if (s === undefined) {
    const u = rgba >>> 0;
    s = `rgba(${u >>> 24},${(u >>> 16) & 255},${(u >>> 8) & 255},${((u & 255) / 255).toFixed(3)})`;
    if (cssCache.size >= 32) cssCache.clear();
    cssCache.set(rgba, s);
  }
  return s;
}

export function drawRecord(
  ctx: Ctx2D, rgba: number, flags: number, lineWidth: number,
  cmd: Uint8Array, cmdOff: number, cmdN: number, vtx: Float32Array, vtxOff: number,
): void {
  ctx.beginPath();
  let v = 2 * vtxOff;
  for (let i = 0; i < cmdN; i++) {
    switch (cmd[cmdOff + i]) {
      case MOVE: ctx.moveTo(vtx[v], vtx[v + 1]); v += 2; break;
      case LINE: ctx.lineTo(vtx[v], vtx[v + 1]); v += 2; break;
      case QUAD: ctx.quadraticCurveTo(vtx[v], vtx[v + 1], vtx[v + 2], vtx[v + 3]); v += 4; break;
      case CUBIC: ctx.bezierCurveTo(vtx[v], vtx[v + 1], vtx[v + 2], vtx[v + 3], vtx[v + 4], vtx[v + 5]); v += 6; break;
      case CLOSE: ctx.closePath(); break;
    }
  }
  if (flags & F_FILL) {
    ctx.fillStyle = rgbaToCss(rgba);
    ctx.fill(flags & F_EVENODD ? 'evenodd' : 'nonzero');
  } else {
    ctx.strokeStyle = rgbaToCss(rgba);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'bevel'; // legacy BasicStroke(CAP_ROUND, JOIN_BEVEL)
    ctx.stroke();
  }
}

export function drawShape(ctx: Ctx2D, s: Shape): void {
  drawRecord(ctx, s.hdr[H.RGBA], s.hdr[H.FLAGS], s.hdrF[H.LINE_WIDTH], s.cmd, 0, s.cmd.length, s.vtx, 0);
}
