// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The three things that connect the assistant to the docs it answers from:
 *
 *   1. CITATIONS ARE REACHABLE. They rendered as plain text while the server had
 *      always sent a `url`, so the claim "grounded in the docs" was unverifiable
 *      by the reader. An in-app topic is preferred over the public site, through
 *      the generated `doc-map` — the key `sourceDoc` was put there for and which
 *      nothing had ever read.
 *   2. THE TRANSCRIPT SURVIVES A CLOSE. The panel unmounts on close, so the
 *      conversation used to die with it.
 *   3. FEEDBACK IS RECORDED, with the cited docs and WITHOUT the question. The
 *      doc is the thing that gets fixed; the question is the reader's own words
 *      and this service records safe metadata only.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BookOpen } from 'lucide-react';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ askUiMode: 'ask-agent', isLoaded: true, isEnabled: () => true }),
}));

const askAgentStream = jest.fn<AnyFn>();
const sendAskFeedback = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAskAvailability: async () => ({ success: true, data: { available: true } }),
    getAskProviders: async () => ({ success: true, data: { providers: [] } }),
    getOrgAIConfig: async () => ({ success: true, data: {} }),
    askAgentStream: (...a: unknown[]) => askAgentStream(...a),
    sendAskFeedback: (...a: unknown[]) => sendAskFeedback(...a),
  },
}));
jest.mock('@/lib/api-cache', () => ({ __esModule: true, invalidate: { pipelines: () => {} } }));
jest.mock('@/lib/help', () => ({
  __esModule: true,
  loadHelpGroups: async () => ([{
    category: 'Getting started',
    topics: [{ id: 'first', title: 'First pipeline', description: 'd', icon: BookOpen, sections: [] }],
  }]),
}));

import { AskPanel } from '../src/components/ask/AskPanel';
import { loadTranscript, saveTranscript, clearTranscript } from '../src/components/ask/transcript-store';

/** One finished turn citing two docs: one with an in-app topic, one without. */
async function* answerWithSources() {
  yield {
    type: 'sources',
    data: [
      { id: 'authentication.md', title: 'Authentication & SSO', url: 'docs/authentication' },
      { id: 'plugins/security.md', title: 'Security plugins', url: 'docs/plugins/security' },
    ],
  };
  yield { type: 'token', data: 'Use SSO.' };
}

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  sendAskFeedback.mockResolvedValue({ success: true, data: { recorded: true } });
  askAgentStream.mockImplementation(() => answerWithSources());
});

async function ask() {
  render(<AskPanel onClose={jest.fn<AnyFn>()} />);
  const box = await screen.findByLabelText('Ask a question');
  fireEvent.change(box, { target: { value: 'how do I set up SSO?' } });
  fireEvent.submit(box.closest('form')!);
  await screen.findAllByText(/Use SSO\./); // also in the sr-only live region
}

describe('Ask citations', () => {
  it('links a cited doc to the in-app topic generated from it', async () => {
    await ask();
    const link = await screen.findByRole('link', { name: /Authentication & SSO/ });
    // The anchor the help page renders for that topic — not the docs site.
    expect(link).toHaveAttribute('href', '/dashboard/help#topic-authentication');
  });

  it('falls back to the published docs site for a doc with no topic', async () => {
    await ask();
    const link = await screen.findByRole('link', { name: /Security plugins/ });
    // Jekyll serves these at `<path>.html`; the server's url carries no extension.
    expect(link).toHaveAttribute('href', 'https://docs.pipeline-builder.com/docs/plugins/security.html');
    expect(link).toHaveAttribute('target', '_blank');
  });
});

describe('Ask feedback', () => {
  it('records the rating with the docs the answer cited', async () => {
    await ask();
    fireEvent.click(await screen.findByLabelText('This answer was not helpful'));

    await waitFor(() => expect(sendAskFeedback).toHaveBeenCalled());
    const body = sendAskFeedback.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'answer',
      rating: 'down',
      // The actionable half: which docs produced the bad answer.
      sources: ['authentication.md', 'plugins/security.md'],
    });
  });

  it('never sends the question', async () => {
    await ask();
    fireEvent.click(await screen.findByLabelText('This answer was helpful'));
    await waitFor(() => expect(sendAskFeedback).toHaveBeenCalled());
    expect(JSON.stringify(sendAskFeedback.mock.calls[0][0])).not.toContain('SSO?');
  });

  it('settles after a vote instead of inviting another', async () => {
    await ask();
    fireEvent.click(await screen.findByLabelText('This answer was helpful'));
    expect(await screen.findByText(/Thanks — noted\./)).toBeInTheDocument();
    expect(screen.queryByLabelText('This answer was helpful')).not.toBeInTheDocument();
  });
});

describe('Ask transcript', () => {
  it('survives the panel closing', async () => {
    const { unmount } = render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    const box = await screen.findByLabelText('Ask a question');
    fireEvent.change(box, { target: { value: 'how do I set up SSO?' } });
    fireEvent.submit(box.closest('form')!);
    await screen.findAllByText(/Use SSO\./);
    await waitFor(() => expect(loadTranscript().length).toBeGreaterThan(0));

    unmount(); // what closing the drawer does
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    expect((await screen.findAllByText(/Use SSO\./)).length).toBeGreaterThan(0);
  });

  it('is dropped by Clear', async () => {
    await ask();
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }));
    await waitFor(() => expect(screen.queryAllByText(/Use SSO\./)).toHaveLength(0));
    expect(loadTranscript()).toEqual([]);
  });
});

describe('what the transcript keeps', () => {
  it('never persists a drafted proposal', async () => {
    // A proposal holds RAW field values; redaction happens where it renders, and
    // that allowlist is documented as "admits no secret today … defence in
    // depth". Persisting the object would make that assumption load-bearing for
    // storage instead of for a view, which is a far worse place for it. The
    // draft is also live session state the commit path re-reads anyway.
    askAgentStream.mockImplementation(async function* () {
      yield { type: 'token', data: 'Here is a draft.' };
      yield {
        type: 'proposal',
        data: {
          kind: 'plugin',
          config: { name: 'acme', version: '1.0.0', apiToken: 'super-secret-value' },
        },
      };
    });
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    const box = await screen.findByLabelText('Ask a question');
    fireEvent.change(box, { target: { value: 'draft me a plugin' } });
    fireEvent.submit(box.closest('form')!);
    await screen.findAllByText(/Here is a draft\./);

    await waitFor(() => expect(loadTranscript().length).toBeGreaterThan(0));
    const stored = JSON.stringify(loadTranscript());
    expect(stored).toContain('Here is a draft.');
    expect(stored).not.toContain('super-secret-value');
    expect(stored).not.toContain('proposal');
  });
});

describe('transcript store', () => {
  it('survives storage being unavailable', () => {
    // Private windows and blocked site data make the ACCESSOR throw, not return
    // null. A panel that cannot persist must still open.
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    try {
      expect(() => saveTranscript([{ role: 'user', content: 'hi' }])).not.toThrow();
      expect(loadTranscript()).toEqual([]);
      expect(() => clearTranscript()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('drops the oldest turns rather than failing on an oversized transcript', () => {
    const fat = { role: 'assistant', content: 'x'.repeat(200 * 1024) };
    saveTranscript([fat, fat, { role: 'user', content: 'keep me' }]);
    const back = loadTranscript<{ role: string; content: string }>();
    // The recent end is what is worth keeping.
    expect(back[back.length - 1].content).toBe('keep me');
  });
});
