// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AiProviderModelPicker's "Local model" option: labelled "— default", no key
 * override on either route, helper text naming the self-hosted model (and the
 * doc-grounded drafting only when routed via the Ask agent), a disabled
 * "— unavailable" option plus a warning when neither route can serve.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import type { UseAIProvidersResult } from '@/hooks/useAIProviders';
import type { AIProviderInfo } from '@/lib/ai-constants';

const ANTHROPIC: AIProviderInfo = { id: 'anthropic', name: 'Anthropic', source: 'server', models: [{ id: 'm1', name: 'M1' }] };

function state(local: AIProviderInfo, over: Partial<UseAIProvidersResult> = {}): UseAIProvidersResult {
  const providers = [local, ANTHROPIC];
  const selected = over.selectedProvider ?? local.id;
  const current = providers.find((p) => p.id === selected)!;
  return {
    providers, loading: false, error: null, hasConfiguredProvider: true, aiDisabled: false,
    localModelUnavailable: null,
    selectedProvider: selected, selectedModel: current.models[0]?.id ?? '',
    setSelectedProvider: jest.fn<AnyFn>(), setSelectedModel: jest.fn<AnyFn>(),
    currentModels: current.models, currentSource: current.source,
    customApiKey: '', setCustomApiKey: jest.fn<AnyFn>(), showKeyOverride: false, setShowKeyOverride: jest.fn<AnyFn>(),
    ...over,
  };
}

describe('AiProviderModelPicker: Local model', () => {
  it('via the Ask agent: "Local model — default", doc-grounded helper text, no key override', () => {
    render(<AiProviderModelPicker ai={state({ id: 'ask-agent', name: 'Local model', source: 'local', models: [{ id: 'openai-compatible|qwen', name: 'Qwen' }] })} />);
    expect(screen.getByRole('option', { name: 'Local model — default' })).toBeInTheDocument();
    expect(screen.getByText(/self-hosted model/)).toHaveTextContent(/docs/);
    expect(screen.queryByRole('button', { name: /API key/ })).not.toBeInTheDocument();
  });

  it('direct: self-hosted helper text without the docs mention, no key override', () => {
    render(<AiProviderModelPicker ai={state({ id: 'openai-compatible', name: 'Local model', source: 'local', models: [{ id: 'qwen', name: 'Qwen' }] })} />);
    expect(screen.getByRole('option', { name: 'Local model — default' })).toBeInTheDocument();
    expect(screen.getByText(/self-hosted model/)).not.toHaveTextContent(/docs/);
    expect(screen.queryByRole('button', { name: /API key/ })).not.toBeInTheDocument();
  });

  it('unavailable: a disabled option and the warning', () => {
    const local: AIProviderInfo = { id: 'ask-agent', name: 'Local model', source: 'local', unavailable: true, models: [{ id: 'openai-compatible|qwen', name: 'Qwen' }] };
    render(<AiProviderModelPicker ai={state(local, {
      selectedProvider: 'anthropic',
      localModelUnavailable: 'The self-hosted model is not responding. Another provider was selected instead.',
    })} />);
    expect(screen.getByRole('option', { name: 'Local model — unavailable' })).toBeDisabled();
    expect(screen.getByText(/not responding\. Another provider was selected instead\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /custom API key/ })).toBeInTheDocument();
  });
});
