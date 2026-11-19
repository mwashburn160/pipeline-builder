// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OrgSetupStep AWS-gating: the "pipeline event metrics" section (store-token →
 * setup-events, ± DORA) is AWS-target-only — it renders on aws-ec2 / aws-eks and
 * is hidden on local/docker/minikube, where the store-token/setup-events infra
 * commands don't apply. The CLI-install step + Done button show on every target.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, screen } from '@testing-library/react';

// deployTarget flows from useFeatures(); drive it per test.
let mockDeployTarget = 'local';
let mockFeatures: string[] = [];
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ deployTarget: mockDeployTarget, isEnabled: (f: string) => mockFeatures.includes(f), features: [], isLoaded: true, supportAlias: '', supportAliases: [], cliNpmPackage: '@acme/pb-cli', cliNpmUrl: 'https://registry.acme.test/pb-cli' }),
}));

import { OrgSetupStep } from '../src/components/onboarding/OrgSetupStep';

const noop = () => {};

describe('OrgSetupStep — AWS event-metrics gating', () => {
  it('shows the event-metrics setup step on an AWS target', () => {
    mockDeployTarget = 'aws-ec2';
    render(<OrgSetupStep onDone={noop} />);
    // Appears in both the overview list and the step-2 label on AWS.
    expect(screen.getAllByText(/Set up pipeline event metrics/i).length).toBeGreaterThanOrEqual(1);
    // The AWS-only "Store a service token" overview line is present.
    expect(screen.getByText(/Store a service token/i)).toBeInTheDocument();
    // The install step + Done button are always present.
    expect(screen.getByText(/Install the CLI/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to dashboard/i })).toBeInTheDocument();
  });

  it('also shows it on the aws-eks target', () => {
    mockDeployTarget = 'aws-eks';
    render(<OrgSetupStep onDone={noop} />);
    expect(screen.getByText(/Store a service token/i)).toBeInTheDocument();
  });

  it('hides the event-metrics step on a non-AWS target (local)', () => {
    mockDeployTarget = 'local';
    render(<OrgSetupStep onDone={noop} />);
    expect(screen.queryByText(/Set up pipeline event metrics/i)).not.toBeInTheDocument();
    // The store-token hint (AWS-only) is absent...
    expect(screen.queryByText(/Store a service token/i)).not.toBeInTheDocument();
    // ...but the CLI install step still renders.
    expect(screen.getByText(/Install the CLI/i)).toBeInTheDocument();
  });

  it('hides it on docker / minikube too', () => {
    mockDeployTarget = 'docker';
    const { rerender } = render(<OrgSetupStep onDone={noop} />);
    expect(screen.queryByText(/Set up pipeline event metrics/i)).not.toBeInTheDocument();
    mockDeployTarget = 'minikube';
    rerender(<OrgSetupStep onDone={noop} />);
    expect(screen.queryByText(/Set up pipeline event metrics/i)).not.toBeInTheDocument();
  });
});

describe('OrgSetupStep — install a pipeline runner (optional)', () => {
  beforeEach(() => { mockFeatures = ['cross_account_runners']; });
  afterEach(() => { mockFeatures = []; });

  it('on an AWS target, offers the optional step with the CLI command and a link to Settings → Pipeline runners', () => {
    mockDeployTarget = 'aws-ec2';
    render(<OrgSetupStep onDone={noop} />);
    const step = screen.getByTestId('setup-install-runner');
    expect(step).toHaveTextContent(/Install a pipeline runner/);
    expect(step).toHaveTextContent(/optional/);
    expect(step).toHaveTextContent('pipeline-manager infra setup-runner --region us-east-1');
    expect(screen.getByRole('link', { name: /Pipeline runners/ })).toHaveAttribute('href', '/dashboard/settings?tab=organization#pipeline-runners');
    // Listed in the overview too.
    expect(screen.getAllByText(/Install a pipeline runner/).length).toBe(2);
  });

  it('is absent on a non-AWS target', () => {
    mockDeployTarget = 'local';
    render(<OrgSetupStep onDone={noop} />);
    expect(screen.queryByTestId('setup-install-runner')).not.toBeInTheDocument();
    expect(screen.queryByText(/Install a pipeline runner/)).not.toBeInTheDocument();
  });

  it('is hidden (step and overview line, no upsell) on an AWS target without the cross_account_runners feature', () => {
    mockFeatures = [];
    mockDeployTarget = 'aws-ec2';
    render(<OrgSetupStep onDone={noop} />);
    expect(screen.queryByTestId('setup-install-runner')).not.toBeInTheDocument();
    expect(screen.queryByText(/pipeline runner/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/setup-runner/)).not.toBeInTheDocument();
    // The rest of the AWS guide is unaffected.
    expect(screen.getByText(/Store a service token/i)).toBeInTheDocument();
  });
});
