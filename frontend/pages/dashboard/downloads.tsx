import { motion } from 'framer-motion';
import { Terminal, Package, Copy, Check, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';

function CopyInline({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="ml-2 inline-flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
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
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white shrink-0">
              <Terminal className="h-6 w-6" />
            </span>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Pipeline Manager CLI</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                The primary tool for managing plugins, pipelines, and deployments from the terminal.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                Install via npm
              </p>
              <div className="flex items-center rounded-lg bg-gray-900 dark:bg-gray-950 px-4 py-3">
                <code className="flex-1 text-sm font-mono text-green-400">
                  npm install -g @mwashburn160/pipeline-manager
                </code>
                <CopyInline text="npm install -g @mwashburn160/pipeline-manager" />
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                Or with pnpm
              </p>
              <div className="flex items-center rounded-lg bg-gray-900 dark:bg-gray-950 px-4 py-3">
                <code className="flex-1 text-sm font-mono text-green-400">
                  pnpm add -g @mwashburn160/pipeline-manager
                </code>
                <CopyInline text="pnpm add -g @mwashburn160/pipeline-manager" />
              </div>
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
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4">Quick Start</h3>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-xs font-bold text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
                1
              </span>
              <div className="flex-1">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  Generate an API token from the{' '}
                  <a href="/dashboard/tokens" className="action-link">API Tokens</a> page.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-xs font-bold text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
                2
              </span>
              <div className="flex-1">
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1.5">Export the token in your shell:</p>
                <div className="flex items-center rounded-lg bg-gray-900 dark:bg-gray-950 px-4 py-2.5">
                  <code className="flex-1 text-sm font-mono text-green-400">
                    export PLATFORM_TOKEN=&lt;your-token&gt;
                  </code>
                  <CopyInline text="export PLATFORM_TOKEN=<your-token>" />
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-xs font-bold text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
                3
              </span>
              <div className="flex-1">
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-1.5">Start using the CLI:</p>
                <div className="rounded-lg bg-gray-900 dark:bg-gray-950 px-4 py-2.5 space-y-1">
                  <code className="block text-sm font-mono text-green-400">pipeline-manager list-pipelines</code>
                  <code className="block text-sm font-mono text-green-400">pipeline-manager list-plugins</code>
                  <code className="block text-sm font-mono text-green-400">pipeline-manager deploy --id &lt;pipeline-id&gt;</code>
                </div>
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
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">Prerequisites</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Node.js</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">&gt;= 24.9</p>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">pnpm</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">&gt;= 10.25</p>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex items-center gap-2 mb-1">
                <Package className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Docker</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">For plugin builds</p>
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
          <a
            href="/dashboard/help"
            className="btn btn-secondary"
          >
            <ExternalLink className="w-4 h-4" />
            CLI Reference
          </a>
          <a
            href="/dashboard/tokens"
            className="btn btn-secondary"
          >
            <ExternalLink className="w-4 h-4" />
            API Tokens
          </a>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
