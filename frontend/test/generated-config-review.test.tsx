// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared review of the AI pipeline-create modes: swapping a plugin rewrites
 * the config and its preview, the overrides win over the generated names, and
 * nothing is submitted before a generation.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { renderHook, act, render, screen } from '@testing-library/react';
import { useGeneratedProps, GeneratedConfigReview, stageProgress } from '@/components/pipeline/GeneratedConfigReview';
import type { BuilderProps } from '@/types';
import type { AnyFn } from './helpers/mock-fn';

jest.mock('@/components/pipeline/editors/PluginNameCombobox', () => ({
  __esModule: true,
  default: ({ label, value }: { label: string; value: string }) => <div>{label}: {value}</div>,
}));

// jsdom has no structuredClone; the config is plain JSON.
globalThis.structuredClone ??= (<T,>(v: T): T => JSON.parse(JSON.stringify(v))) as typeof structuredClone;

const generated = {
  project: 'gen-project',
  organization: 'gen-org',
  synth: { source: { type: 'github', options: {} }, plugin: { name: 'cdk-synth' } },
  stages: [{ stageName: 'Test', steps: [{ plugin: { name: 'jest' } }] }],
} as unknown as BuilderProps;

describe('useGeneratedProps', () => {
  it('rewrites a step plugin and re-renders the preview', () => {
    const setGeneratedProps = jest.fn<AnyFn>();
    const setPreviewJson = jest.fn<AnyFn>();
    const { result } = renderHook(() => useGeneratedProps({
      generatedProps: generated, setGeneratedProps, setPreviewJson, projectOverride: '', organizationOverride: '',
    }));
    act(() => result.current.onPluginChange('stages.0.steps.0', 'vitest', null));
    const updated = setGeneratedProps.mock.calls[0]![0] as { stages: Array<{ steps: Array<{ plugin: { name: string } }> }> };
    expect(updated.stages[0]!.steps[0]!.plugin.name).toBe('vitest');
    expect(setPreviewJson.mock.calls[0]![0]).toContain('"vitest"');
    act(() => result.current.onPluginChange('synth', 'cdk-synth-2', null));
    expect((setGeneratedProps.mock.calls[1]![0] as { synth: { plugin: { name: string } } }).synth.plugin.name).toBe('cdk-synth-2');
    act(() => result.current.onPluginChange('stages.9.steps.0', 'x', null));
    expect(setGeneratedProps).toHaveBeenCalledTimes(2);
  });

  it('applies the overrides, and is null before a generation', () => {
    const base = { setGeneratedProps: jest.fn<AnyFn>(), setPreviewJson: jest.fn<AnyFn>() };
    const { result } = renderHook(() => useGeneratedProps({ ...base, generatedProps: generated, projectOverride: ' mine ', organizationOverride: '' }));
    expect(result.current.withOverrides()).toMatchObject({ project: 'mine', organization: 'gen-org' });
    const empty = renderHook(() => useGeneratedProps({ ...base, generatedProps: null, projectOverride: '', organizationOverride: '' }));
    expect(empty.result.current.withOverrides()).toBeNull();
    act(() => empty.result.current.onPluginChange('synth', 'x', null));
    expect(base.setGeneratedProps).not.toHaveBeenCalled();
  });
});

describe('GeneratedConfigReview', () => {
  const props = {
    generatedProps: generated, previewJson: '{}', disabled: false,
    projectOverride: 'p', setProjectOverride: () => {}, organizationOverride: 'o', setOrganizationOverride: () => {},
    onPluginChange: () => {}, regenerateHint: 'or regenerate.',
  };

  it('shows the plugin review and "Ready to submit" once generated', () => {
    render(<GeneratedConfigReview {...props} generating={false}><p>extra</p></GeneratedConfigReview>);
    expect(screen.getByText('Synth plugin: cdk-synth')).toBeInTheDocument();
    expect(screen.getByText('Ready to submit')).toBeInTheDocument();
    expect(screen.getByText('extra')).toBeInTheDocument();
  });

  it('hides the plugin review while streaming', () => {
    render(<GeneratedConfigReview {...props} generating />);
    expect(screen.queryByText('Synth plugin: cdk-synth')).toBeNull();
    expect(screen.getByText(/Streaming/)).toBeInTheDocument();
  });

  it('describes progress by stage count', () => {
    expect(stageProgress(0)).toMatch(/may take a minute/);
    expect(stageProgress(2)).toMatch(/2 stages generated/);
  });
});
