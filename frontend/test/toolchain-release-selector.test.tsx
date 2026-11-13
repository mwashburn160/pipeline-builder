// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline editor's toolchain controls (docs/plans/
 * bootstrap-image-versioning.md §5, §11):
 *   - the "Toolchain" selector follows the org / platform default or pins an
 *     eligible release; yanked/deprecated are labelled and not newly
 *     selectable; an older pin says "behind default";
 *   - the form writes `props.toolchain.release` only when pinned, and reads it back;
 *   - a managed `cdk-synth` plugin reference has no version (or id) field.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ToolchainReleaseSelector from '../src/components/pipeline/editors/ToolchainReleaseSelector';
import PluginOptionsEditor from '../src/components/pipeline/editors/PluginOptionsEditor';
import { propsToFormState } from '../src/types/props-parsing';
import { assembleBuilderProps } from '../src/types/props-assembly';
import { createEmptyPlugin, type FormPluginOptions } from '../src/types/form-types';
import type { ToolchainOrgDefaultView, ToolchainRelease } from '../src/types/toolchain';

const getToolchainOrgDefault = jest.fn<AnyFn>();
const getToolchainEligible = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getToolchainOrgDefault: (...a: unknown[]) => getToolchainOrgDefault(...a),
    getToolchainEligible: (...a: unknown[]) => getToolchainEligible(...a),
  },
}));
// The plugin-name picker and its resolution warnings fetch the catalog; neither is under test here.
jest.mock('@/components/pipeline/editors/PluginNameCombobox', () => ({
  __esModule: true,
  default: ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
    <input aria-label={`${label} name`} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
jest.mock('@/components/pipeline/editors/PluginResolutionWarnings', () => ({ __esModule: true, PluginResolutionWarnings: () => null }));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const versions = { pipelineManager: '3.4.1', awsCdk: '2.200.0', cdkAssets: '3.1.0', esbuild: '0.25.0', pnpm: '10.1.0', node: '22.12.0' };
const release = (releaseVersion: string, over: Partial<ToolchainRelease> = {}): ToolchainRelease => ({
  releaseVersion, status: 'available', relation: 'older', toolchain: versions, releaseNotes: null,
  scan: { scannedAt: '2026-11-01T00:00:00Z', criticalFixable: 0, highFixable: 0, kev: 0 }, ...over,
});
const view = (over: Partial<ToolchainOrgDefaultView> = {}): ToolchainOrgDefaultView => ({
  effective: { releaseVersion: '1.4.2', resolvedVia: 'default' },
  orgDefault: null, inheritedFrom: null,
  canary: { member: false, releaseVersion: null, effective: false },
  platformDefault: '1.4.2',
  counts: { pipelines: 3, pinned: 0, behind: 0 },
  ...over,
});
const RELEASES = [
  release('1.5.0', { status: 'canary', relation: 'newer' }),
  release('1.4.2', { status: 'default', relation: 'current' }),
  release('1.4.1'),
  release('1.4.0', { status: 'deprecated' }),
  release('1.3.0', { status: 'yanked' }),
];

beforeEach(() => {
  jest.clearAllMocks();
  getToolchainOrgDefault.mockImplementation(() => ok(view()));
  getToolchainEligible.mockImplementation(() => ok({ platformDefault: '1.4.2', releases: RELEASES }));
});

function Harness({ initial = '', onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return <ToolchainReleaseSelector value={value} onChange={(v) => { setValue(v); onValue?.(v); }} />;
}

const option = (name: RegExp) => screen.getByRole('option', { name });

describe('ToolchainReleaseSelector', () => {
  it('offers "Platform default (currently X)" when the org has no default, then the releases', async () => {
    render(<Harness />);
    expect(await screen.findByRole('option', { name: 'Platform default (currently 1.4.2)' })).toBeInTheDocument();
    expect(option(/^1\.5\.0 \(Canary, newer\)/)).toBeEnabled();
    expect(option(/^1\.4\.1 \(Available, older\)/)).toBeEnabled();
  });

  it('offers "Org default (currently X)" when the org set one', async () => {
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.1', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.4.1', setBy: 'u', setAt: 'x', reason: null },
    })));
    render(<Harness />);
    expect(await screen.findByRole('option', { name: 'Org default (currently 1.4.1)' })).toBeInTheDocument();
  });

  it('yanked and deprecated releases are labelled and not newly selectable', async () => {
    render(<Harness />);
    await screen.findByRole('option', { name: /^1\.3\.0/ });
    expect(option(/^1\.3\.0 \(Yanked/)).toBeDisabled();
    expect(option(/^1\.4\.0 \(Deprecated/)).toBeDisabled();
  });

  it('keeps an existing pin on a yanked release selectable (and warns)', async () => {
    render(<Harness initial="1.3.0" />);
    await screen.findByRole('option', { name: /^Platform default/ });
    expect(option(/^1\.3\.0 \(Yanked/)).toBeEnabled();
    expect(screen.getByText(/1\.3\.0 was yanked/i)).toBeInTheDocument();
  });

  it('a pin older than the default shows "behind default"; a current one does not', async () => {
    const { unmount } = render(<Harness initial="1.4.1" />);
    expect(await screen.findByTestId('toolchain-behind')).toHaveTextContent('Behind default: unpinned pipelines run 1.4.2.');
    unmount();
    render(<Harness initial="1.5.0" />);
    await screen.findByRole('option', { name: /^Platform default/ });
    expect(screen.queryByTestId('toolchain-behind')).not.toBeInTheDocument();
  });

  it('choosing a release reports it; choosing the default reports ""', async () => {
    const onValue = jest.fn<(v: string) => void>();
    render(<Harness onValue={onValue} />);
    const select = within(screen.getByTestId('toolchain-selector')).getByRole('combobox');
    await screen.findByRole('option', { name: /^1\.4\.1/ });
    fireEvent.change(select, { target: { value: '1.4.1' } });
    expect(onValue).toHaveBeenLastCalledWith('1.4.1');
    fireEvent.change(select, { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith('');
  });
});

describe('props.toolchain.release round-trip', () => {
  const base = {
    project: 'p', organization: 'o',
    synth: { source: { type: 'github', options: { repo: 'a/b', branch: 'main' } }, plugin: { name: 'cdk-synth' } },
  };

  it('reads a pin into the form and writes it back', () => {
    const state = propsToFormState({ ...base, toolchain: { release: '1.4.1' } });
    expect(state.toolchainRelease).toBe('1.4.1');
    const { props } = assembleBuilderProps(state, { skipValidation: true });
    expect(props?.toolchain).toEqual({ release: '1.4.1' });
  });

  it('OMITS toolchain when following the default', () => {
    const state = propsToFormState(base);
    expect(state.toolchainRelease).toBe('');
    const { props } = assembleBuilderProps(state, { skipValidation: true });
    expect(props).not.toHaveProperty('toolchain');
  });
});

describe('PluginOptionsEditor and the managed cdk-synth', () => {
  function Editor({ initial }: { initial: FormPluginOptions }) {
    const [value, setValue] = useState(initial);
    return <PluginOptionsEditor value={value} onChange={setValue} />;
  }

  it('a managed cdk-synth has no version or id field', () => {
    render(<Editor initial={{ ...createEmptyPlugin(), name: 'cdk-synth' }} />);
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Plugin ID')).not.toBeInTheDocument();
    expect(screen.getByTestId('managed-toolchain-note')).toHaveTextContent(/toolchain release/i);
  });

  it('a managed name given through filter.name is treated the same', () => {
    const p = createEmptyPlugin();
    render(<Editor initial={{ ...p, name: 'BuildSynth', filter: { ...p.filter, name: 'cdk-synth' } }} />);
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
  });

  it('any other plugin keeps its version field', () => {
    render(<Editor initial={{ ...createEmptyPlugin(), name: 'nodejs-build' }} />);
    expect(screen.getByLabelText('Version')).toBeInTheDocument();
    expect(screen.queryByTestId('managed-toolchain-note')).not.toBeInTheDocument();
  });
});
