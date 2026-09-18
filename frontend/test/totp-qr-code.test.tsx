// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The enrolment QR code, against the REAL encoder.
 *
 * Stubbing `uqr` here would leave nothing under test — the component is a thin
 * matrix-to-`<rect>` renderer, and what could actually break is the dynamic
 * import resolving, or the matrix shape changing. So the encoder runs for real
 * and the output is checked for the properties a phone camera depends on: a
 * square matrix, a white ground regardless of theme, and a quiet zone.
 *
 * The encode-failure fallback is its own file (`totp-qr-code-fallback`), which
 * has to stub the encoder to make it fail at all.
 */

import { render, screen, act, waitFor } from '@testing-library/react';

import { TotpQrCode } from '../src/components/settings/TotpQrCode';

const URI = 'otpauth://totp/Pipeline%20Builder:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Pipeline+Builder';

describe('TotpQrCode', () => {
  it('renders a square, labelled QR symbol from the real encoder', async () => {
    await act(async () => { render(<TotpQrCode value={URI} size={180} />); });

    const svg = await screen.findByRole('img', { name: /scan this qr code/i });
    // `viewBox` is "0 0 n n" — a QR symbol is square by construction, and a
    // non-square one would mean the matrix was mangled.
    const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    // Version 1 is 21 modules; the quiet zone adds 2 on each side.
    expect(w).toBeGreaterThanOrEqual(25);

    const modules = svg.querySelectorAll('rect');
    expect(modules.length).toBeGreaterThan(50);
    // Dark modules only — the ground is the element's own white background, so
    // the symbol stays readable in a dark-themed page.
    expect(svg).toHaveClass('bg-white');
    expect([...modules].every((r) => r.getAttribute('fill') === '#000000')).toBe(true);
  });

  it('leaves a quiet zone — the outermost ring carries no modules', async () => {
    await act(async () => { render(<TotpQrCode value={URI} />); });
    const svg = await screen.findByRole('img', { name: /scan this qr code/i });
    const size = Number(svg.getAttribute('viewBox')!.split(' ')[3]);

    const onEdge = [...svg.querySelectorAll('rect')].some((r) => {
      const x = Number(r.getAttribute('x'));
      const y = Number(r.getAttribute('y'));
      return x === 0 || y === 0 || x === size - 1 || y === size - 1;
    });
    expect(onEdge).toBe(false);
  });

  it('re-encodes when the enrolment changes', async () => {
    const { rerender } = render(<TotpQrCode value={URI} />);
    const first = (await screen.findByRole('img')).innerHTML;

    await act(async () => {
      rerender(<TotpQrCode value={`${URI}&x=different-secret-entirely`} />);
    });
    await waitFor(async () => {
      expect((await screen.findByRole('img')).innerHTML).not.toBe(first);
    });
  });

});
