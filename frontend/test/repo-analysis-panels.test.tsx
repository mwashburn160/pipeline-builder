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
import { AnalysisResultPanel, MissingPluginsPanel, PluginStatusPanel } from '../src/components/pipeline/AnalysisResultPanel';
import { PrivateRepoFields } from '../src/components/pipeline/PrivateRepoFields';
import type { RepoAnalysisData, PluginCreationStatus, MissingPluginProposal } from '../src/hooks/internal/useRepoAnalysis';

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

/**
 * The from-URL stream PROPOSES the plugins a config references but the org
 * lacks; nothing is created until the user confirms, and only the names they
 * left ticked are sent.
 */
describe('MissingPluginsPanel', () => {
  const proposal: MissingPluginProposal = {
    existing: ['deploy'],
    proposed: ['lint', 'scan'],
    refused: [{ name: 'trivy', error: 'PLUGIN_NAME_LISTED: "trivy" is a listed plugin' }],
  };

  it('lists existing, proposed and refused plugins, and creates nothing on render', () => {
    const onConfirm = jest.fn<AnyFn>();
    render(<MissingPluginsPanel proposal={proposal} creating={false} onConfirm={onConfirm} />);
    expect(screen.getByText('deploy')).toBeInTheDocument();
    expect(screen.getByText('lint')).toBeInTheDocument();
    expect(screen.getByText('trivy')).toBeInTheDocument();
    expect(screen.getByText(/nothing is created until you confirm/i)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('sends exactly the names the user left ticked', () => {
    const onConfirm = jest.fn<AnyFn>();
    render(<MissingPluginsPanel proposal={proposal} creating={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // untick "scan"
    fireEvent.click(screen.getByRole('button', { name: /create 1 placeholder plugin$/i }));
    expect(onConfirm).toHaveBeenCalledWith(['lint']);
  });

  it('cannot confirm an empty selection', () => {
    render(<MissingPluginsPanel proposal={{ ...proposal, proposed: ['lint'] }} creating={false} onConfirm={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: /create 0 placeholder plugins/i })).toBeDisabled();
  });

  it('says so when every referenced plugin already exists', () => {
    render(<MissingPluginsPanel proposal={{ existing: ['deploy', 'scan'], proposed: [], refused: [] }} creating={false} onConfirm={jest.fn<AnyFn>()} />);
    expect(screen.getByText(/all referenced plugins already exist/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('PluginStatusPanel', () => {
  const base: PluginCreationStatus = { created: [], existing: [], builds: [] };

  it('shows in-flight builds and reassures that the pipeline can be created now', () => {
    render(<PluginStatusPanel status={{ ...base, created: ['build'], builds: [{ name: 'build' }] }} />);
    expect(screen.getByText(/placeholder plugins/i)).toBeInTheDocument();
    expect(screen.getByText(/plugin builds started/i)).toBeInTheDocument();
  });

  it('marks a failed build and suppresses the reassurance', () => {
    render(<PluginStatusPanel status={{ ...base, created: ['build'], builds: [{ name: 'build', error: 'boom' }] }} />);
    expect(screen.getByText('(boom)')).toBeInTheDocument();
    expect(screen.queryByText(/plugin builds started/i)).not.toBeInTheDocument();
  });

  it('says when the confirmed plugins turned out to exist already', () => {
    render(<PluginStatusPanel status={{ ...base, existing: ['deploy'] }} />);
    expect(screen.getByText(/already exist/i)).toBeInTheDocument();
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
