// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render test for the "Ask" agent panel: the empty-state examples, and a full
 * streamed turn — sources arrive up-front, tokens accumulate into the assistant
 * bubble, and the composer re-enables when the stream completes.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { AskPanel } from '../src/components/ask/AskPanel';

// The panel gates each proposal's Create on the permission its create route
// wants (`plugins:write` for POST /plugins/deploy-generated, `pipelines:write`
// for POST /pipelines, …), so every render needs an auth guard.
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

const askAgentStream = jest.fn<AnyFn>();
const createPipeline = jest.fn<AnyFn>();
const deployGeneratedPlugin = jest.fn<AnyFn>();
const recordAiDraftOutcome = jest.fn<AnyFn>();
const invalidatePipelines = jest.fn<AnyFn>();
jest.mock('@/lib/api-cache', () => ({
  __esModule: true,
  invalidate: { pipelines: () => invalidatePipelines() },
}));
// The picker reads the ASK service's own providers (plus the org's saved keys)
// through the same hook the pipeline / plugin AI tabs use.
const getAskProviders = jest.fn<AnyFn>();
const getOrgAIConfig = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    // AskPanel probes this on open; `available` keeps the agent body on screen.
    getAskAvailability: async () => ({ success: true, data: { available: true } }),
    askAgentStream: (...a: unknown[]) => askAgentStream(...a),
    createPipeline: (...a: unknown[]) => createPipeline(...a),
    deployGeneratedPlugin: (...a: unknown[]) => deployGeneratedPlugin(...a),
    recordAiDraftOutcome: (...a: unknown[]) => recordAiDraftOutcome(...a),
    getAskProviders: (...a: unknown[]) => getAskProviders(...a),
    getOrgAIConfig: (...a: unknown[]) => getOrgAIConfig(...a),
  },
}));

/** Build an async generator over the given stream events. */
async function* gen(events: Array<{ type: string; data?: unknown; message?: string; draftId?: string }>) {
  for (const e of events) yield e;
}

/** The plugin draft used by the commit / permission tests. */
const PLUGIN_PROPOSAL = {
  kind: 'plugin',
  config: { name: 'trivy-scan', version: '1.0.0', pluginType: 'CodeBuildStep', computeType: 'MEDIUM', commands: ['trivy image'] },
  dockerfile: 'FROM aquasec/trivy:0.58.0',
};

/** Ask a question and let the mocked stream answer. */
function ask(question: string) {
  fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: question } });
  fireEvent.click(screen.getByLabelText('Send'));
}

