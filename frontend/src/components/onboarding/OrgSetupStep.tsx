// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Download, Terminal, BarChart3, Package, KeyRound, Server } from 'lucide-react';
// SUBPATH, not the barrel: `@pipeline-builder/api-core` pulls in express
// transitively, which has no TextDecoder under jsdom — importing it here took
// out three component suites at LOAD with an error naming nothing to do with
// this file. Same reason token-scopes.ts imports `api-core/permissions`.
import { TIER_FEATURES } from '@pipeline-builder/api-core/feature-flags';
import { Button } from '@/components/ui/Button';
import { LinkButton } from '@/components/ui/LinkButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { FormField } from '@/components/ui/FormField';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { HelpCodeBlock } from '@/components/help/HelpCodeBlock';
import { SetupStatusPanel } from '@/components/onboarding/SetupStatusPanel';
import { DEFAULT_CLI_NPM_PACKAGE, DEFAULT_CLI_NPM_URL } from '@/lib/constants';
import type { TierKey } from '@/lib/tiers';
import { isAwsTarget } from '@/lib/deploy-target';
import { ACCESS_KEYS_HREF } from '@/lib/security-links';
import { ONE_RUNNER_PER_ACCOUNT_COPY, PIPELINE_RUNNERS_HREF, setupRunnerCommand } from '@/lib/pipeline-runners';
import { CLI_MIN_NODE, DEFAULT_SETUP_REGION, isAwsRegion, setupCommands } from '@/lib/setup-guide';
import { useFeatures } from '@/hooks/useFeatures';
import type { User } from '@/types';


interface OrgSetupStepProps {
  /** The org's plan tier (e.g. 'business') — drives the DORA "included vs add-on"
   *  hint. When absent, the active org's own entitlements decide. */
  planTier?: string;
  /** Called by the final "Continue"/"Done" button. */
  onDone?: () => void;
  /** Label for the final button. Defaults to "Continue to dashboard". */
  doneLabel?: string;
  /** 'page' (first-run onboarding, Downloads) or 'modal' (popup). Layout only. */
  variant?: 'page' | 'modal';
  /** Render the final button. Off where the guide is reference material (Downloads). */
  showDone?: boolean;
  /** Show live progress (key issued, events arriving) for this org, read as
   *  this user. Omitted on the first-run page, where the org is seconds old. */
  status?: { orgId: string; user: User | null };
  /** Extra controls beside the final button (the popup's "Remind me later"). */
  secondaryAction?: React.ReactNode;
}

/**
 * The org setup guide: install the pipeline-manager CLI and — on AWS targets —
 * set up the per-org event-metrics infra (sign in → store the platform and
 * reporting-ingest keys → setup-events, ± DORA). The commands come from
 * `lib/setup-guide.ts`, so every surface that shows this guide (first-run
 * onboarding, the dashboard popup, the Downloads page, the New Organization
 * flow) shows the same, working, commands.
 */
