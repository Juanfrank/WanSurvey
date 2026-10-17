import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import {
  BUBBLE_R,
  FIDUCIAL,
  fiducialCentres,
  MARGIN,
  PAGE,
  pageCode,
  printable,
  QR_AT,
  QR_SIZE,
  type FormLayout,
  type Font,
  type Measure,
} from './layout.js';

/** Text widths with the PDF's standard fonts, the same for drawing and for reading. */
export async function measurer(): Promise<Measure> {
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  return (text, size, font) => fonts[font].widthOfTextAtSize(printable(text), size);
}

async function embedFonts(doc: PDFDocument): Promise<Record<Font, PDFFont>> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
}

export interface ScanFormCase {
  caseId: string;
  externalId: string;
}

export interface ScanFormHeader {
  title: string;
  versionId: string;
  lang: string;
  /** Printed on the first page: how to mark. */
  instructions: string;
  pageOf: (n: number, of: number) => string;
}

/**
 * The machine-readable paper forms of some cases, one after another in one PDF: each page has
 * the four corner squares and a code naming the case, version, language and page.
 */
export async function scanFormsPdf(
  layout: FormLayout,
  header: ScanFormHeader,
  cases: ScanFormCase[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(header.title);
  doc.setCreator('WanSurvey');
  const fonts = await embedFonts(doc);
  const ink = rgb(0, 0, 0);
  const grey = rgb(0.35, 0.35, 0.35);
  const Y = (y: number) => PAGE.h - y;
  for (const c of cases) {
    const pages = Array.from({ length: layout.pages }, () => doc.addPage([PAGE.w, PAGE.h]));
    pages.forEach((p, i) => {
      const n = i + 1;
      for (const f of fiducialCentres())
        p.drawRectangle({
          x: f.x - FIDUCIAL / 2,
          y: Y(f.y + FIDUCIAL / 2),
          width: FIDUCIAL,
          height: FIDUCIAL,
          color: ink,
        });
      const qr = QRCode.create(pageCode(c.caseId, header.versionId, header.lang, n, layout.pages), {
        errorCorrectionLevel: 'M',
      });
      const size = qr.modules.size;
      const m = QR_SIZE / size;
      for (let r = 0; r < size; r++)
        for (let col = 0; col < size; col++)
          if (qr.modules.get(r, col))
            p.drawRectangle({
              x: QR_AT.x + col * m,
              y: Y(QR_AT.y + (r + 1) * m),
              width: m,
              height: m,
              color: ink,
            });
      const left = MARGIN + FIDUCIAL + 10;
      p.drawText(printable(header.title).slice(0, 70), {
        x: left,
        y: Y(MARGIN + 11),
        size: 11,
        font: fonts.bold,
      });
      p.drawText(printable(c.externalId), {
        x: left,
        y: Y(MARGIN + 27),
        size: 12,
        font: fonts.mono,
      });
      p.drawText(printable(header.pageOf(n, layout.pages)), {
        x: left,
        y: Y(MARGIN + 41),
        size: 8,
        font: fonts.regular,
        color: grey,
      });
      if (n === 1) {
        p.drawCircle({ x: left + BUBBLE_R, y: Y(MARGIN + 56), size: BUBBLE_R, color: ink });
        p.drawText(printable(header.instructions), {
          x: left + 2 * BUBBLE_R + 4,
          y: Y(MARGIN + 59),
          size: 8,
          font: fonts.regular,
          maxWidth: QR_AT.x - left - 30,
        });
      }
      p.drawText(printable(`${c.externalId} · ${header.pageOf(n, layout.pages)}`), {
        x: MARGIN + FIDUCIAL + 10,
        y: Y(PAGE.h - MARGIN - 4),
        size: 7,
        font: fonts.regular,
        color: grey,
      });
    });
    for (const op of layout.ops) {
      const p = pages[op.page - 1]!;
      if (op.op === 'text')
        p.drawText(op.text, { x: op.x, y: Y(op.y), size: op.size, font: fonts[op.font] });
      else if (op.op === 'bubble')
        p.drawCircle({
          x: op.x,
          y: Y(op.y),
          size: BUBBLE_R,
          borderColor: grey,
          borderWidth: 0.8,
        });
      else if (op.op === 'box')
        p.drawRectangle({
          x: op.x,
          y: Y(op.y + op.h),
          width: op.w,
          height: op.h,
          borderColor: grey,
          borderWidth: 0.6,
        });
      else
        p.drawLine({
          start: { x: op.x, y: Y(op.y) },
          end: { x: op.x + op.w, y: Y(op.y) },
          thickness: 0.5,
          color: grey,
        });
    }
  }
  return doc.save();
}
