import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import jsQRModule from 'jsqr';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PNG } from 'pngjs';
import { BUBBLE_R, FIDUCIAL, fiducialCentres, QR_AT, QR_SIZE, type Bubble } from './layout.js';

// The package is CommonJS: its function is the module itself.
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ??
  jsQRModule) as unknown as typeof jsQRModule.default;

/** pdf.js's own copies of the standard PDF fonts (text on a form drawn without them is blank). */
const FONTS = `${join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

/** Scans are read at this resolution: enough for marks, small enough to keep. */
export const DPI = 150;

export interface PageImage {
  width: number;
  height: number;
  /** Grey levels, one byte per pixel (0 black, 255 white). */
  grey: Uint8Array;
  png: Buffer;
}

/** The most pages read from one PDF: each is kept in memory while the batch is read. */
export const MAX_SCAN_PAGES = 300;

/** The longest side of a scanned page, in points: A3 and a little more. */
const MAX_PAGE_PTS = 1200;

/**
 * The pages of a PDF as grey images, drawn in this process (pdf.js on a native canvas: no
 * system tools, so it runs wherever Node does, App Service from a zip included). Page by page:
 * one canvas at a time is alive.
 */
export async function rasterize(pdf: Buffer, dpi = DPI): Promise<PageImage[]> {
  const task = getDocument({
    data: new Uint8Array(pdf),
    standardFontDataUrl: FONTS,
    // A scanned form needs no system fonts and nothing fetched.
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    // Refuse before rendering: a small file can hold thousands of pages or huge ones.
    const pages = doc.numPages;
    if (pages > MAX_SCAN_PAGES)
      throw new Error(`The PDF has ${pages} pages; upload at most ${MAX_SCAN_PAGES} per file`);
    // Every page, not only the first, is at most A3: anything bigger is not a scanned form.
    for (let n = 1; n <= pages; n++) {
      const [x0, y0, x1, y1] = (await doc.getPage(n)).view as [number, number, number, number];
      if (Math.abs(x1 - x0) > MAX_PAGE_PTS || Math.abs(y1 - y0) > MAX_PAGE_PTS)
        throw new Error('The PDF pages are larger than A3; scan the forms at their own size');
    }
    // And never more pixels than that, whatever the page says.
    const most = Math.ceil((MAX_PAGE_PTS / 72) * dpi);
    const out: PageImage[] = [];
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const width = Math.min(most, Math.ceil(viewport.width));
      const height = Math.min(most, Math.ceil(viewport.height));
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      await page.render({
        canvas: canvas as never,
        canvasContext: ctx as never,
        viewport,
      }).promise;
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const grey = new Uint8Array(width * height);
      for (let i = 0; i < grey.length; i++)
        grey[i] = Math.round(
          0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!,
        );
      // Kept as a grey PNG, as scanned forms were stored before.
      const png = PNG.sync.write(
        { width, height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length) } as PNG,
        { colorType: 0 },
      );
      out.push({ width, height, grey, png });
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}

type Pt = { x: number; y: number };
/** Page points to image pixels: x' = a·x + b·y + c, y' = d·x + e·y + f. */
export type Affine = [number, number, number, number, number, number];

export const apply = (t: Affine, p: Pt): Pt => ({
  x: t[0] * p.x + t[1] * p.y + t[2],
  y: t[3] * p.x + t[4] * p.y + t[5],
});

/** Least-squares affine map from `from` to `to` (three points or more). */
export function fitAffine(from: Pt[], to: Pt[]): Affine | null {
  // Normal equations for [a b c] (and [d e f]) over rows [x y 1].
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const vx = [0, 0, 0];
  const vy = [0, 0, 0];
  from.forEach((p, i) => {
    const r = [p.x, p.y, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) m[a * 3 + b]! += r[a]! * r[b]!;
      vx[a]! += r[a]! * to[i]!.x;
      vy[a]! += r[a]! * to[i]!.y;
    }
  });
  const solve = (v: number[]) => {
    const [a, b, c, d, e, f, g, h, k] = m as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-9) return null;
    const inv = [
      e * k - f * h,
      c * h - b * k,
      b * f - c * e,
      f * g - d * k,
      a * k - c * g,
      c * d - a * f,
      d * h - e * g,
      b * g - a * h,
      a * e - b * d,
    ].map((x) => x / det);
    return [0, 1, 2].map(
      (i) => inv[i * 3]! * v[0]! + inv[i * 3 + 1]! * v[1]! + inv[i * 3 + 2]! * v[2]!,
    );
  };
  const x = solve(vx);
  const y = solve(vy);
  if (!x || !y) return null;
  return [x[0]!, x[1]!, x[2]!, y[0]!, y[1]!, y[2]!];
}

/** Pixels per point of a map (its mean scale). */
export const scaleOf = (t: Affine) => Math.sqrt(Math.abs(t[0] * t[4] - t[1] * t[3]));

const rgba = (img: PageImage, x0: number, y0: number, w: number, h: number) => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = img.grey[(y0 + y) * img.width + x0 + x]!;
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  return out;
};

/**
 * The page's code and where it is: tried in each corner area first (fast, and pages may come
 * upside down), then on the whole page.
 */
export function findCode(img: PageImage): { text: string; corners: Pt[] } | null {
  const w = Math.round(img.width / 2);
  const h = Math.round(img.height / 3);
  const areas: [number, number, number, number][] = [
    [img.width - w, 0, w, h],
    [0, img.height - h, w, h],
    [0, 0, w, h],
    [img.width - w, img.height - h, w, h],
  ];
  const attempt = ([x0, y0, ww, hh]: [number, number, number, number], zoom: number) => {
    const data = zoom === 1 ? rgba(img, x0, y0, ww, hh) : zoomed(img, x0, y0, ww, hh, zoom);
    const r = jsQR(data, ww * zoom, hh * zoom, { inversionAttempts: 'dontInvert' });
    if (!r?.data) return null;
    const l = r.location;
    const at = (p: Pt) => ({ x: p.x / zoom + x0, y: p.y / zoom + y0 });
    return {
      text: r.data,
      corners: [
        at(l.topLeftCorner),
        at(l.topRightCorner),
        at(l.bottomLeftCorner),
        at(l.bottomRightCorner),
      ],
    };
  };
  // Each corner area as it is, then the whole page, then the corner areas enlarged (small
  // or blurred codes read better twice as large).
  for (const a of areas) {
    const r = attempt(a, 1);
    if (r) return r;
  }
  return (
    attempt([0, 0, img.width, img.height], 1) ??
    areas.map((a) => attempt(a, 2)).find(Boolean) ??
    null
  );
}

/** A part of the page enlarged `k` times, smoothly (bilinear), as RGBA. */
function zoomed(img: PageImage, x0: number, y0: number, w: number, h: number, k: number) {
  const W = w * k;
  const H = h * k;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1.001, y / k);
    const iy = Math.floor(sy);
    const fy = sy - iy;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1.001, x / k);
      const ix = Math.floor(sx);
      const fx = sx - ix;
      const g = (dx: number, dy: number) => img.grey[(y0 + iy + dy) * img.width + x0 + ix + dx]!;
      const v =
        g(0, 0) * (1 - fx) * (1 - fy) +
        g(1, 0) * fx * (1 - fy) +
        g(0, 1) * (1 - fx) * fy +
        g(1, 1) * fx * fy;
      const i = (y * W + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Darkness below this grey level counts as ink. */
const INK = 140;

/** The centre of the dark square near `guess`, or null when no square is there. */
function findFiducial(img: PageImage, guess: Pt, side: number): Pt | null {
  let c = guess;
  let radius = side * 1.6;
  let count = 0;
  for (let round = 0; round < 4; round++) {
    let sx = 0;
    let sy = 0;
    count = 0;
    const r = Math.round(radius);
    for (let y = Math.round(c.y) - r; y <= Math.round(c.y) + r; y++) {
      if (y < 0 || y >= img.height) continue;
      for (let x = Math.round(c.x) - r; x <= Math.round(c.x) + r; x++) {
        if (x < 0 || x >= img.width) continue;
        if (img.grey[y * img.width + x]! < INK) {
          sx += x;
          sy += y;
          count++;
        }
      }
    }
    if (!count) return null;
    c = { x: sx / count, y: sy / count };
    radius = side * 0.8;
  }
  // A filled square of about the right size.
  const expected = side * side;
  return count > expected * 0.5 && count < expected * 1.6 ? c : null;
}

/**
 * Where the page sits in the image: first from the code's corners, then refined with the four
 * corner squares (which span the page, so small rotations and stretches come out right).
 */
export function locate(img: PageImage, code: { corners: Pt[] }): Affine | null {
  const qr = [
    { x: QR_AT.x, y: QR_AT.y },
    { x: QR_AT.x + QR_SIZE, y: QR_AT.y },
    { x: QR_AT.x, y: QR_AT.y + QR_SIZE },
    { x: QR_AT.x + QR_SIZE, y: QR_AT.y + QR_SIZE },
  ];
  const rough = fitAffine(qr, code.corners);
  if (!rough) return null;
  const side = FIDUCIAL * scaleOf(rough);
  const from: Pt[] = [];
  const to: Pt[] = [];
  for (const f of fiducialCentres()) {
    const found = findFiducial(img, apply(rough, f), side);
    if (found) {
      from.push(f);
      to.push(found);
    }
  }
  return from.length >= 3 ? (fitAffine(from, to) ?? rough) : rough;
}

/** How much of the inside of a bubble is inked (0 empty, 1 full). */
export function fill(img: PageImage, t: Affine, b: Bubble): number {
  const c = apply(t, b);
  const r = BUBBLE_R * scaleOf(t) * 0.62;
  let dark = 0;
  let all = 0;
  const r2 = r * r;
  for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++)
    for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      if ((x - c.x) ** 2 + (y - c.y) ** 2 > r2) continue;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      all++;
      if (img.grey[y * img.width + x]! < INK) dark++;
    }
  return all ? dark / all : 0;
}
