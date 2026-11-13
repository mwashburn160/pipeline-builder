// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The step picker never offers a managed build image (pluginType `BuildImage`,
 * `pipeline-bootstrap`): it is what the synth runs ON, never a step
 * (docs/plans/bootstrap-image-versioning.md §1).
 */

import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Plugin } from '../src/types';
import PluginNameCombobox from '../src/components/pipeline/editors/PluginNameCombobox';
import { isStepPlugin } from '../src/hooks/usePlugins';

const mockPlugins = [
  { id: 'a', name: 'pipeline-bootstrap', version: '1.0.0', pluginType: 'BuildImage', category: 'infrastructure', description: 'image' },
  { id: 'b', name: 'cdk-synth', version: '1.0.0', pluginType: 'CodeBuildStep', category: 'infrastructure', description: 'synth' },
  { id: 'c', name: 'lint', version: '2.0.0', pluginType: 'ShellStep', category: 'quality', description: 'lint' },
] as unknown as Plugin[];

jest.mock('@/hooks/usePlugins', () => {
  const actual = jest.requireActual('@/hooks/usePlugins') as Record<string, unknown>;
  return {
    ...actual,
    usePlugins: () => ({ plugins: mockPlugins, isLoading: false, error: null, refetch: jest.fn() }),
    usePluginCatalog: () => ({ entries: [], shadowing: [], isLoading: false, refetch: jest.fn() }),
  };
});

describe('isStepPlugin', () => {
  it('is false only for BuildImage', () => {
    expect(mockPlugins.map((p) => isStepPlugin(p))).toEqual([false, true, true]);
  });
});

describe('PluginNameCombobox', () => {
  it('never lists a BuildImage plugin', () => {
    render(<PluginNameCombobox value="" onChange={jest.fn()} onSelectPlugin={jest.fn()} />);
    fireEvent.focus(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options.some((t) => t.includes('cdk-synth'))).toBe(true);
    expect(options.some((t) => t.includes('lint'))).toBe(true);
    expect(options.some((t) => t.includes('pipeline-bootstrap'))).toBe(false);
  });
});
