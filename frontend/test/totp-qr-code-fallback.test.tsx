// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the enrolment panel does when the QR encoder can't produce a symbol.
 *
 * It must NOT be fatal: the panel always shows the base32 setup key beside the
 * code, so a person can still finish enrolling by typing it. Its own file
 * because making the encoder fail means stubbing the module, and the sibling
 * suite deliberately runs the real one.
 */

import { render, screen, act } from '@testing-library/react';

jest.mock('uqr', () => ({
  __esModule: true,
  encode: () => { throw new Error('no symbol for you'); },
}));

import { TotpQrCode } from '../src/components/settings/TotpQrCode';

describe('TotpQrCode — encoder failure', () => {
  it('points at the typed setup key instead of breaking the panel', async () => {
    await act(async () => { render(<TotpQrCode value="otpauth://totp/x?secret=ABCD" />); });

    expect(await screen.findByText(/enter the setup key below by hand/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
