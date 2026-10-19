// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Ask drawer's HELP-TOPICS surface — the two ways the question box is
 * replaced by the docs, which are deliberately different things:
 *
 *   1. `ASK_UI_MODE=help-topics` — this deployment never offers the agent.
 *      Nothing is wrong, so there must be NO outage notice: telling someone the
 *      assistant is unavailable, when it was switched off on purpose, produces
 *      a support ticket about a working system.
 *   2. The agent is on but cannot answer — its self-hosted model is scaled to
 *      zero outside its business-hours window, or no provider is configured.
 *      Here the reason IS shown, because the user would otherwise type a
 *      question and get a failure they cannot act on.
 *
 * The third case is the one that must NOT change the UI: a probe that errors.
 * It fails OPEN, leaving the agent on offer — a transient 502 must not quietly
 * replace the product with a help page.
 *
 * Lives apart from ask-panel.test.tsx because it needs to drive `useFeatures`
 * and the probe per test, and those tests deliberately run against the real
 * context default.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { BookOpen } from 'lucide-react';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

/** Driven per test; the panel reads it synchronously from `/config`. */
let askUiMode = 'ask-agent';
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ askUiMode, isLoaded: true, isEnabled: () => true }),
}));

const getAskAvailability = jest.fn<AnyFn>();
const getAskProviders = jest.fn<AnyFn>();
const getOrgAIConfig = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAskAvailability: (...a: unknown[]) => getAskAvailability(...a),
    getAskProviders: (...a: unknown[]) => getAskProviders(...a),
    getOrgAIConfig: (...a: unknown[]) => getOrgAIConfig(...a),
    askAgentStream: jest.fn<AnyFn>(),
  },
}));
jest.mock('@/lib/api-cache', () => ({ __esModule: true, invalidate: { pipelines: () => {} } }));

// A two-topic stand-in for the ~1 MB generated corpus: this asserts the drawer
// RENDERS topics, not what the docs say.
jest.mock('@/lib/help', () => ({
  __esModule: true,
  loadHelpGroups: async () => ([{
    category: 'Getting started',
    topics: [{
      id: 'first-pipeline',
      title: 'Create your first pipeline',
      description: 'End to end, from template to deploy.',
      icon: BookOpen,
      sections: [],
    }],
  }]),
}));

import { AskPanel } from '../src/components/ask/AskPanel';

beforeEach(() => {
  jest.clearAllMocks();
  askUiMode = 'ask-agent';
  getAskAvailability.mockResolvedValue({ success: true, data: { available: true } });
  getAskProviders.mockResolvedValue({ success: true, data: { providers: [] } });
  getOrgAIConfig.mockResolvedValue({ success: true, data: {} });
});

describe('Ask drawer — ASK_UI_MODE=help-topics', () => {
  it('shows topics instead of the question box', async () => {
    askUiMode = 'help-topics';
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);

    expect(await screen.findByPlaceholderText('Search help topics…')).toBeInTheDocument();
    // The composer is the thing being replaced.
    expect(screen.queryByLabelText('Ask a question')).not.toBeInTheDocument();
    expect(await screen.findByText('Create your first pipeline')).toBeInTheDocument();
  });

  it('says nothing about an outage, because there is none', async () => {
    askUiMode = 'help-topics';
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    await screen.findByPlaceholderText('Search help topics…');
    expect(screen.queryByText(/switched off|unavailable|not responding/i)).not.toBeInTheDocument();
  });

  it('does not probe availability at all', async () => {
    // Nothing would act on the answer, and the route is gated on an entitlement
    // this surface does not need.
    askUiMode = 'help-topics';
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    await screen.findByPlaceholderText('Search help topics…');
    expect(getAskAvailability).not.toHaveBeenCalled();
  });
});

describe('Ask drawer — the model is scheduled off', () => {
  it('falls back to topics AND says when the assistant returns', async () => {
    getAskAvailability.mockResolvedValue({
      success: true,
      data: {
        available: false,
        reason: 'scheduled-off',
        message: "The Ask assistant's self-hosted model runs 07:45-17:00 UTC, Monday to Friday and is switched off right now. It will be available again at 07:45 UTC.",
        resumesAt: '07:45 UTC',
      },
    });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);

    expect(await screen.findByText(/switched off right now/)).toBeInTheDocument();
    // The one actionable fact survives into the UI.
    expect(screen.getByText(/available again at 07:45 UTC/)).toBeInTheDocument();
    expect(await screen.findByPlaceholderText('Search help topics…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ask a question')).not.toBeInTheDocument();
  });

  it('falls back with no provider configured, promising no return', async () => {
    getAskAvailability.mockResolvedValue({
      success: true,
      data: {
        available: false,
        reason: 'not-configured',
        message: 'No AI provider is configured for this deployment, so the assistant cannot answer questions. The help topics below cover the same material.',
      },
    });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);

    expect(await screen.findByText(/No AI provider is configured/)).toBeInTheDocument();
    expect(screen.queryByText(/available again at/)).not.toBeInTheDocument();
  });
});

describe('Ask drawer — the probe fails open', () => {
  it('keeps the agent when the probe errors', async () => {
    // A boot-window 502 must not silently replace the assistant: it may well
    // work, and a turn that does fail carries the server's own explanation.
    getAskAvailability.mockRejectedValue(new Error('502 Bad Gateway'));
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);

    expect(await screen.findByLabelText('Ask a question')).toBeInTheDocument();
    await waitFor(() => expect(getAskAvailability).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText('Search help topics…')).not.toBeInTheDocument();
  });

  it('keeps the agent when the payload has no `available` field at all', async () => {
    // An older ask service, or any envelope that does not carry the field.
    // `!data.available` would read this as unavailable and silently swap the
    // assistant for a help page; only an EXPLICIT false may do that.
    getAskAvailability.mockResolvedValue({ success: true, data: { somethingElse: 1 } });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);

    expect(await screen.findByLabelText('Ask a question')).toBeInTheDocument();
    await waitFor(() => expect(getAskAvailability).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText('Search help topics…')).not.toBeInTheDocument();
  });

  it('keeps the agent when the probe reports available', async () => {
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    expect(await screen.findByLabelText('Ask a question')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search help topics…')).not.toBeInTheDocument();
  });
});
