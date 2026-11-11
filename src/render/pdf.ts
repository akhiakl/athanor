// Minimal PDF 1.4 writer, spec 3.4.3: no fonts, no compression, one PDF page per document page. Paths become path operators, alpha
// becomes ExtGState, and gradients become shading patterns (with a luminosity soft mask when the two end alphas differ).
// shortcut: content streams are uncompressed (a CompressionStream option can follow) and there is no baked-base image (no baking yet, 2.7).
import { CLOSE, CUBIC, F_EVENODD, F_FILL, F_GRADIENT, H, LINE, MOVE, QUAD } from '../core/arena';
import type { Entry } from './committed';
import { num } from './export';

export interface PdfPage {
  width: number;
  height: number;
  /** 0xRRGGBB */
  background: number;
  entries: readonly Entry[];
}

const c3 = (v: number): string => {
  const r = Math.round((v / 255) * 1000) / 1000;
  return r === 0 ? '0' : String(r);
};
const rgb = (rgba: number): string => `${c3((rgba >>> 24) & 255)} ${c3((rgba >>> 16) & 255)} ${c3((rgba >>> 8) & 255)}`;
const alphaOf = (rgba: number): number => rgba & 255;
const esc = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');

/** Path operators for a shape's command stream; QUAD is raised to a cubic (control points two thirds toward the quad control). */
function pathOps(s: { cmd: Uint8Array; vtx: Float32Array }): string {
  let out = '';
  let v = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (let i = 0; i < s.cmd.length; i++) {
    switch (s.cmd[i]) {
      case MOVE: cx = sx = s.vtx[v]; cy = sy = s.vtx[v + 1]; out += `${num(cx)} ${num(cy)} m\n`; v += 2; break;
      case LINE: cx = s.vtx[v]; cy = s.vtx[v + 1]; out += `${num(cx)} ${num(cy)} l\n`; v += 2; break;
      case QUAD: {
        const qx = s.vtx[v], qy = s.vtx[v + 1], x = s.vtx[v + 2], y = s.vtx[v + 3];
        out += `${num(cx + (2 / 3) * (qx - cx))} ${num(cy + (2 / 3) * (qy - cy))} ${num(x + (2 / 3) * (qx - x))} ${num(y + (2 / 3) * (qy - y))} ${num(x)} ${num(y)} c\n`;
        cx = x; cy = y; v += 4;
        break;
      }
      case CUBIC:
        out += `${num(s.vtx[v])} ${num(s.vtx[v + 1])} ${num(s.vtx[v + 2])} ${num(s.vtx[v + 3])} ${num(s.vtx[v + 4])} ${num(s.vtx[v + 5])} c\n`;
        cx = s.vtx[v + 4]; cy = s.vtx[v + 5]; v += 6;
        break;
      case CLOSE: out += 'h\n'; cx = sx; cy = sy; break;
    }
  }
  return out;
}

