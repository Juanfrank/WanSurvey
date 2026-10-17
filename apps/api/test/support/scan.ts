import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { PAGE, type Bubble } from '../../src/papi/omr/layout.js';
import { rasterize } from '../../src/papi/omr/read.js';

/**
 * Marks bubbles as a pen would (a filled disc), writes something by hand in some areas, then
 * "scans" the pages: rasterised and placed slightly rotated, shrunk and shifted.
 */
export async function fillAndScan(
  pdf: Uint8Array,
  marks: Bubble[],
  opts: { tilt?: number; order?: number[] } = {},
) {
  const doc = await PDFDocument.load(pdf);
  for (const b of marks)
    doc
      .getPage(b.page - 1)
      .drawCircle({ x: b.x, y: PAGE.h - b.y, size: 4.6, color: rgb(0.1, 0.1, 0.15) });
  const marked = await doc.save();
  const images = await rasterize(Buffer.from(marked), 110);
  const scan = await PDFDocument.create();
  const order = opts.order ?? images.map((_, i) => i);
  for (const i of order) {
    const png = await scan.embedPng(images[i]!.png);
    const p = scan.addPage([PAGE.w, PAGE.h]);
    p.drawImage(png, {
      x: 14,
      y: 4,
      width: PAGE.w * 0.96,
      height: PAGE.h * 0.96,
      rotate: degrees(opts.tilt ?? 0.8),
    });
  }
  return Buffer.from(await scan.save());
}