describe('AskPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The transcript now PERSISTS across a panel close (sessionStorage), so a
    // turn from the previous test would be restored into this one — two of
    // the same proposal card on screen. Each test starts from no history.
    window.sessionStorage.clear();
    // A viewer holding every write permission, unless a test says otherwise.
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({
      data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }, { id: 'claude-y', name: 'Claude Y' }] }] },
    });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  });

  it('shows example prompts in the empty state', async () => {
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    expect(screen.getByText(/in-cluster Alertmanager/i)).toBeInTheDocument();
    // Settle the provider fetch the picker kicks off on mount.
    await screen.findByLabelText('Provider');
  });

  it('streams a grounded answer: sources up-front, then tokens', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'sources', data: [{ id: 'deployment.md#alertmanager', title: 'Alertmanager' }] },
      { type: 'token', data: 'Point your ' },
      { type: 'token', data: 'tooling there.' },
      { type: 'done' },
    ]));

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);

    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'how do I wire alertmanager' } });
    fireEvent.click(screen.getByLabelText('Send'));

    // The question echoes into the transcript.
    expect(screen.getByText('how do I wire alertmanager')).toBeInTheDocument();

    // Tokens accumulate into the assistant bubble.
    await waitFor(() => expect(screen.getByText('Point your tooling there.')).toBeInTheDocument());

    // The grounded source is attributed.
    expect(screen.getByText('Alertmanager')).toBeInTheDocument();

    // askAgentStream received the query (+ empty history for the first turn).
    expect(askAgentStream).toHaveBeenCalledWith('how do I wire alertmanager', expect.objectContaining({ history: [] }));
  });

  it('the footer counts the turn\'s tool tokens and the AI calls it drew (done event)', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'token', data: 'Drafted.' },
      { type: 'done', data: {
        servedBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        usage: { inputTokens: 1000, outputTokens: 200 },
        toolUsage: { inputTokens: 500, outputTokens: 300 },
        slotsCharged: 2,
      } },
    ]));
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'draft a pipeline' } });
    fireEvent.click(screen.getByLabelText('Send'));
    const footer = await screen.findByTestId('ai-served-by');
    expect(footer.textContent).toContain('2,000 tokens');
    expect(footer.textContent).toContain('2 AI calls');
  });

  it('announces the finished answer to screen readers', async () => {
    // The transcript itself is not a live region — announcing every streamed
    // token would talk over the user — so a status line carries the outcome.
    askAgentStream.mockReturnValue(gen([
      { type: 'token', data: 'Use the alerts page.' },
      { type: 'done' },
    ]));

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'where are alerts' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/assistant replied: use the alerts page\./i));
  });

  it('surfaces an error event and drops the empty pending bubble', async () => {
    askAgentStream.mockReturnValue(gen([{ type: 'error', message: 'model unavailable' }]));

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'anything at all' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(screen.getByText(/model unavailable/i)).toBeInTheDocument());
  });

  it('renders a pipeline proposal and commits it as a proper create envelope on confirm', async () => {
    // The drafted props is a full BuilderProps (carries project/organization).
    const props = { project: 'proj', organization: 'org', pipelineName: 'lint-deploy', synth: {} };
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: { kind: 'pipeline', props, description: 'Lint then deploy' } },
      { type: 'token', data: 'I drafted a pipeline for you to review.' },
      { type: 'done' },
    ]));
    createPipeline.mockResolvedValue({ success: true, data: { pipeline: { id: 'p1' } } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'create a lint+deploy pipeline' } });
    fireEvent.click(screen.getByLabelText('Send'));

    // The draft renders with a Create button — nothing created yet.
    await waitFor(() => expect(screen.getByText('Proposed pipeline')).toBeInTheDocument());
    expect(createPipeline).not.toHaveBeenCalled();

    // Confirm → wraps the drafted BuilderProps in the create envelope (project +
    // organization + props), NOT the bare props.
    fireEvent.click(screen.getByRole('button', { name: /Create pipeline/i }));
    // ...and marks the write as an agent draft the user applied (rule 6), which
    // the route turns into `details: { proposedBy: 'ask-agent' }` on its audit event.
    await waitFor(() => expect(createPipeline).toHaveBeenCalledWith(expect.objectContaining({
      project: 'proj', organization: 'org', pipelineName: 'lint-deploy', props, visibility: 'private',
    }), { proposedByAgent: true }));
    await waitFor(() => expect(screen.getByText(/Created/i)).toBeInTheDocument());
    // Every cached pipeline list must re-read so the new pipeline shows up.
    expect(invalidatePipelines).toHaveBeenCalledTimes(1);
  });

  it('shows the full drafted spec (config + Dockerfile) for a plugin proposal', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: {
        kind: 'plugin',
        config: { name: 'trivy-scan', version: '1.0.0', pluginType: 'CodeBuildStep', computeType: 'MEDIUM', installCommands: [], commands: ['trivy image'] },
        dockerfile: 'FROM aquasec/trivy:0.58.0',
      } },
      { type: 'done' },
    ]));
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'a trivy scan plugin' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(screen.getByText('Proposed plugin')).toBeInTheDocument());
    // The full spec is available for review — config fields + the Dockerfile.
    expect(screen.getByText('Review full spec')).toBeInTheDocument();
    expect(screen.getByText(/FROM aquasec\/trivy/)).toBeInTheDocument();
    expect(screen.getByText(/trivy image/)).toBeInTheDocument();
    // config + dockerfile present → Create enabled.
    expect(screen.getByRole('button', { name: /Create plugin/i })).not.toBeDisabled();
  });

  it('disables Create for an incomplete draft (missing project/organization)', async () => {
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: { kind: 'pipeline', props: { pipelineName: 'x' } } },
      { type: 'done' },
    ]));
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'make a pipeline' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(screen.getByText('Draft incomplete')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Create pipeline/i })).toBeDisabled();
    expect(createPipeline).not.toHaveBeenCalled();
  });

  it('commits a plugin draft through the deploy-generated route', async () => {
    askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL }, { type: 'done' }]));
    deployGeneratedPlugin.mockResolvedValue({ success: true, data: { plugin: { id: 'pl1' } } });

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('a trivy scan plugin');

    await waitFor(() => expect(screen.getByRole('button', { name: /Create plugin/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Create plugin/i }));

    await waitFor(() => expect(deployGeneratedPlugin).toHaveBeenCalledWith(expect.objectContaining({
      name: 'trivy-scan', dockerfile: 'FROM aquasec/trivy:0.58.0', visibility: 'private',
    }), { proposedByAgent: true }));
  });

  it('refuses the plugin commit without `plugins:write` — the route\'s own gate', async () => {
    // The entitlement opens the panel; creating is an ordinary write, and
    // POST /plugins/deploy-generated requires plugins:write. The draft stays
    // readable (hiding the only action on a fresh card reads as a bug), but the
    // action is inert and says what it needs.
    mockAuthGuard({ can: (p: string) => p !== 'plugins:write' });
    askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL }, { type: 'done' }]));

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('a trivy scan plugin');

    await waitFor(() => expect(screen.getByText('Proposed plugin')).toBeInTheDocument());
    const create = screen.getByRole('button', { name: /Create plugin/i });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', 'Requires the plugins:write permission');
    expect(screen.getByText('Requires the plugins:write permission')).toBeInTheDocument();
    // The draft itself is still reviewable.
    expect(screen.getByText(/FROM aquasec\/trivy/)).toBeInTheDocument();

    fireEvent.click(create);
    expect(deployGeneratedPlugin).not.toHaveBeenCalled();
  });

  it('gates each proposal kind on ITS create route\'s permission', async () => {
    // A viewer who may create pipelines but not plugins: the pipeline draft is
    // committable, the plugin one is not.
    mockAuthGuard({ can: (p: string) => p === 'pipelines:write' });
    askAgentStream.mockReturnValue(gen([
      { type: 'proposal', data: { kind: 'pipeline', props: { project: 'proj', organization: 'org' } } },
      { type: 'done' },
    ]));

    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    ask('a pipeline please');

    await waitFor(() => expect(screen.getByText('Proposed pipeline')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Create pipeline/i })).toBeEnabled();
    expect(screen.getByText('Review before creating')).toBeInTheDocument();
  });
});

