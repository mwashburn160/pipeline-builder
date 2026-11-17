// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Create-from-Git-URL, through the REAL CreatePipelineModal → GitUrlTab →
 * useRepoAnalysis chain, with only `@/lib/api` mocked (the SSE stream is an
 * async generator the test scripts):
 *  - the stream's analysis, plugin check and missing-plugin PROPOSAL render,
 *    and nothing is created until the user confirms the names they picked;
 *  - the generated props (with the project/organization overrides) plus the
 *    generated description/keywords reach `onSubmit`;
 *  - Create before generating says to generate first; a stream error shows;
 *  - an `initialUrl` + `autoGenerate` (the dashboard hero) starts on its own.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { mockAuthGuard } from './helpers/pageMocks';
import { apiFn, resetApiMock } from './helpers/apiMock';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: true, isLoaded: true, label: 'AI', description: '', unlocks: '', upsellHref: '/', reason: '' }),
}));

import CreatePipelineModal from '@/components/pipeline/CreatePipelineModal';

const GENERATED = {
  project: 'web', organization: 'acme',
  synth: { source: { type: 'github', options: { repo: 'acme/web' } }, plugin: { name: 'cdk-synth' } },
  stages: [{ stageName: 'Test', steps: [{ plugin: { name: 'jest-runner' } }] }],
};

function stream(events: Array<{ type: string; data?: unknown }>) {
  return (async function* run() { for (const e of events) yield e; })();
}

function renderModal(over: Record<string, unknown> = {}) {
  const onSubmit = jest.fn<AnyFn>().mockResolvedValue(undefined);
  render(
    <CreatePipelineModal isOpen onClose={jest.fn<AnyFn>()} onSubmit={onSubmit} createLoading={false} createError={null} createSuccess={null} canPublish {...over} />,
  );
  return { onSubmit };
}

beforeEach(() => {
  resetApiMock();
  mockAuthGuard({ can: () => true });
  apiFn('getAIProviders').mockResolvedValue({ success: true, data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'm1', name: 'M1' }] }] } });
  apiFn('getAskProviders').mockResolvedValue({ success: true, data: { providers: [] } });
  apiFn('getOrgAIConfig').mockResolvedValue({ success: true, data: { providers: {}, aiEnabled: true } });
});

describe('GitUrlTab inside the create modal', () => {
  it('streams analysis + a missing-plugin proposal, creates only what was confirmed, and submits the result', async () => {
    apiFn('streamPipelineFromUrl').mockImplementation(() => stream([
      { type: 'analyzing' },
      { type: 'analyzed', data: { owner: 'acme', repo: 'web', provider: 'github', defaultBranch: 'main', projectType: 'node', languages: { TypeScript: 100 }, frameworks: ['next'], packageManager: 'pnpm', hasDockerfile: false, hasCdkJson: true, description: '' } },
      { type: 'partial', data: { stages: [{}, {}] } },
      { type: 'checking-plugins' },
      { type: 'missing-plugins', data: { existing: ['cdk-synth'], proposed: ['jest-runner', 'lint'], refused: [{ name: 'bad name', error: 'unsafe name' }] } },
      { type: 'done', data: { props: GENERATED, description: 'Generated web pipeline', keywords: ['web', 'node'] } },
    ]));
    apiFn('createMissingPlugins').mockResolvedValue({ success: true, data: { created: ['jest-runner'], existing: [], builds: [{ name: 'jest-runner', requestId: 'r1' }] } });
    const { onSubmit } = renderModal();

    const url = await screen.findByLabelText('Git repository URL');
    const generate = screen.getByRole('button', { name: /Generate from URL/ });
    expect(generate).toBeDisabled();
    fireEvent.change(url, { target: { value: 'https://github.com/acme/web' } });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    expect(await screen.findByTestId('missing-plugins-proposal')).toBeInTheDocument();
    expect(apiFn('streamPipelineFromUrl')).toHaveBeenCalledWith('https://github.com/acme/web', 'anthropic', 'm1', undefined, undefined);
    expect(screen.getByText('bad name')).toBeInTheDocument();
    expect(apiFn('createMissingPlugins')).not.toHaveBeenCalled();

    // Untick one of the two proposed names, then confirm.
    fireEvent.click(screen.getByText('lint').closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: /Create 1 placeholder plugin$/ }));
    await waitFor(() => expect(apiFn('createMissingPlugins')).toHaveBeenCalledWith(['jest-runner']));
    await waitFor(() => expect(screen.queryByTestId('missing-plugins-proposal')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [props, visibility, desc, keywords] = onSubmit.mock.calls[0];
    expect(props).toMatchObject({ project: 'web', organization: 'acme', stages: GENERATED.stages });
    expect(visibility).toBe('org');
    expect(desc).toBe('Generated web pipeline');
    expect(keywords).toEqual(['web', 'node']);
  });

  it('Create before generating asks for a generation; a stream error is shown', async () => {
    apiFn('streamPipelineFromUrl').mockImplementation(() => stream([{ type: 'error', data: { message: 'Repository not found' } }]));
    const { onSubmit } = renderModal();
    await screen.findByLabelText('Git repository URL');
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText('Generate a configuration first using the button below.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://github.com/acme/missing' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate from URL/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate from URL/ }));
    expect(await screen.findByText(/Repository not found|Generation failed/)).toBeInTheDocument();
  });

  it('auto-generates from an initial URL once the providers have loaded', async () => {
    apiFn('streamPipelineFromUrl').mockImplementation(() => stream([{ type: 'done', data: { props: GENERATED } }]));
    renderModal({ initialGitUrl: 'https://github.com/acme/web' });
    await waitFor(() => expect(apiFn('streamPipelineFromUrl')).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Git repository URL')).toHaveValue('https://github.com/acme/web');
  });

  it('a refused placeholder creation is reported and the proposal stays', async () => {
    apiFn('streamPipelineFromUrl').mockImplementation(() => stream([
      { type: 'missing-plugins', data: { existing: [], proposed: ['lint'], refused: [] } },
      { type: 'done', data: { props: GENERATED } },
    ]));
    apiFn('createMissingPlugins').mockRejectedValue(new Error('plugin quota reached'));
    renderModal({ initialGitUrl: 'https://github.com/acme/web' });
    fireEvent.click(await screen.findByRole('button', { name: /Create 1 placeholder plugin$/ }));
    expect(await screen.findByText(/plugin quota reached/)).toBeInTheDocument();
    expect(screen.getByTestId('missing-plugins-proposal')).toBeInTheDocument();
  });
});
