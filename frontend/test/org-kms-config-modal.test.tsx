// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sysadmin KMS config modal. A change can land (200) while a secret a
 * stale replica wrote under the OLD key mid-migration stays unreadable
 * (`unreadableConcurrentWrites`) — the modal must say which ones, not close
 * as if everything moved.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OrgKmsConfigModal } from '../src/components/admin/OrgKmsConfigModal';

const getOrgKmsConfig = jest.fn<AnyFn>();
const putOrgKmsConfig = jest.fn<AnyFn>();
const deleteOrgKmsConfig = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    getOrgKmsConfig: (...a: unknown[]) => getOrgKmsConfig(...a),
    putOrgKmsConfig: (...a: unknown[]) => putOrgKmsConfig(...a),
    deleteOrgKmsConfig: (...a: unknown[]) => deleteOrgKmsConfig(...a),
    testOrgKmsConfig: jest.fn(),
  },
}));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>
  ),
}));

const ORG = { id: 'org-1', name: 'Acme' } as never;

beforeEach(() => {
  jest.clearAllMocks();
  getOrgKmsConfig.mockResolvedValue({ success: true, data: { configured: true, keyId: 'alias/old' } });
});

async function save() {
  fireEvent.change(screen.getByLabelText(/KMS key id/i), { target: { value: 'alias/new' } });
  fireEvent.change(screen.getByLabelText(/Wrapped master/i), { target: { value: 'TkVX' } });
  fireEvent.click(screen.getByRole('button', { name: /Save & re-encrypt/i }));
  fireEvent.click(await screen.findByTestId('stepup-modal'));
}

describe('OrgKmsConfigModal: the change result', () => {
  it('a clean rotation closes the modal', async () => {
    putOrgKmsConfig.mockResolvedValue({ success: true, data: { configured: true, keyId: 'alias/new', concurrentlyChanged: [], unreadableConcurrentWrites: [] } });
    const onClose = jest.fn<AnyFn>();
    render(<OrgKmsConfigModal org={ORG} onClose={onClose} />);
    await save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a rotation that left secrets unreadable stays open and names them', async () => {
    putOrgKmsConfig.mockResolvedValue({
      success: true,
      data: {
        configured: true,
        keyId: 'alias/new',
        concurrentlyChanged: ['aiProviderKeys.openai', 'idpClientSecret'],
        unreadableConcurrentWrites: ['aiProviderKeys.openai'],
      },
    });
    const onClose = jest.fn<AnyFn>();
    const onSaved = jest.fn<AnyFn>();
    render(<OrgKmsConfigModal org={ORG} onClose={onClose} onSaved={onSaved} />);
    await save();
    const notice = await screen.findByRole('alert', { name: /must be re-entered/i });
    expect(notice.textContent).toMatch(/aiProviderKeys\.openai/);
    expect(notice.textContent).not.toMatch(/idpClientSecret/);
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a clear that left secrets unreadable stays open and names them', async () => {
    deleteOrgKmsConfig.mockResolvedValue({ success: true, data: { configured: false, unreadableConcurrentWrites: ['idpClientSecret'] } });
    const onClose = jest.fn<AnyFn>();
    render(<OrgKmsConfigModal org={ORG} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Clear$/ }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
    const notice = await screen.findByRole('alert', { name: /must be re-entered/i });
    expect(notice.textContent).toMatch(/idpClientSecret/);
    expect(onClose).not.toHaveBeenCalled();
  });
});