/**
 * The stream has always taken `provider` / `model` / `apiKey` / `repoToken`;
 * until now the panel sent none of them, so chat could not use a different
 * model from the AI tabs and could not look at a private repository at all.
 */
describe('AskPanel model + repository controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The transcript now PERSISTS across a panel close (sessionStorage), so a
    // turn from the previous test would be restored into this one — two of
    // the same proposal card on screen. Each test starts from no history.
    window.sessionStorage.clear();
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({
      data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }, { id: 'claude-y', name: 'Claude Y' }] }] },
    });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
    askAgentStream.mockReturnValue(gen([{ type: 'token', data: 'ok' }, { type: 'done' }]));
  });

  it('offers the ask-agent service\'s providers and models', async () => {
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    const provider = await screen.findByLabelText('Provider');
    expect(await within(provider).findByRole('option', { name: /Anthropic/ })).toBeInTheDocument();
    const model = await screen.findByLabelText('Model');
    await waitFor(() => expect(within(model).getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude X', 'Claude Y']));
  });

  it('sends the chosen model with the turn', async () => {
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'claude-y' } });
    ask('which model are you?');
    await waitFor(() => expect(askAgentStream).toHaveBeenCalledWith(
      'which model are you?',
      expect.objectContaining({ provider: 'anthropic', model: 'claude-y' }),
    ));
  });

  it('sends a private-repo token when one is supplied, and omits it when not', async () => {
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    await screen.findByLabelText('Provider');

    ask('public repo please');
    await waitFor(() => expect(askAgentStream).toHaveBeenCalled());
    expect(askAgentStream.mock.calls[0][1]).not.toHaveProperty('repoToken');

    fireEvent.change(screen.getByLabelText(/Private repository token/i), { target: { value: ' ghp_secret ' } });
    ask('now analyse my private repo');
    await waitFor(() => expect(askAgentStream).toHaveBeenCalledTimes(2));
    // Trimmed, and never echoed into the transcript.
    expect(askAgentStream.mock.calls[1][1]).toMatchObject({ repoToken: 'ghp_secret' });
    expect(screen.queryByText(/ghp_secret/)).not.toBeInTheDocument();
  });

  it('a BYO key is forwarded as `apiKey`, not stored in the message', async () => {
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    fireEvent.click(await screen.findByRole('button', { name: /custom API key|Enter API key/i }));
    fireEvent.change(screen.getByPlaceholderText(/Leave empty to use server key|Enter API key for this provider/i), {
      target: { value: 'sk-mine' },
    });
    ask('hello');
    await waitFor(() => expect(askAgentStream).toHaveBeenCalledWith('hello', expect.objectContaining({ apiKey: 'sk-mine' })));
  });

  describe('draft outcomes (the AI usage report\'s acceptance rate)', () => {
    beforeEach(() => { recordAiDraftOutcome.mockResolvedValue({ success: true }); });
    // The single-use ids the agent stream issues with each proposal.
    const DRAFT_1 = 'd'.repeat(32);
    const DRAFT_2 = 'e'.repeat(32);

    it('a proposal that came without a draft id reports nothing (the server would refuse it)', async () => {
      askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL }, { type: 'done' }]));
      const { unmount } = render(<AskPanel onClose={jest.fn<AnyFn>()} />);
      ask('a trivy scan plugin');
      fireEvent.click(await screen.findByRole('button', { name: /Dismiss/i }));
      unmount();
      expect(recordAiDraftOutcome).not.toHaveBeenCalled();
    });

    it('records an applied proposal as accepted, once, under the agent feature', async () => {
      askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL, draftId: DRAFT_1 }, { type: 'done' }]));
      deployGeneratedPlugin.mockResolvedValue({ success: true, data: { plugin: { id: 'pl1' } } });
      const { unmount } = render(<AskPanel onClose={jest.fn<AnyFn>()} />);
      ask('a trivy scan plugin');
      await waitFor(() => expect(screen.getByRole('button', { name: /Create plugin/i })).toBeEnabled());
      expect(recordAiDraftOutcome).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /Create plugin/i }));
      await waitFor(() => expect(recordAiDraftOutcome).toHaveBeenCalledWith('agent', 'accepted', DRAFT_1));
      // Closing the panel afterwards reports nothing more.
      unmount();
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'accepted', DRAFT_1]]);
      // Only the feature and the outcome leave the browser.
      expect(JSON.stringify(recordAiDraftOutcome.mock.calls)).not.toContain('trivy');
    });

    it('a failed apply records nothing, and the draft is still pending', async () => {
      askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL, draftId: DRAFT_1 }, { type: 'done' }]));
      deployGeneratedPlugin.mockRejectedValue(new Error('boom'));
      const { unmount } = render(<AskPanel onClose={jest.fn<AnyFn>()} />);
      ask('a trivy scan plugin');
      await waitFor(() => expect(screen.getByRole('button', { name: /Create plugin/i })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: /Create plugin/i }));
      await screen.findByRole('alert');
      expect(recordAiDraftOutcome).not.toHaveBeenCalled();
      unmount();
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'discarded', DRAFT_1]]);
    });

    it('Dismiss removes the proposal and records it discarded, once', async () => {
      askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL, draftId: DRAFT_1 }, { type: 'done' }]));
      const { unmount } = render(<AskPanel onClose={jest.fn<AnyFn>()} />);
      ask('a trivy scan plugin');
      fireEvent.click(await screen.findByRole('button', { name: /Dismiss/i }));
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'discarded', DRAFT_1]]);
      expect(screen.queryByRole('button', { name: /Create plugin/i })).not.toBeInTheDocument();
      unmount();
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'discarded', DRAFT_1]]);
      expect(deployGeneratedPlugin).not.toHaveBeenCalled();
    });

    it('closing the panel with a proposal pending records it discarded', async () => {
      askAgentStream.mockReturnValue(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL, draftId: DRAFT_1 }, { type: 'done' }]));
      const { unmount } = render(<AskPanel onClose={jest.fn<AnyFn>()} />);
      ask('a trivy scan plugin');
      await screen.findByRole('button', { name: /Create plugin/i });
      unmount();
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'discarded', DRAFT_1]]);
    });

    it('a newer proposal replaces a pending one: the older is discarded, applying it later records nothing', async () => {
      askAgentStream.mockReturnValueOnce(gen([{ type: 'proposal', data: PLUGIN_PROPOSAL, draftId: DRAFT_1 }, { type: 'done' }]));
      render(<AskPanel onClose={jest.fn<AnyFn>()} />);
      ask('a trivy scan plugin');
      await screen.findByRole('button', { name: /Create plugin/i });
      askAgentStream.mockReturnValueOnce(gen([{ type: 'proposal', data: { ...PLUGIN_PROPOSAL, config: { ...PLUGIN_PROPOSAL.config, name: 'trivy-two' } }, draftId: DRAFT_2 }, { type: 'done' }]));
      ask('another one');
      await waitFor(() => expect(screen.getAllByRole('button', { name: /Create plugin/i })).toHaveLength(2));
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'discarded', DRAFT_1]]);
      deployGeneratedPlugin.mockResolvedValue({ success: true, data: { plugin: { id: 'pl1' } } });
      await waitFor(() => expect(screen.getAllByRole('button', { name: /Create plugin/i })[0]).toBeEnabled());
      fireEvent.click(screen.getAllByRole('button', { name: /Create plugin/i })[0]!);
      await waitFor(() => expect(deployGeneratedPlugin).toHaveBeenCalled());
      await waitFor(() => expect(screen.getAllByRole('button', { name: /Create plugin/i })).toHaveLength(1));
      expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'discarded', DRAFT_1]]);
    });
  });
});
