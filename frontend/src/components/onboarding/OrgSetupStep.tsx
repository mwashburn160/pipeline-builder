// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Download, Terminal, BarChart3, Package } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { HelpCodeBlock } from '@/components/help/HelpCodeBlock';
import { isAwsTarget } from '@/lib/deploy-target';
import { useFeatures } from '@/hooks/useFeatures';

const NPM_PACKAGE = '@pipeline-builder/pipeline-manager';
const NPM_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;
const INSTALL_CMD = `npm install -g ${NPM_PACKAGE}`;

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
  const { deployTarget } = useFeatures();
  const showEvents = isAwsTarget(deployTarget);
  const [wantEvents, setWantEvents] = useState(false);
  const [withDora, setWithDora] = useState(false);
  // PLATFORM_BASE_URL for the setup-events command = the gateway origin the browser
  // is on (nginx serves both the app and /api). Resolved client-side.
  const [origin, setOrigin] = useState('https://your-platform.example.com');
  useEffect(() => { if (typeof window !== 'undefined') setOrigin(window.location.origin); }, []);

  const doraIncluded = planTier === 'enterprise';
  const setupEventsCmd = `export PLATFORM_BASE_URL=${origin}\npipeline-manager infra setup-events --region us-east-1${withDora ? ' --with-dora' : ''}`;

  return (
    <div className={variant === 'modal' ? '' : 'space-y-5'}>
      {/* Overview highlight — the three steps at a glance. */}
      <div className="rounded-lg border border-[var(--pb-border)] bg-[var(--pb-surface-muted)] p-3">
        <div className="text-sm font-semibold mb-2">Finish setting up</div>
        <ol className="space-y-1.5 text-sm text-[var(--pb-text-muted)]">
          <li className="flex items-center gap-2"><Package className="w-4 h-4 text-[var(--pb-brand)] shrink-0" /> Install the pipeline-manager CLI</li>
          {showEvents && <li className="flex items-center gap-2"><Terminal className="w-4 h-4 text-[var(--pb-brand)] shrink-0" /> Store a service token</li>}
          {showEvents && <li className="flex items-center gap-2"><BarChart3 className="w-4 h-4 text-[var(--pb-brand)] shrink-0" /> Set up pipeline event metrics <span className="text-xs">(optional{', '}with or without DORA)</span></li>}
        </ol>
      </div>

      {/* Step 1 — install the CLI. */}
      <div className="space-y-2">
        <div className="text-sm font-semibold">1 · Install the CLI</div>
        <p className="text-xs text-[var(--pb-text-muted)]">Requires Node.js 24.14.0 or newer.</p>
        <HelpCodeBlock content={INSTALL_CMD} language="bash" />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <LinkButton href={NPM_URL} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
            <Download className="w-4 h-4 mr-1.5" /> View on npm
          </LinkButton>
          <LinkButton href="/dashboard/downloads" variant="ghost" size="sm">Full quick-start</LinkButton>
          <LinkButton href="/dashboard/tokens" variant="ghost" size="sm">API tokens</LinkButton>
        </div>
      </div>

      {/* Step 2 — pipeline event metrics (AWS targets only). */}
      {showEvents && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
            <Checkbox checked={wantEvents} onChange={(e) => setWantEvents(e.target.checked)} />
            2 · Set up pipeline event metrics <span className="font-normal text-[var(--pb-text-muted)]">(optional)</span>
          </label>
          {wantEvents && (
            <div className="space-y-3 pl-1">
              <p className="text-xs text-[var(--pb-text-muted)]">Run these once per organization. Store the token first — the event ingestion reads it.</p>
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
          <p className="text-xs text-[var(--pb-text-muted)] text-center mt-2">
            You can run the metrics setup later — the commands are on the Downloads page.
          </p>
        )}
      </div>
    </div>
  );
}
