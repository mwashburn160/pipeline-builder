// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The commands the org setup guide tells a new admin to run must WORK when
 * copied in order. Each block here pins one way they did not:
 *
 *  - The ingestion Lambda's credential: the guide stored only the default
 *    `platform-automation` key and ran `setup-events` without `--scoped-ingest`.
 *    That key carries no scope, and the reporting service accepts machine event
 *    writes only from a token whose scope is exactly `reporting:ingest`
 *    (api/reporting/src/middleware/require-ingest-scope.ts) — so every event
 *    403'd and the reports stayed empty while setup looked finished.
 *  - Prerequisites: `PLATFORM_BASE_URL` was exported only in the LAST block, the
 *    sign-in was never mentioned, and `store-token` always needs the password for
 *    its step-up — so the first command failed on a fresh shell.
 *  - Region: hardcoded `us-east-1` in both commands.
 *  - Node floor: the guide said 24.21.0; the CLI's `engines.node` says otherwise.
 *  - DORA: "included in your Enterprise plan" was shown to Business orgs.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';

let mockDeployTarget = 'aws-ec2';
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ deployTarget: mockDeployTarget, isEnabled: () => false, features: [], isLoaded: true, supportAlias: '', supportAliases: [], cliNpmPackage: '@acme/pb-cli', cliNpmUrl: 'https://registry.acme.test/pb-cli' }),
}));

import { OrgSetupStep } from '../src/components/onboarding/OrgSetupStep';

const noop = () => {};

/** The text of every code block, in document order. */
function codeBlocks(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('pre code')).map((n) => n.textContent ?? '');
}

/** Render on AWS with the event-metrics section expanded. */
function renderExpanded(props: Partial<Parameters<typeof OrgSetupStep>[0]> = {}) {
  const view = render(<OrgSetupStep onDone={noop} {...props} />);
  fireEvent.click(screen.getByRole('checkbox', { name: /set up pipeline event metrics/i }));
  return view;
}

beforeEach(() => { mockDeployTarget = 'aws-ec2'; });

describe('setup guide — event ingestion credential', () => {
  it('stores the reporting:ingest scoped key the ingestion Lambda needs', () => {
    const { container } = renderExpanded();
    const all = codeBlocks(container).join('\n');
    expect(all).toMatch(/infra store-token --scope reporting:ingest[^\n]*--schedule/);
  });

  it('stores the registry:push key every AWS build pulls its images with', () => {
    // Synth wires `.../registry-push` into every build image's credentials
    // (pipeline-manager agent/post-steps.ts), so without it builds cannot start.
    const { container } = renderExpanded();
    expect(codeBlocks(container).join('\n')).toMatch(/infra store-token --scope registry:push[^\n]*--schedule/);
  });

  it('stores the pipeline-registration key (the platform key cannot register pipelines)', () => {
    const { container } = renderExpanded();
    expect(codeBlocks(container).join('\n')).toMatch(/infra store-token --scope pipeline_registry:write[^\n]*--schedule/);
  });

  it('points setup-events at that scoped secret (--scoped-ingest)', () => {
    const { container } = renderExpanded();
    const setup = codeBlocks(container).find((b) => b.includes('setup-events'))!;
    expect(setup).toContain('--scoped-ingest');
  });

  it('keeps --scoped-ingest when DORA is toggled on', () => {
    const { container } = renderExpanded();
    fireEvent.click(screen.getByRole('checkbox', { name: /include dora/i }));
    const setup = codeBlocks(container).find((b) => b.includes('setup-events'))!;
    expect(setup).toContain('--scoped-ingest');
    expect(setup).toContain('--with-dora');
  });
});

describe('setup guide — prerequisites come before the first infra command', () => {
  it('exports PLATFORM_BASE_URL, signs in and sets PLATFORM_PASSWORD before store-token', () => {
    const { container } = renderExpanded();
    const blocks = codeBlocks(container);
    const firstStoreToken = blocks.findIndex((b) => b.includes('store-token'));
    expect(firstStoreToken).toBeGreaterThan(-1);
    const before = blocks.slice(0, firstStoreToken).join('\n');
    expect(before).toMatch(/export PLATFORM_BASE_URL=http/);
    expect(before).toContain('pipeline-manager auth login');
    expect(before).toMatch(/PLATFORM_PASSWORD/);
  });

  it('names the AWS CLI + credentials prerequisite', () => {
    renderExpanded();
    expect(screen.getByText(/AWS CLI/)).toBeInTheDocument();
  });
});

describe('setup guide — region', () => {
  it('uses the region the admin enters in every infra command', () => {
    const { container } = renderExpanded();
    fireEvent.change(screen.getByLabelText(/AWS region/i), { target: { value: 'eu-west-2' } });
    const infra = codeBlocks(container).join('\n').split('\n').filter((l) => l.includes('pipeline-manager infra'));
    expect(infra.length).toBeGreaterThanOrEqual(3);
    for (const b of infra) {
      expect(b).toContain('--region eu-west-2');
      expect(b).not.toContain('us-east-1');
    }
  });

  it('refuses a value that is not a region code instead of pasting it into a shell command', () => {
    const { container } = renderExpanded();
    fireEvent.change(screen.getByLabelText(/AWS region/i), { target: { value: 'us-east-1; rm -rf ~' } });
    const all = codeBlocks(container).join('\n');
    expect(all).not.toContain('rm -rf');
    expect(screen.getByText(/not an AWS region code/i)).toBeInTheDocument();
  });
});

describe('setup guide — Node floor follows the CLI', () => {
  it('states the MAJOR.MINOR of pipeline-manager engines.node', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../packages/pipeline-manager/package.json'), 'utf8')) as { engines: { node: string } };
    const [, major, minor] = /(\d+)\.(\d+)/.exec(pkg.engines.node)!;
    render(<OrgSetupStep onDone={noop} />);
    expect(screen.getByText(new RegExp(`Node\\.js ${major}\\.${minor}`))).toBeInTheDocument();
    expect(screen.queryByText(/24\.21/)).not.toBeInTheDocument();
  });
});

describe('setup guide — DORA entitlement wording', () => {
  it.each(['business', 'enterprise', 'unlimited'])('%s: says included without naming another tier', (tier) => {
    renderExpanded({ planTier: tier });
    const msg = screen.getByText(/DORA metrics are included/i);
    if (tier !== 'enterprise') expect(msg.textContent).not.toMatch(/Enterprise/);
  });

  it.each(['developer', 'pro', 'team'])('%s: points at the add-on', (tier) => {
    renderExpanded({ planTier: tier });
    expect(screen.getByText(/Advanced Reporting add-on/i)).toBeInTheDocument();
  });
});
