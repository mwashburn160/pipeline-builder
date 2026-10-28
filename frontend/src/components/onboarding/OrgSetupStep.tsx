// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Download, Terminal, BarChart3, Package } from 'lucide-react';
// SUBPATH, not the barrel: `@pipeline-builder/api-core` pulls in express
// transitively, which has no TextDecoder under jsdom — importing it here took
// out three component suites at LOAD with an error naming nothing to do with
// this file. Same reason token-scopes.ts imports `api-core/permissions`.
import { TIER_FEATURES } from '@pipeline-builder/api-core/feature-flags';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { HelpCodeBlock } from '@/components/help/HelpCodeBlock';
import { DEFAULT_CLI_NPM_PACKAGE, DEFAULT_CLI_NPM_URL } from '@/lib/constants';
import type { TierKey } from '@/lib/tiers';
import { isAwsTarget } from '@/lib/deploy-target';
import { useFeatures } from '@/hooks/useFeatures';


interface OrgSetupStepProps {
  /** The org's plan tier (e.g. 'enterprise') — drives the DORA "included vs add-on" hint. */
  planTier?: string;
  /** Called by the final "Continue"/"Done" button. */
  onDone: () => void;
  /** Label for the final button. Defaults to "Continue to dashboard". */
  doneLabel?: string;
  /** 'page' (first-run onboarding) or 'modal' (post org-create). Layout only. */
  variant?: 'page' | 'modal';
}

/**
 * The final org-setup step shown after a new (top-level) organization is created:
 * install the pipeline-manager CLI, and — on AWS targets — optionally set up the
 * per-org event-metrics infra (store-token → setup-events, ± DORA). Reused by the
 * first-run onboarding page and the dashboard "New Organization" flow.
 */
export function OrgSetupStep({ planTier, onDone, doneLabel = 'Continue to dashboard', variant = 'page' }: OrgSetupStepProps) {
  // CLI_NPM_PACKAGE / CLI_NPM_URL, served at runtime by /config (see
  // platform `config.cli`) and falling back to the public npm package. They are
  // NOT module constants any more: a deployment that republishes the CLI under
  // its own name needs the install command and the link to follow, and the
  // frontend is one prebuilt image so a build-time inline could not do that.
  const features = useFeatures();
  const { deployTarget } = features;
  // Defaulted at the point of USE as well as in the context: an anchor with
  // `href={undefined}` renders a link that goes nowhere, and a partial context
  // (any consumer that builds its own) should not be able to produce one.
  const cliNpmPackage = features.cliNpmPackage || DEFAULT_CLI_NPM_PACKAGE;
  const cliNpmUrl = features.cliNpmUrl || DEFAULT_CLI_NPM_URL;
  const installCmd = `npm install -g ${cliNpmPackage}`;
  const showEvents = isAwsTarget(deployTarget);
  const [wantEvents, setWantEvents] = useState(false);
  const [withDora, setWithDora] = useState(false);
  // PLATFORM_BASE_URL for the setup-events command = the gateway origin the browser
  // is on (nginx serves both the app and /api). Resolved client-side.
  const [origin, setOrigin] = useState('https://your-platform.example.com');
  useEffect(() => { if (typeof window !== 'undefined') setOrigin(window.location.origin); }, []);

  // Derived from TIER_FEATURES rather than naming tiers: DORA is included in
  // Business as well as Enterprise (and in `unlimited`, the billing-off tier,
  // where nothing is metered), and the hardcoded comparison silently told a
  // Business admin their included feature was a paid add-on.
  const doraIncluded = !!planTier && (TIER_FEATURES[planTier as TierKey] ?? []).includes('advanced_reporting');
  const setupEventsCmd = `export PLATFORM_BASE_URL=${origin}\npipeline-manager infra setup-events --region us-east-1${withDora ? ' --with-dora' : ''}`;

  return (
    <div className={variant === 'modal' ? '' : 'space-y-5'}>
      {/* Overview highlight — the three steps at a glance. */}
      <div className="rounded-lg border border-default bg-surface-muted p-3">
        <div className="text-sm font-semibold mb-2">Finish setting up</div>
        <ol className="space-y-1.5 text-sm text-fg-muted">
          <li className="flex items-center gap-2"><Package className="w-4 h-4 text-brand shrink-0" /> Install the pipeline-manager CLI</li>
          {showEvents && <li className="flex items-center gap-2"><Terminal className="w-4 h-4 text-brand shrink-0" /> Store a service token</li>}
          {showEvents && <li className="flex items-center gap-2"><BarChart3 className="w-4 h-4 text-brand shrink-0" /> Set up pipeline event metrics <span className="text-xs">(optional{', '}with or without DORA)</span></li>}
        </ol>
      </div>

      {/* Step 1 — install the CLI. */}
      <div className="space-y-2">
        <div className="text-sm font-semibold">1 · Install the CLI</div>
        <p className="text-xs text-fg-muted">Requires Node.js 24.21.0 or newer.</p>
        <HelpCodeBlock content={installCmd} language="bash" />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <LinkButton href={cliNpmUrl} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
            <Download className="w-4 h-4 mr-1.5" /> View on npm
          </LinkButton>
          <LinkButton href="/dashboard/downloads" variant="ghost" size="sm">Full quick-start</LinkButton>
          <LinkButton href="/dashboard/security?tab=keys" variant="ghost" size="sm">Access keys</LinkButton>
        </div>
      </div>

      {/* Step 2 — pipeline event metrics (AWS targets only). */}
      {showEvents && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
            <Checkbox checked={wantEvents} onChange={(e) => setWantEvents(e.target.checked)} />
            2 · Set up pipeline event metrics <span className="font-normal text-fg-muted">(optional)</span>
          </label>
          {wantEvents && (
            <div className="space-y-3 pl-1">
              <p className="text-xs text-fg-muted">Run these once per organization. Store the token first — the event ingestion reads it.</p>
              <HelpCodeBlock content={'pipeline-manager infra store-token --days 30 --schedule --region us-east-1'} language="bash" />
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={withDora} onChange={(e) => setWithDora(e.target.checked)} />
                Include DORA metrics (measured commit→deploy lead time)
              </label>
              <HelpCodeBlock content={setupEventsCmd} language="bash" />
              <InfoAlert message={
                doraIncluded
                  ? 'DORA metrics are included in your Enterprise plan.'
                  : 'DORA metrics require the Advanced Reporting add-on (buy it anytime from Billing).'
              } />
            </div>
          )}
        </div>
      )}

      <div className="pt-1">
        <Button onClick={onDone} className="w-full">{doneLabel}</Button>
        {showEvents && (
          <p className="text-xs text-fg-muted text-center mt-2">
            You can run the metrics setup later — the commands are on the Downloads page.
          </p>
        )}
      </div>
    </div>
  );
}
