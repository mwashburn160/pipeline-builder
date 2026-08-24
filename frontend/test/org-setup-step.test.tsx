// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OrgSetupStep AWS-gating: the "pipeline event metrics" section (store-token →
 * setup-events, ± DORA) is AWS-target-only — it renders on aws-ec2 / aws-eks and
 * is hidden on local/docker/minikube, where the store-token/setup-events infra
 * commands don't apply. The CLI-install step + Done button show on every target.
 */

import { render, screen } from '@testing-library/react';

// deployTarget flows from useFeatures(); drive it per test.
let mockDeployTarget = 'local';
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ deployTarget: mockDeployTarget, isEnabled: () => false, features: [], isLoaded: true, supportAlias: '', supportAliases: [] }),
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
