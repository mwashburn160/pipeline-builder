// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Create → 409 (the project already has a pipeline) → "Overwrite it".
 *
 * A refused overwrite is reported on the create form's error line. The dialog
 * must close once the overwrite settles, or it sits in front of that error with
 * a button that silently repeats the failure.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { ApiError } from '@/lib/api/errors';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: false, isLoaded: true, label: 'x', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
jest.mock('@/components/pipeline/DeployedPipelinesPanel', () => ({ __esModule: true, DeployedPipelinesPanel: () => null }));

// Every dynamic() modal is the create stub: it submits a fixed body and shows
// the form's error line, which is all this flow needs from it.
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => function CreateStub({ onSubmit, onClose, createError, createdPipelineId }: { onSubmit?: (...a: unknown[]) => void; onClose?: () => void; createError?: string | null; createdPipelineId?: string | null }) {
    if (!onSubmit) return null;
    return (
      <div>
        {createdPipelineId && <p>created: {createdPipelineId}</p>}
        <button type="button" onClick={() => onSubmit({ project: 'web', organization: 'acme', pipelineName: 'web-pipeline' }, 'org')}>stub-submit</button>
        {onClose && <button type="button" onClick={onClose}>stub-close</button>}
        {createError && <p>form-error: {createError}</p>}
      </div>
    );
  },
}));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/pipelines', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const createPipeline = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPipelines: () => Promise.resolve({ success: true, data: { pipelines: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
    createPipeline: (...a: unknown[]) => createPipeline(...a),
  },
}));

import PipelinesPage from '../pages/dashboard/pipelines';

beforeEach(() => {
  createPipeline.mockReset();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
});

describe('pipelines — overwrite after a slot conflict', () => {
  it('a refused overwrite closes the dialog so the form\'s error is visible', async () => {
    createPipeline
      .mockRejectedValueOnce(new ApiError('Slot taken', 409, 'CONFLICT', { pipelineName: 'web-pipeline' }))
      .mockRejectedValueOnce(new ApiError('Not the owner of the existing pipeline', 403, 'FORBIDDEN'));
    render(<PipelinesPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /create pipeline/i }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'stub-submit' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Overwrite it' }));
    await waitFor(() => expect(createPipeline).toHaveBeenLastCalledWith(expect.anything(), { upsert: true }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Overwrite it' })).not.toBeInTheDocument());
    expect(screen.getByText(/form-error: .*Not the owner/)).toBeInTheDocument();
  });
});

describe('pipelines — post-create next step', () => {
  it('a new pipeline keeps the dialog open on its deploy next step (no auto-close)', async () => {
    jest.useFakeTimers();
    try {
      createPipeline.mockResolvedValue({ success: true, data: { inserted: true, pipeline: { id: 'p-new' } } });
      render(<PipelinesPage />);
      fireEvent.click((await screen.findAllByRole('button', { name: /create pipeline/i }))[0]);
      fireEvent.click(await screen.findByRole('button', { name: 'stub-submit' }));
      expect(await screen.findByText('created: p-new')).toBeInTheDocument();
      act(() => { jest.advanceTimersByTime(5000); });
      expect(screen.getByText('created: p-new')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('pipelines — post-create auto-close', () => {
  it('a create modal reopened after closing by hand is not shut by the earlier auto-close', async () => {
    jest.useFakeTimers();
    try {
      createPipeline.mockResolvedValue({ success: true, data: { inserted: true } });
      render(<PipelinesPage />);
      fireEvent.click((await screen.findAllByRole('button', { name: /create pipeline/i }))[0]);
      fireEvent.click(await screen.findByRole('button', { name: 'stub-submit' }));
      await waitFor(() => expect(createPipeline).toHaveBeenCalledTimes(1));
      await act(async () => {});

      // Closed by hand inside the 2s window, then opened again for the next one.
      fireEvent.click(screen.getByRole('button', { name: 'stub-close' }));
      expect(screen.queryByRole('button', { name: 'stub-submit' })).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /create pipeline/i })[0]);
      expect(screen.getByRole('button', { name: 'stub-submit' })).toBeInTheDocument();

      act(() => { jest.advanceTimersByTime(5000); });
      expect(screen.getByRole('button', { name: 'stub-submit' })).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