class Doc {
  private readonly objs: string[] = [''];
  alloc(): number {
    return this.objs.push('') - 1;
  }
  set(n: number, body: string): void {
    this.objs[n] = body;
  }
  stream(n: number, dict: string, data: string): void {
    this.objs[n] = `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
  }
  get count(): number {
    return this.objs.length - 1;
  }
  body(n: number): string {
    return this.objs[n];
  }
}

/** Builds the document. Every character is ASCII except the 4-byte binary marker after the header, so string length is byte length. */
export function pdfBytes(pages: readonly PdfPage[], { title = 'Athanor', created = new Date() }: { title?: string; created?: Date } = {}): Uint8Array {
  const d = new Doc();
  const catalog = d.alloc(), tree = d.alloc(), info = d.alloc();
  const pageIds: number[] = [];
  const p2 = (n: number): string => String(n).padStart(2, '0');
  d.set(info, `<< /Title (${esc(title)}) /Creator (Athanor) /CreationDate (D:${created.getUTCFullYear()}${p2(created.getUTCMonth() + 1)}${p2(created.getUTCDate())}${p2(created.getUTCHours())}${p2(created.getUTCMinutes())}${p2(created.getUTCSeconds())}Z) >>`);

  for (const page of pages) {
    const W = num(page.width), Ht = num(page.height);
    const pageObj = d.alloc(), content = d.alloc();
    pageIds.push(pageObj);
    const gs = new Map<number, number>(); // alpha byte -> ExtGState object
    const states: string[] = [];
    const patterns: string[] = [];
    const alphaState = (a: number): string => {
      let id = gs.get(a);
      if (id === undefined) {
        id = d.alloc();
        d.set(id, `<< /Type /ExtGState /ca ${c3(a)} /CA ${c3(a)} >>`);
        gs.set(a, id);
        states.push(`/G${a} ${id} 0 R`);
      }
      return `/G${a}`;
    };
    let nPat = 0;
    const gradient = (x1: number, y1: number, x2: number, y2: number, c1: number, c2: number): { pat: string; state: string } => {
      const k = ++nPat;
      const coords = `[${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)}]`;
      const shade = d.alloc();
      d.set(shade, `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords ${coords} /Function << /FunctionType 2 /Domain [0 1] /C0 [${rgb(c1)}] /C1 [${rgb(c2)}] /N 1 >> /Extend [true true] >>`);
      const pat = d.alloc();
      d.set(pat, `<< /Type /Pattern /PatternType 2 /Shading ${shade} 0 R /Matrix [1 0 0 -1 0 ${Ht}] >>`); // pattern space is the unflipped page
      patterns.push(`/P${k} ${pat} 0 R`);
      const a1 = alphaOf(c1), a2 = alphaOf(c2);
      if (a1 === a2) return { pat: `/P${k}`, state: a1 === 255 ? '' : alphaState(a1) };
      // different end alphas: a luminosity mask whose form paints the same gradient in gray (form space is the flipped canvas)
      const gray = d.alloc();
      d.set(gray, `<< /ShadingType 2 /ColorSpace /DeviceGray /Coords ${coords} /Function << /FunctionType 2 /Domain [0 1] /C0 [${c3(a1)}] /C1 [${c3(a2)}] /N 1 >> /Extend [true true] >>`);
      const mpat = d.alloc();
      d.set(mpat, `<< /Type /Pattern /PatternType 2 /Shading ${gray} 0 R >>`);
      const form = d.alloc();
      d.stream(form, `/Type /XObject /Subtype /Form /BBox [0 0 ${W} ${Ht}] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /Pattern << /M${k} ${mpat} 0 R >> >>`, `/Pattern cs /M${k} scn 0 0 ${W} ${Ht} re f`);
      const state = d.alloc();
      d.set(state, `<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${form} 0 R >> >>`);
      states.push(`/S${k} ${state} 0 R`);
      return { pat: `/P${k}`, state: `/S${k}` };
    };

    let ops = `1 0 0 -1 0 ${Ht} cm\n${rgb((page.background << 8) | 255)} rg\n0 0 ${W} ${Ht} re f\n`;
    for (const e of page.entries) {
      if (!e.alive) continue;
      const { hdr, hdrF, cmd, vtx } = e.shape;
      const rgba = hdr[H.RGBA];
      const flags = hdr[H.FLAGS];
      const fill = (flags & F_FILL) !== 0;
      let paintOps: string;
      let state = alphaOf(rgba) === 255 ? '' : alphaState(alphaOf(rgba));
      const x1 = hdrF[H.GX1], y1 = hdrF[H.GY1], x2 = hdrF[H.GX2], y2 = hdrF[H.GY2];
      if (flags & F_GRADIENT && (x1 !== x2 || y1 !== y2)) {
        const g = gradient(x1, y1, x2, y2, rgba, hdr[H.GRADIENT_RGBA2]);
        state = g.state;
        paintOps = fill ? `/Pattern cs ${g.pat} scn\n` : `/Pattern CS ${g.pat} SCN\n`;
      } else paintOps = fill ? `${rgb(rgba)} rg\n` : `${rgb(rgba)} RG\n`;
      const width = fill ? '' : `${num(hdrF[H.LINE_WIDTH])} w 1 J 2 j\n`; // round cap, bevel join (legacy BasicStroke)
      ops += `q\n${state ? `${state} gs\n` : ''}${paintOps}${width}${pathOps({ cmd, vtx })}${fill ? (flags & F_EVENODD ? 'f*' : 'f') : 'S'}\nQ\n`;
    }
    d.stream(content, '', ops);
    d.set(pageObj, `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${W} ${Ht}] /Contents ${content} 0 R /Resources << ${states.length ? `/ExtGState << ${states.join(' ')} >> ` : ''}${patterns.length ? `/Pattern << ${patterns.join(' ')} >> ` : ''}>> /Group << /S /Transparency /CS /DeviceRGB >> >>`);
  }
  d.set(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`);
  d.set(tree, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  let out = `%PDF-1.4\n%${String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3)}\n`;
  const offsets: number[] = [0];
  for (let n = 1; n <= d.count; n++) {
    offsets.push(out.length);
    out += `${n} 0 obj\n${d.body(n)}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${d.count + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= d.count; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${d.count + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}

export const pdfBlob = (pages: readonly PdfPage[], opts?: { title?: string; created?: Date }): Blob => new Blob([pdfBytes(pages, opts) as BlobPart], { type: 'application/pdf' });
