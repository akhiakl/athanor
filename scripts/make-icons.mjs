// Generates the app icons (public/icons/*.png and icon.svg) with no dependencies: a PNG encoder over zlib and a distance-field mark,
// a ring with a dot (the athanor, the alchemist's furnace). Run `node scripts/make-icons.mjs` after changing the mark; the output is committed.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [20, 20, 24];
const FG = [124, 156, 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d)); // anti-aliased edge from a signed distance in pixels

/**
 * kind: 'any' rounded square, 'maskable' full bleed with the mark inside the safe zone, 'mono' the mark only, white on transparent.
 * The mark scales with `scale` (1 = fills about 62% of the icon).
 */
function render(size, kind) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const mark = size * (kind === 'maskable' ? 0.27 : 0.31); // ring outer radius
  const ring = mark * 0.26, dot = mark * 0.34, corner = size * 0.22;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x + 0.5 - c, py = y + 0.5 - c;
    const r = Math.hypot(px, py);
    const inRing = cover(Math.abs(r - (mark - ring / 2)) - ring / 2);
    const inDot = cover(r - dot);
    const glyph = Math.max(inRing, inDot);
    // rounded square signed distance
    const qx = Math.abs(px) - (c - corner), qy = Math.abs(py) - (c - corner);
    const sq = cover(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner);
    let col, a;
    if (kind === 'mono') { col = [255, 255, 255]; a = glyph; }
    else {
      const bgA = kind === 'maskable' ? 1 : sq;
      col = mix(BG, FG, glyph);
      a = bgA;
    }
    const o = (y * size + x) * 4;
    buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; buf[o + 3] = Math.round(a * 255);
  }
  return png(size, buf);
}

const files = { 'icon-192.png': [192, 'any'], 'icon-512.png': [512, 'any'], 'icon-maskable-512.png': [512, 'maskable'], 'icon-mono-512.png': [512, 'mono'], 'apple-touch-icon.png': [180, 'maskable'] };
for (const [name, [size, kind]] of Object.entries(files)) writeFileSync(new URL(name, OUT), render(size, kind));

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
writeFileSync(new URL('icon.svg', OUT), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="113" fill="${hex(BG)}"/><circle cx="256" cy="256" r="${(512 * 0.31 * (1 - 0.13)).toFixed(1)}" fill="none" stroke="${hex(FG)}" stroke-width="${(512 * 0.31 * 0.26).toFixed(1)}"/><circle cx="256" cy="256" r="${(512 * 0.31 * 0.34).toFixed(1)}" fill="${hex(FG)}"/></svg>\n`);
console.log('icons written to public/icons');
