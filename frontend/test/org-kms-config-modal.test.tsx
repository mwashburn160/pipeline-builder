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
import { ApiError } from '../src/lib/api/errors';

const getOrgKmsConfig = jest.fn<AnyFn>();
const putOrgKmsConfig = jest.fn<AnyFn>();
const deleteOrgKmsConfig = jest.fn<AnyFn>();
const retryRunnerKeyReencrypt = jest.fn<AnyFn>();
const stepUpProps = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class MockedApiError extends Error { statusCode = 0; },
  default: {
    getOrgKmsConfig: (...a: unknown[]) => getOrgKmsConfig(...a),
    putOrgKmsConfig: (...a: unknown[]) => putOrgKmsConfig(...a),
    deleteOrgKmsConfig: (...a: unknown[]) => deleteOrgKmsConfig(...a),
    testOrgKmsConfig: jest.fn(),
    retryRunnerKeyReencrypt: (...a: unknown[]) => retryRunnerKeyReencrypt(...a),
  },
}));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: (props: { onConfirmed: (t: string) => void }) => {
    stepUpProps(props);
    return <button data-testid="stepup-modal" onClick={() => props.onConfirmed('step-up-token')}>confirm</button>;
  },
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

  it('a failed change re-reads the binding, since the server may have changed it before failing', async () => {
    putOrgKmsConfig.mockRejectedValue(new Error('KMS config saved but re-encryption failed mid-flight: boom'));
    const onSaved = jest.fn<AnyFn>();
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} onSaved={onSaved} />);
    expect(await screen.findByText('alias/old')).toBeTruthy();
    getOrgKmsConfig.mockResolvedValue({ success: true, data: { configured: true, keyId: 'alias/new' } });
    await save();
    expect(await screen.findByText(/re-encryption failed mid-flight/)).toBeTruthy();
    expect(await screen.findByText('alias/new')).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
  });

  it('a new change clears the previous change\'s unreadable list', async () => {
    putOrgKmsConfig.mockResolvedValueOnce({ success: true, data: { configured: true, keyId: 'alias/new', unreadableConcurrentWrites: ['idpClientSecret'] } });
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} />);
    await screen.findByText('alias/old');
    await save();
    await screen.findByRole('alert', { name: /must be re-entered/i });
    putOrgKmsConfig.mockRejectedValueOnce(new Error('KMS test failed: nope'));
    await save();
    expect(await screen.findByText(/KMS test failed: nope/)).toBeTruthy();
    expect(screen.queryByRole('alert', { name: /must be re-entered/i })).toBeNull();
  });
});

describe('OrgKmsConfigModal: a pending runner-key re-wrap', () => {
  const PENDING = { success: true, data: { configured: true, keyId: 'alias/new', runnerRewrapPending: true } };
  const CLEAR = { success: true, data: { configured: true, keyId: 'alias/new', runnerRewrapPending: false } };
  const retryButton = () => screen.queryByRole('button', { name: /retry runner-key re-wrap/i });
  const retry = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /retry runner-key re-wrap/i }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));
  };

  it('offers no retry when nothing is pending', async () => {
    getOrgKmsConfig.mockResolvedValue(CLEAR);
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} />);
    await screen.findByText('alias/new');
    expect(retryButton()).toBeNull();
    expect(screen.queryByRole('alert', { name: /re-wrap pending/i })).toBeNull();
  });

  it('says a re-wrap is pending, offers the retry, and holds back Save and Clear (the server refuses them)', async () => {
    getOrgKmsConfig.mockResolvedValue(PENDING);
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} />);
    expect(await screen.findByRole('alert', { name: /re-wrap pending/i })).toBeTruthy();
    expect(retryButton()).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Clear$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/KMS key id/i), { target: { value: 'alias/next' } });
    fireEvent.change(screen.getByLabelText(/Wrapped master/i), { target: { value: 'TkVY' } });
    expect((screen.getByRole('button', { name: /Save & re-encrypt/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('retries through the strong-factor step-up and reports the re-wrapped keys', async () => {
    getOrgKmsConfig.mockResolvedValueOnce(PENDING).mockResolvedValue(CLEAR);
    retryRunnerKeyReencrypt.mockResolvedValue({ success: true, data: { runnerKeysReencrypted: 3, runnerKeysScanned: 3 } });
    const onSaved = jest.fn<AnyFn>();
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} onSaved={onSaved} />);
    await retry();
    expect(stepUpProps).toHaveBeenLastCalledWith(expect.objectContaining({ requireStrongFactor: true }));
    expect(retryRunnerKeyReencrypt).toHaveBeenCalledWith('org-1', 'step-up-token');
    expect(await screen.findByText(/re-wrapped 3 of 3 runner signing keys/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alert', { name: /re-wrap pending/i })).toBeNull());
    expect(retryButton()).toBeNull();
    expect(onSaved).toHaveBeenCalled();
  });

  it('a 409 says nothing was pending and drops the notice', async () => {
    getOrgKmsConfig.mockResolvedValueOnce(PENDING).mockResolvedValue(CLEAR);
    retryRunnerKeyReencrypt.mockRejectedValue(new ApiError('No runner signing key re-wrap is pending for this organization', 409, 'CONFLICT'));
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} />);
    await retry();
    expect(await screen.findByText(/nothing to retry/i)).toBeTruthy();
    await waitFor(() => expect(retryButton()).toBeNull());
  });

  it('a 500 says it failed again with the cause, and keeps the retry on offer', async () => {
    getOrgKmsConfig.mockResolvedValue(PENDING);
    retryRunnerKeyReencrypt.mockRejectedValue(new ApiError('pipeline service unreachable. The outgoing config is still recorded; retry once the cause is fixed.', 500));
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} />);
    await retry();
    const msg = await screen.findByText(/failed again/i);
    expect(msg.textContent).toMatch(/pipeline service unreachable/);
    expect(retryButton()).toBeTruthy();
    expect(screen.getByRole('alert', { name: /re-wrap pending/i })).toBeTruthy();
  });

  it('a PUT refused because a re-wrap is pending re-reads the binding and then offers the retry', async () => {
    getOrgKmsConfig.mockResolvedValueOnce(CLEAR).mockResolvedValue(PENDING);
    putOrgKmsConfig.mockRejectedValue(new ApiError("Cannot rotate KMS config: an earlier change's runner signing key re-wrap is still in progress or failed.", 409, 'CONFLICT'));
    render(<OrgKmsConfigModal org={ORG} onClose={() => {}} />);
    await screen.findByText('alias/new');
    await save();
    expect(await screen.findByRole('button', { name: /retry runner-key re-wrap/i })).toBeTruthy();
  });
});
