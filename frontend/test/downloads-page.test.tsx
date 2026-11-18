// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Downloads page is where the setup guide points people "for later", so it
 * must carry the same commands and facts:
 *  - Node floor: it said `>= 24.9`, the CLI requires the floor in its engines.node;
 *  - the install command ignored the runtime `cliNpmPackage` (a deployment that
 *    republishes the CLI under its own name got the public name here);
 *  - the store-token / setup-events commands the guide promised were not on it;
 *  - the quick start never mentioned `auth login` (a browser sign-in), only a
 *    pasted token.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';

let mockDeployTarget = 'aws-eks';
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ deployTarget: mockDeployTarget, isEnabled: () => false, features: [], isLoaded: true, supportAlias: '', supportAliases: [], cliNpmPackage: '@acme/pb-cli', cliNpmUrl: 'https://registry.acme.test/pb-cli' }),
}));
const mockUser = { id: 'u1', organizationId: 'org-1', permissions: [] as string[] };
jest.mock('@/hooks/useAuthGuard', () => ({ useAuthGuard: () => ({ user: mockUser, isReady: true }) }));
jest.mock('@/components/ui/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import DownloadsPage from '../pages/dashboard/downloads';

beforeEach(() => { mockDeployTarget = 'aws-eks'; });

describe('Downloads page', () => {
  it('states the CLI Node floor from pipeline-manager engines.node', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../packages/pipeline-manager/package.json'), 'utf8')) as { engines: { node: string } };
    const [, major, minor] = /(\d+)\.(\d+)/.exec(pkg.engines.node)!;
    render(<DownloadsPage />);
    expect(screen.getAllByText(new RegExp(`${major}\\.${minor}`)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/24\.9/)).not.toBeInTheDocument();
  });

  it('installs the CLI package the deployment serves, not the hardcoded public name', () => {
    const { container } = render(<DownloadsPage />);
    expect(container.textContent).toContain('npm install -g @acme/pb-cli');
    expect(container.textContent).not.toContain('@pipeline-builder/pipeline-manager');
  });

  it('documents the browser sign-in', () => {
    const { container } = render(<DownloadsPage />);
    expect(container.textContent).toContain('pipeline-manager auth login');
  });

  it('carries the org setup guide commands on AWS', () => {
    const { container } = render(<DownloadsPage />);
    fireEvent.click(screen.getByRole('checkbox', { name: /set up pipeline event metrics/i }));
    expect(container.textContent).toContain('store-token --scope reporting:ingest');
    expect(container.textContent).toContain('setup-events --scoped-ingest');
  });
});
