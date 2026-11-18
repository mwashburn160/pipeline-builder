import { m } from 'framer-motion';
import Link from 'next/link';
import { Terminal, Package, Copy, Check, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFeatures } from '@/hooks/useFeatures';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinkButton } from '@/components/ui/LinkButton';
import { Card } from '@/components/ui/Card';
import { ACCESS_KEYS_HREF } from '@/lib/security-links';
import { DEFAULT_CLI_NPM_PACKAGE } from '@/lib/constants';
import { CLI_MIN_NODE } from '@/lib/setup-guide';
import { isAwsTarget } from '@/lib/deploy-target';
import { OrgSetupStep } from '@/components/onboarding/OrgSetupStep';

function CopyInline({ text }: { text: string }) {
  // The checkmark shows only once the write resolves; a refused write
  // (insecure context / permission) leaves the copy icon in place.
  const { state, copy } = useCopyToClipboard(2000);

  return (
    <button
      type="button"
      onClick={() => { void copy(text); }}
      className="ml-2 inline-flex items-center text-fg-subtle hover:text-fg transition-colors"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {state === 'copied' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

/**
 * A shell snippet in terminal chrome. Deliberately dark with green text in BOTH
 * themes — it depicts a terminal, so it does not follow the surface tokens; the
 * one place the raw palette is spelled out is here rather than at five call
 * sites. `copy` adds the inline copy affordance beside a single command.
 */
function TerminalBlock({ copy, children }: { copy?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg bg-gray-900 dark:bg-gray-950 px-4 py-2.5 ${copy ? 'flex items-center' : 'space-y-1'}`}>
      {children}
      {copy && <CopyInline text={copy} />}
    </div>
  );
}

/** One command line inside a {@link TerminalBlock}. */
function Command({ block, children }: { block?: boolean; children: React.ReactNode }) {
  return <code className={`${block ? 'block' : 'flex-1'} text-sm font-mono text-green-400`}>{children}</code>;
}

export default function DownloadsPage() {
  const { user, isReady } = useAuthGuard();
  const features = useFeatures();
  // The package the deployment serves (`/config` → `config.cli`), like the setup
  // guide: a deployment that republishes the CLI under its own name must not be
  // told to install the public one here.
  const cliPackage = features.cliNpmPackage || DEFAULT_CLI_NPM_PACKAGE;
  const showAwsSetup = isAwsTarget(features.deployTarget);
  const [origin, setOrigin] = useState('https://your-platform.example.com');
  useEffect(() => { if (typeof window !== 'undefined') setOrigin(window.location.origin); }, []);
  const loginCmd = `pipeline-manager auth login --url ${origin}`;

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Downloads" subtitle="Install the Pipeline Manager CLI">
      <div className="max-w-3xl space-y-6">
        {/* Hero install card */}
        <Card
          as={m.div}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-start gap-4">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-solid text-white shrink-0">
              <Terminal className="h-6 w-6" />
            </span>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-fg">Pipeline Manager CLI</h2>
              <p className="mt-1 text-sm text-fg-muted">
                The primary tool for managing plugins, pipelines, and deployments from the terminal.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted mb-2">
                Install via npm
              </p>
              <TerminalBlock copy={`npm install -g ${cliPackage}`}>
                <Command>npm install -g {cliPackage}</Command>
              </TerminalBlock>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted mb-2">
                Or with pnpm
              </p>
              <TerminalBlock copy={`pnpm add -g ${cliPackage}`}>
                <Command>pnpm add -g {cliPackage}</Command>
              </TerminalBlock>
            </div>
          </div>
        </Card>

        {/* Quick start */}
        <Card
          as={m.div}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          <h3 className="text-base font-semibold text-fg mb-4">Quick start</h3>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-info-bg text-xs font-bold text-info shrink-0 mt-0.5">
                1
              </span>
              <div className="flex-1">
                <p className="text-sm text-fg-muted mb-1.5">Sign in through your browser (the session is stored for later commands):</p>
                <TerminalBlock copy={loginCmd}>
                  <Command>{loginCmd}</Command>
                </TerminalBlock>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-info-bg text-xs font-bold text-info shrink-0 mt-0.5">
                2
              </span>
              <div className="flex-1">
                <p className="text-sm text-fg-muted mb-1.5">
                  In CI, or anywhere without a browser, create an access key on the{' '}
                  <Link href={ACCESS_KEYS_HREF} className="action-link">Security → Access keys</Link> page and export it instead:
                </p>
                <TerminalBlock copy="export PLATFORM_TOKEN=<your-token>">
                  <Command>export PLATFORM_TOKEN=&lt;your-token&gt;</Command>
                </TerminalBlock>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-info-bg text-xs font-bold text-info shrink-0 mt-0.5">
                3
              </span>
              <div className="flex-1">
                <p className="text-sm text-fg-muted mb-1.5">Start using the CLI:</p>
                <TerminalBlock>
                  <Command block>pipeline-manager pipeline list</Command>
                  <Command block>pipeline-manager plugin list</Command>
                  <Command block>pipeline-manager pipeline deploy --id &lt;pipeline-id&gt;</Command>
                </TerminalBlock>
              </div>
            </div>
          </div>
        </Card>

        {/* Prerequisites */}
        <Card
          as={m.div}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <h3 className="text-base font-semibold text-fg mb-3">Prerequisites</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-fg-subtle" />
                <span className="text-sm font-medium text-fg">Node.js</span>
              </div>
              <p className="text-xs text-fg-muted">&gt;= {CLI_MIN_NODE}</p>
            </div>
            <div className="rounded-lg border border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-fg-subtle" />
                <span className="text-sm font-medium text-fg">AWS CLI</span>
              </div>
              <p className="text-xs text-fg-muted">{showAwsSetup ? 'With credentials, for the infra commands' : 'Only for AWS deployments'}</p>
            </div>
            <div className="rounded-lg border border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-fg-subtle" />
                <span className="text-sm font-medium text-fg">Docker</span>
              </div>
              <p className="text-xs text-fg-muted">For plugin builds</p>
            </div>
          </div>
        </Card>

        {/* The org setup guide — the same component (and commands) the first-run
            step and the dashboard popup show, with live progress. */}
        <Card
          as={m.div}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.18 }}
          id="setup-guide"
        >
          <h3 className="text-base font-semibold text-fg mb-4">Organization setup guide</h3>
          <OrgSetupStep showDone={false} status={user.organizationId ? { orgId: user.organizationId, user } : undefined} />
        </Card>

        {/* Links */}
        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
          className="flex flex-wrap gap-3"
        >
          <LinkButton href="/dashboard/help" variant="secondary">
            <ExternalLink className="w-4 h-4" />
            CLI Reference
          </LinkButton>
          <LinkButton href={ACCESS_KEYS_HREF} variant="secondary">
            <ExternalLink className="w-4 h-4" />
            Access keys
          </LinkButton>
        </m.div>
      </div>
    </DashboardLayout>
  );
}
