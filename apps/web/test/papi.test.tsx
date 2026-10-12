import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QrCode } from '../src/papi/QrCode.js';

describe('paper forms', () => {
  it('draws the case id as a QR code (SVG) with an accessible name', async () => {
    const { container, getByRole } = render(
      <QrCode value="HH0007" label="QR code of case HH0007" />,
    );
    expect(getByRole('img', { name: 'QR code of case HH0007' })).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-qr="HH0007"] svg')).not.toBeNull());
    expect(container.querySelector('svg path')).not.toBeNull();
  });
});
