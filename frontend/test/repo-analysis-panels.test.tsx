// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two read-only panels `GitUrlTab` used to inline (571 lines, 13 useState),
 * plus the private-repo disclosure. Extracting them is only safe if what the
 * stream reports still renders — including the `unknown` sentinels the backend
 * sends for an unrecognised project type or package manager, which must NOT
 * appear as chips.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisResultPanel, PluginStatusPanel } from '../src/components/pipeline/AnalysisResultPanel';
import { PrivateRepoFields } from '../src/components/pipeline/PrivateRepoFields';
import type { RepoAnalysisData, PluginCreationStatus } from '../src/hooks/internal/useRepoAnalysis';

const analysis: RepoAnalysisData = {
  owner: 'acme', repo: 'widgets', provider: 'github', defaultBranch: 'main',
  projectType: 'node', languages: { TypeScript: 82, CSS: 10, HTML: 8 },
  frameworks: ['next'], packageManager: 'pnpm',
  hasDockerfile: true, hasCdkJson: false, description: 'A thing.',
};

describe('AnalysisResultPanel', () => {
  it('leads with the repo and shows what was detected', () => {
    render(<AnalysisResultPanel analysis={analysis} />);
    expect(screen.getByText('acme/widgets')).toBeInTheDocument();
    expect(screen.getByText('(github) · main')).toBeInTheDocument();
    expect(screen.getByText('node')).toBeInTheDocument();
    expect(screen.getByText('pnpm')).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
    expect(screen.getByText('Docker')).toBeInTheDocument();
    expect(screen.queryByText('AWS CDK')).not.toBeInTheDocument();
    expect(screen.getByText('A thing.')).toBeInTheDocument();
  });

  it('caps the language chips at three', () => {
    render(<AnalysisResultPanel analysis={{ ...analysis, languages: { a: 1, b: 2, c: 3, d: 4 } }} />);
    expect(screen.getByText('a 1%')).toBeInTheDocument();
    expect(screen.queryByText('d 4%')).not.toBeInTheDocument();
  });

  it('hides the "unknown" sentinels rather than showing them as chips', () => {
    render(<AnalysisResultPanel analysis={{ ...analysis, projectType: 'unknown', packageManager: 'unknown' }} />);
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
  });
});

describe('PluginStatusPanel', () => {
  const base: PluginCreationStatus = { creating: [], existing: [], builds: [] };

  it('confirms when every referenced plugin already exists', () => {
    render(<PluginStatusPanel status={{ ...base, existing: ['deploy', 'scan'] }} />);
    expect(screen.getByText('deploy')).toBeInTheDocument();
    expect(screen.getByText(/all referenced plugins already exist/i)).toBeInTheDocument();
  });

  it('shows in-flight builds and reassures that the pipeline can be created now', () => {
    render(<PluginStatusPanel status={{ ...base, creating: ['build'], builds: [{ name: 'build' }] }} />);
    expect(screen.getByText(/auto-creating missing plugins/i)).toBeInTheDocument();
    expect(screen.getByText(/plugin builds started/i)).toBeInTheDocument();
  });

  it('marks a failed build and suppresses the reassurance', () => {
    render(<PluginStatusPanel status={{ ...base, creating: ['build'], builds: [{ name: 'build', error: 'boom' }] }} />);
    expect(screen.getByText('(boom)')).toBeInTheDocument();
    expect(screen.queryByText(/plugin builds started/i)).not.toBeInTheDocument();
  });
});

describe('PrivateRepoFields', () => {
  it('keeps the token field behind a disclosure and reports what is typed', () => {
    const onChange = jest.fn<AnyFn>();
    render(<PrivateRepoFields value="" onChange={onChange} />);
    const toggle = screen.getByRole('button', { name: /private repository/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByPlaceholderText(/personal access token/i)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByPlaceholderText(/personal access token/i), { target: { value: 'ghp_x' } });
    expect(onChange).toHaveBeenCalledWith('ghp_x');
  });
});
