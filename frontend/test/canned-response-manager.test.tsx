// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Retiring a canned reply removes it from every reply box for the whole desk, so
 * it asks first — it used to be the last direct delete wired straight to a click.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const getCannedResponses = jest.fn<AnyFn>();
const deleteCannedResponse = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getCannedResponses: (...a: unknown[]) => getCannedResponses(...a),
    deleteCannedResponse: (...a: unknown[]) => deleteCannedResponse(...a),
    createCannedResponse: jest.fn(),
    updateCannedResponse: jest.fn(),
  },
}));

import { CannedResponseManager } from '@/components/message/CannedResponseManager';

beforeEach(() => {
  jest.clearAllMocks();
  getCannedResponses.mockResolvedValue({ success: true, data: { responses: [{ id: 'c1', title: 'Rotate a key', body: 'Go to settings…' }] } });
  deleteCannedResponse.mockResolvedValue({ success: true });
});

describe('CannedResponseManager retire', () => {
  it('asks before retiring, and Cancel retires nothing', async () => {
    render(<CannedResponseManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire Rotate a key' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/every reply box/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteCannedResponse).not.toHaveBeenCalled();
  });

  it('retires on confirm and re-reads the library', async () => {
    render(<CannedResponseManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire Rotate a key' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retire reply' }));
    await waitFor(() => expect(deleteCannedResponse).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(getCannedResponses).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
