import { motion } from 'framer-motion';
import Link from 'next/link';
import { Terminal, Package, Copy, Check, ExternalLink } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { LinkButton } from '@/components/ui/LinkButton';

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

  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout title="Downloads" subtitle="Install the Pipeline Manager CLI">
      <div className="max-w-3xl space-y-6">
        {/* Hero install card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="card"
        >
          <div className="flex items-start gap-4">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-white shrink-0">
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
              <TerminalBlock copy="npm install -g @pipeline-builder/pipeline-manager">
                <Command>npm install -g @pipeline-builder/pipeline-manager</Command>
              </TerminalBlock>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted mb-2">
                Or with pnpm
              </p>
              <TerminalBlock copy="pnpm add -g @pipeline-builder/pipeline-manager">
                <Command>pnpm add -g @pipeline-builder/pipeline-manager</Command>
              </TerminalBlock>
            </div>
          </div>
        </motion.div>

        {/* Quick start */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="card"
        >
          <h3 className="text-base font-semibold text-fg mb-4">Quick start</h3>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-info-bg text-xs font-bold text-info shrink-0 mt-0.5">
                1
              </span>
              <div className="flex-1">
                <p className="text-sm text-fg-muted">
                  Generate an API token from the{' '}
                  <Link href="/dashboard/security?tab=keys" className="action-link">Security → Access keys</Link> page.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-info-bg text-xs font-bold text-info shrink-0 mt-0.5">
                2
              </span>
              <div className="flex-1">
                <p className="text-sm text-fg-muted mb-1.5">Export the token in your shell:</p>
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
        </motion.div>

        {/* Prerequisites */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
          className="card"
        >
          <h3 className="text-base font-semibold text-fg mb-3">Prerequisites</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-fg-subtle" />
                <span className="text-sm font-medium text-fg">Node.js</span>
              </div>
              <p className="text-xs text-fg-muted">&gt;= 24.9</p>
            </div>
            <div className="rounded-lg border border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-fg-subtle" />
                <span className="text-sm font-medium text-fg">pnpm</span>
              </div>
              <p className="text-xs text-fg-muted">&gt;= 10.25</p>
            </div>
            <div className="rounded-lg border border-default p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-fg-subtle" />
                <span className="text-sm font-medium text-fg">Docker</span>
              </div>
              <p className="text-xs text-fg-muted">For plugin builds</p>
            </div>
          </div>
        </motion.div>

        {/* Links */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
          className="flex flex-wrap gap-3"
        >
          <LinkButton href="/dashboard/help" variant="secondary">
            <ExternalLink className="w-4 h-4" />
            CLI Reference
          </LinkButton>
          <LinkButton href="/dashboard/security?tab=keys" variant="secondary">
            <ExternalLink className="w-4 h-4" />
            Access keys
          </LinkButton>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
