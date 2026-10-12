import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/**
 * A QR code holding `value` (the case id, P2), drawn as SVG so it prints sharply. A scanner
 * types the value into the keying screen.
 */
export function QrCode({
  value,
  label,
  size = 112,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(
      (s) => alive && setSvg(s),
      () => alive && setSvg(''),
    );
    return () => {
      alive = false;
    };
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label}
      data-qr={value}
      style={{ width: size, height: size }}
      // The SVG comes from the QR library and only encodes `value`.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