export function OrgSetupStep({
  planTier,
  onDone,
  doneLabel = 'Continue to dashboard',
  variant = 'page',
  showDone = true,
  status,
  secondaryAction,
}: OrgSetupStepProps) {
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
  // The runner step: AWS targets. Every pipeline runs through a runner, so it
  // is not optional there.
  const showRunner = showEvents;
  const [wantEvents, setWantEvents] = useState(false);
  const [withDora, setWithDora] = useState(false);
  const [region, setRegion] = useState(DEFAULT_SETUP_REGION);
  const regionValid = isAwsRegion(region);
  // PLATFORM_BASE_URL = the gateway origin the browser is on (nginx serves both
  // the app and /api). Resolved client-side.
  const [origin, setOrigin] = useState('https://your-platform.example.com');
  useEffect(() => { if (typeof window !== 'undefined') setOrigin(window.location.origin); }, []);

  // Derived from TIER_FEATURES rather than naming tiers: DORA is included in
  // Business as well as Enterprise (and in `unlimited`, the billing-off tier,
  // where nothing is metered). Without a tier (the popup, on an existing org)
  // the org's live entitlements decide, which also counts a purchased add-on.
  const doraIncluded = planTier
    ? (TIER_FEATURES[planTier as TierKey] ?? []).includes('advanced_reporting')
    : features.isEnabled('advanced_reporting');
  const cmds = setupCommands({ origin, region, withDora });

  return (
    <div className={variant === 'modal' ? 'space-y-4' : 'space-y-5'}>
      {/* Overview highlight — the steps at a glance. */}
      <div className="rounded-lg border border-default bg-surface-muted p-3">
        <div className="text-sm font-semibold mb-2">Finish setting up</div>
        <ol className="space-y-1.5 text-sm text-fg-muted">
          <li className="flex items-center gap-2"><Package className="w-4 h-4 text-brand shrink-0" /> Install the pipeline-manager CLI</li>
          {showEvents && <li className="flex items-center gap-2"><Terminal className="w-4 h-4 text-brand shrink-0" /> Store a service token</li>}
          {showEvents && <li className="flex items-center gap-2"><BarChart3 className="w-4 h-4 text-brand shrink-0" /> Set up pipeline event metrics <span className="text-xs">(optional{', '}with or without DORA)</span></li>}
          {showRunner && <li className="flex items-center gap-2"><Server className="w-4 h-4 text-brand shrink-0" /> Install a pipeline runner <span className="text-xs">(before your first run)</span></li>}
        </ol>
      </div>

      {status && <SetupStatusPanel orgId={status.orgId} user={status.user} showEvents={showEvents} />}

      {/* Step 1 — install the CLI. */}
      <div className="space-y-2">
        <div className="text-sm font-semibold">1 · Install the CLI</div>
        <p className="text-xs text-fg-muted">Requires Node.js {CLI_MIN_NODE} or newer.</p>
        <HelpCodeBlock content={installCmd} language="bash" />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <LinkButton href={cliNpmUrl} target="_blank" rel="noopener noreferrer" variant="secondary" size="sm">
            <Download className="w-4 h-4 mr-1.5" /> View on npm
          </LinkButton>
          <LinkButton href="/dashboard/downloads" variant="ghost" size="sm">Full quick-start</LinkButton>
          <LinkButton href={ACCESS_KEYS_HREF} variant="ghost" size="sm">Access keys</LinkButton>
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
              <p className="text-xs text-fg-muted">
                Run these once per organization, in order. You need the AWS CLI with credentials for the target
                account (CloudFormation and Secrets Manager access).
              </p>

              <FormField
                label="AWS region"
                error={regionValid ? undefined : `"${region}" is not an AWS region code (for example us-east-1).`}
              >
                <Input value={region} onChange={(e) => setRegion(e.target.value.trim())} className="max-w-[12rem] font-mono" spellCheck={false} />
              </FormField>

              <div className="text-xs font-semibold flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" /> Sign in</div>
              <p className="text-xs text-fg-muted">
                Each <code>store-token</code> asks you to confirm it&apos;s you by approving in your browser — with a
                passkey, SSO, Google/GitHub or your password, whatever your account uses. In CI, set{' '}
                <code>PLATFORM_PASSWORD</code> instead.
              </p>
              <HelpCodeBlock content={cmds.prerequisites} language="bash" />

              <div className="text-xs font-semibold">Store the service tokens</div>
              <p className="text-xs text-fg-muted">
                Four least-privilege keys: the platform key (pipeline synth and deploy), the registry key (builds pull
                their images with it), the registration key (deployed pipelines register with it) and the{' '}
                <code>reporting:ingest</code> key — the only credential the reporting service accepts events from.{' '}
                <code>--schedule</code> deploys a daily job that replaces each key before it expires.
              </p>
              <HelpCodeBlock content={cmds.tokens} language="bash" />

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={withDora} onChange={(e) => setWithDora(e.target.checked)} />
                Include DORA metrics (measured commit→deploy lead time)
              </label>
              <div className="text-xs font-semibold">Deploy event ingestion</div>
              <HelpCodeBlock content={cmds.setupEvents} language="bash" />
              <InfoAlert message={
                doraIncluded
                  ? 'DORA metrics are included in your plan.'
                  : 'DORA metrics require the Advanced Reporting add-on (buy it anytime from Billing).'
              } />
            </div>
          )}
        </div>
      )}

      {/* Step 3 — a pipeline runner (AWS targets only). Every pipeline run goes
          through one, so it comes before the first run. */}
      {showRunner && (
        <div className="space-y-2" data-testid="setup-install-runner">
          <div className="text-sm font-semibold">
            3 · Install a pipeline runner <span className="font-normal text-fg-muted">(before your first run)</span>
          </div>
          <p className="text-xs text-fg-muted">
            Every pipeline runs through a runner in the AWS account it deploys to: install one there before you run
            your first pipeline. It is a small Lambda that starts and stops your pipelines with its own role — the
            platform gets no access to your account.
          </p>
          <p className="text-xs text-fg-muted" data-testid="setup-runner-one-per-account">{ONE_RUNNER_PER_ACCOUNT_COPY}</p>
          <HelpCodeBlock content={setupRunnerCommand({ region: regionValid ? region : DEFAULT_SETUP_REGION })} language="bash" />
          <LinkButton href={PIPELINE_RUNNERS_HREF} variant="secondary" size="sm">
            <Server className="w-4 h-4 mr-1.5" /> Pipeline runners
          </LinkButton>
        </div>
      )}

      {showDone && onDone && (
        <div className="pt-1">
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {secondaryAction}
            <Button onClick={onDone} className="w-full sm:flex-1">{doneLabel}</Button>
          </div>
          {showEvents && (
            <p className="text-xs text-fg-muted text-center mt-2">
              You can run the metrics setup later — the guide is on the Downloads page.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
