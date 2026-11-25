// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The single "Local model" option in the three AI create surfaces (Git URL,
 * From prompt, plugin builder). It stands for the self-hosted model and is the
 * default; the separate "Ask agent" and "Local model (OpenAI-compatible)"
 * entries are gone. Per surface:
 *  - the Ask agent answering its availability check → the draft goes through
 *    the agent (`askAgentStream`, doc-grounded);
 *  - the agent not answering but the local provider configured → the draft
 *    goes straight to the local provider, with no warning;
 *  - neither → the option is unavailable, a warning says so, and the default
 *    moves to the next configured provider.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import PromptGenerateTab from '@/components/pipeline/PromptGenerateTab';
import AIPluginBuilderTab from '@/components/plugin/AIPluginBuilderTab';

const LOCAL = { id: 'openai-compatible', name: 'Local model (OpenAI-compatible)', models: [{ id: 'qwen', name: 'Qwen 2.5 7B Instruct' }] };
const ANTHROPIC = { id: 'anthropic', name: 'Anthropic', models: [{ id: 'm1', name: 'M1' }] };

const NOT_ANSWERING = { success: true, data: { available: false, reason: 'unreachable', message: 'The Ask assistant\'s self-hosted model is not responding.' } };

interface Surface {
  name: string;
  serverProviders: string;
  directStream: string;
  /** The direct stream's expected leading arguments (input, provider, model). */
  directArgs: (provider: string, model: string) => unknown[];
  mount: () => void;
  /** Fill the input and click Generate. */
  generate: () => Promise<void>;
}

const URL = 'https://github.com/acme/web';
const PROMPT = 'a node pipeline';

async function fillAndClick(label: string | RegExp, value: string, button: RegExp) {
  fireEvent.change(await screen.findByLabelText(label), { target: { value } });
  const btn = screen.getByRole('button', { name: button });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
}

const SURFACES: Surface[] = [
  {
    name: 'Git URL',
    serverProviders: 'getAIProviders',
    directStream: 'streamPipelineFromUrl',
    directArgs: (p, m) => [URL, p, m],
    mount: () => render(
      <CreatePipelineModal isOpen onClose={jest.fn<AnyFn>()} onSubmit={jest.fn<AnyFn>()} createLoading={false} createError={null} createSuccess={null} canPublish />,
    ),
    generate: () => fillAndClick('Git repository URL', URL, /Generate from URL/),
  },
  {
    name: 'From prompt',
    serverProviders: 'getAIProviders',
    directStream: 'streamPipelineFromPrompt',
    directArgs: (p, m) => [PROMPT, p, m],
    mount: () => render(<PromptGenerateTab />),
    generate: () => fillAndClick('Describe your pipeline', PROMPT, /Generate from prompt/),
  },
  {
    name: 'plugin builder',
    serverProviders: 'getPluginAIProviders',
    directStream: 'streamPluginGeneration',
    directArgs: (p, m) => [PROMPT, p, m],
    mount: () => render(<AIPluginBuilderTab canPublish onCreated={jest.fn<AnyFn>()} onClose={jest.fn<AnyFn>()} />),
    generate: () => fillAndClick('Describe your plugin', PROMPT, /Generate Plugin/),
  },
];

beforeEach(() => {
  resetApiMock();
  mockAuthGuard({ can: () => true });
  apiFn('getOrgAIConfig').mockResolvedValue({ success: true, data: { providers: {}, aiEnabled: true } });
  apiFn('getAskProviders').mockResolvedValue({ success: true, data: { providers: [LOCAL] } });
  apiFn('askAgentStream').mockImplementation(() => (async function* none() { /* no events */ })());
});

describe.each(SURFACES)('$name: the single "Local model" option', (s) => {
  beforeEach(() => {
    apiFn(s.serverProviders).mockResolvedValue({ success: true, data: { providers: [LOCAL, ANTHROPIC] } });
  });

  it('is the first option and the default; no separate Ask agent / OpenAI-compatible entries', async () => {
    apiFn('getAskAvailability').mockResolvedValue({ success: true, data: { available: true } });
    s.mount();
    const option = await screen.findByRole('option', { name: 'Local model — default' });
    const select = screen.getByLabelText('Provider') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe((option as HTMLOptionElement).value));
    expect(select.options[0]).toBe(option);
    const providerOptions = within(select);
    expect(providerOptions.queryByRole('option', { name: /^Ask agent/ })).not.toBeInTheDocument();
    expect(providerOptions.queryByRole('option', { name: /OpenAI-compatible/ })).not.toBeInTheDocument();
    expect(providerOptions.getAllByRole('option', { name: /^Local model/ })).toHaveLength(1);
    // The model list is the self-hosted one, without a redundant provider suffix.
    expect(screen.getByRole('option', { name: 'Qwen 2.5 7B Instruct' })).toBeInTheDocument();
  });

  it('routes through the Ask agent when it answers', async () => {
    apiFn('getAskAvailability').mockResolvedValue({ success: true, data: { available: true } });
    s.mount();
    await screen.findByRole('option', { name: 'Local model — default' });
    expect(screen.getByText(/self-hosted model/)).toBeInTheDocument();
    await s.generate();
    await waitFor(() => expect(apiFn('askAgentStream')).toHaveBeenCalledTimes(1));
    expect(apiFn('askAgentStream').mock.calls[0][1]).toMatchObject({ provider: 'openai-compatible', model: 'qwen' });
    expect(apiFn(s.directStream)).not.toHaveBeenCalled();
  });

  it('goes straight to the local provider, with no warning, when the agent is not answering', async () => {
    apiFn('getAskAvailability').mockResolvedValue(NOT_ANSWERING);
    s.mount();
    const option = await screen.findByRole('option', { name: 'Local model — default' });
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue((option as HTMLOptionElement).value));
    expect(screen.queryByText(/not responding/)).not.toBeInTheDocument();
    await s.generate();
    await waitFor(() => expect(apiFn(s.directStream)).toHaveBeenCalledTimes(1));
    expect(apiFn(s.directStream).mock.calls[0].slice(0, 3)).toEqual(s.directArgs('openai-compatible', 'qwen'));
    expect(apiFn('askAgentStream')).not.toHaveBeenCalled();
  });

  it('is unavailable, with a warning, and the default moves on when neither path can serve', async () => {
    apiFn(s.serverProviders).mockResolvedValue({ success: true, data: { providers: [ANTHROPIC] } });
    apiFn('getAskAvailability').mockResolvedValue(NOT_ANSWERING);
    s.mount();
    await waitFor(() => expect(screen.getByLabelText('Provider')).toHaveValue('anthropic'));
    expect(screen.getByRole('option', { name: /^Local model/ })).toBeDisabled();
    expect(screen.getByText(/not responding\. Another provider was selected instead\./)).toBeInTheDocument();
  });
});
