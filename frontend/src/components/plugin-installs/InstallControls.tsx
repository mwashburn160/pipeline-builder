// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ArrowUpCircle, CheckCircle2, Clock, PauseCircle, ShieldOff, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { installActionState, VERSION_POLICY_LABELS } from '@/lib/plugin-installs';
import type { CatalogEntry, InstallUpgrade, InstallView } from '@/types/plugin-installs';
import { InstallPolicyDialog } from './InstallPolicyDialog';

type Confirm =
  | { kind: 'uninstall'; install: InstallView }
  | { kind: 'withdraw'; install: InstallView }
  | { kind: 'upgrade'; install: InstallView; upgrade: InstallUpgrade };

/**
 * The install affordances for one listing, from its catalog entry (§3.1 D16,
 * §3.2, §3.4): Install / Request install / Pending approval (withdraw) /
 * Uninstall / Upgrade / "Installed automatically (Official)" with "Pin or
 * change policy", and the blocked and paused states with their reason.
 *
 * Shared by the public plugin page (signed in) and the in-app catalog. Holds no
 * toast dependency — the public page renders outside the dashboard shell — and
 * reports outcomes inline; `onChanged` lets the owner re-read the entry.
 */
export function InstallControls({
  entry, canInstall, align = 'start', onChanged,
}: {
  entry: CatalogEntry;
  /** Holds `plugins:install`. */
  canInstall: boolean;
  align?: 'start' | 'end';
  onChanged: () => void;
}) {
  const state = installActionState(entry);
  const { listing } = entry;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [policyDialog, setPolicyDialog] = useState<'pin' | 'change' | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      onChanged();
    } catch (e) {
      setError(formatError(e, 'The install action failed'));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const install = () => run(async () => {
    const res = await api.createPluginInstall({ publisher: listing.publisherHandle, name: listing.name });
    return res.data?.install.status === 'pending_approval'
      ? 'Install requested. An approver in your organization has been notified.'
      : 'Installed.';
  });

  const uninstall = (target: InstallView) => run(async () => {
    const res = await api.deletePluginInstall(target.id as string);
    return res.data?.implicitFallback
      ? 'Uninstalled. As an Official plugin it keeps resolving through the automatic install.'
      : 'Uninstalled.';
  });

  const withdraw = (target: InstallView) => run(async () => {
    await api.deletePluginInstall(target.id as string);
    return target.status === 'denied' ? 'Request removed.' : 'Install request withdrawn.';
  });

  const upgrade = (target: InstallView, u: InstallUpgrade) => run(async () => {
    await api.updatePluginInstall(target.id as string, { version: u.version });
    return `Upgraded to ${u.version}.`;
  });

  const wrap = align === 'end' ? 'items-start sm:items-end' : 'items-start';
  const install_ = 'install' in state ? state.install : null;

  return (
    <div className={`flex flex-col gap-2 ${wrap}`} data-testid="install-controls" data-state={state.kind}>
      {state.kind === 'install' && (
        canInstall ? (
          <Button onClick={() => void install()} loading={busy}>
            {state.requiresApproval ? 'Request install' : 'Install'}
          </Button>
        ) : (
          <p className="text-xs text-fg-subtle">Ask someone with the Install plugins permission to install it.</p>
        )
      )}
      {state.kind === 'install' && state.requiresApproval && canInstall && (
        <p className="text-xs text-fg-subtle">Your organization requires approval for this publisher tier.</p>
      )}

      {state.kind === 'implicit' && (
        <>
          <StatusLine icon={CheckCircle2} tone="success">
            Installed automatically (Official){state.install.resolvedVersion ? ` · v${state.install.resolvedVersion}` : ''}
          </StatusLine>
          {canInstall && (
            <Button variant="secondary" size="sm" onClick={() => setPolicyDialog('pin')} disabled={busy}>
              Pin or change policy
            </Button>
          )}
        </>
      )}

      {state.kind === 'installed' && (
        <>
          <StatusLine icon={CheckCircle2} tone="success">
            Installed{state.install.resolvedVersion ? ` · v${state.install.resolvedVersion}` : ''} · {VERSION_POLICY_LABELS[state.install.versionPolicy]}
            {state.install.inherited ? ' · from your root organization' : ''}
          </StatusLine>
          {canInstall && !state.install.inherited && (
            <div className="flex flex-wrap gap-2">
              {state.install.upgrade && (
                <Button size="sm" onClick={() => setConfirm({ kind: 'upgrade', install: state.install, upgrade: state.install.upgrade! })} disabled={busy}>
                  <ArrowUpCircle className="mr-1 h-4 w-4" aria-hidden="true" />
                  Upgrade to {state.install.upgrade.version}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => setPolicyDialog('change')} disabled={busy}>Change policy</Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: 'uninstall', install: state.install })} disabled={busy}>Uninstall</Button>
            </div>
          )}
        </>
      )}

      {state.kind === 'pending' && (
        <>
          <StatusLine icon={Clock} tone="warning">Pending approval</StatusLine>
          {canInstall && !state.install.inherited && (
            <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: 'withdraw', install: state.install })} disabled={busy}>
              Withdraw request
            </Button>
          )}
        </>
      )}

      {state.kind === 'denied' && (
        <>
          <StatusLine icon={XCircle} tone="danger">Install request denied</StatusLine>
          {canInstall && !state.install.inherited && (
            <Button variant="secondary" size="sm" onClick={() => void withdraw(state.install)} loading={busy}>Remove request</Button>
          )}
        </>
      )}

      {state.kind === 'blocked' && (
        <StatusLine icon={ShieldOff} tone="danger">{state.blocked.message}</StatusLine>
      )}
      {install_ && entry.blocked && (
        <StatusLine icon={ShieldOff} tone="danger">{entry.blocked.message}</StatusLine>
      )}
      {state.kind === 'paused' && (
        <StatusLine icon={PauseCircle} tone="warning">Paused by the publisher: no new installs for now.</StatusLine>
      )}
      {state.kind === 'unavailable' && (
        <p className="text-xs text-fg-subtle">Not available to install.</p>
      )}

      {notice && <p role="status" className="text-xs text-success-strong">{notice}</p>}
      {error && <p role="alert" className="max-w-xs text-xs text-danger-strong">{error}</p>}

      {confirm?.kind === 'uninstall' && (
        <ConfirmDialog
          title={`Uninstall ${listing.name}?`}
          tone="danger"
          confirmLabel="Uninstall"
          loading={busy}
          onConfirm={() => void uninstall(confirm.install)}
          onCancel={() => setConfirm(null)}
        >
          {listing.publisherTier === 'official'
            ? 'Pipelines keep resolving it through the automatic Official install (unless your policy requires explicit Official installs).'
            : 'Pipelines that reference it will fail to synth until it is installed again.'}
        </ConfirmDialog>
      )}
      {confirm?.kind === 'withdraw' && (
        <ConfirmDialog
          title="Withdraw the install request?"
          confirmLabel="Withdraw"
          loading={busy}
          onConfirm={() => void withdraw(confirm.install)}
          onCancel={() => setConfirm(null)}
        >
          The request is removed and approvers no longer see it.
        </ConfirmDialog>
      )}
      {confirm?.kind === 'upgrade' && (
        <ConfirmDialog
          title={`Upgrade ${listing.name} to ${confirm.upgrade.version}?`}
          confirmLabel="Upgrade"
          loading={busy}
          onConfirm={() => void upgrade(confirm.install, confirm.upgrade)}
          onCancel={() => setConfirm(null)}
        >
          <UpgradeDetails upgrade={confirm.upgrade} />
        </ConfirmDialog>
      )}

      {policyDialog && (
        <InstallPolicyDialog
          publisher={listing.publisherHandle}
          name={listing.name}
          title={policyDialog === 'pin' ? `Pin ${listing.name}` : `Change the policy for ${listing.name}`}
          submitLabel={policyDialog === 'pin' ? 'Create install' : 'Save'}
          initialPolicy={install_?.versionPolicy ?? 'minor'}
          initialVersion={policyDialog === 'change' ? install_?.pinnedVersion : install_?.resolvedVersion}
          onSubmit={async (body) => {
            if (policyDialog === 'pin' || !install_?.id) {
              await api.createPluginInstall({ publisher: listing.publisherHandle, name: listing.name, ...body });
              setNotice('Install created: this plugin now follows the policy you chose.');
            } else {
              await api.updatePluginInstall(install_.id, body);
              setNotice('Install policy saved.');
            }
            onChanged();
          }}
          onClose={() => setPolicyDialog(null)}
        />
      )}
    </div>
  );
}

const TONE: Record<'success' | 'warning' | 'danger', string> = {
  success: 'text-success-strong',
  warning: 'text-warning-strong',
  danger: 'text-danger-strong',
};

function StatusLine({ icon: Icon, tone, children }: { icon: typeof Clock; tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <p className={`flex max-w-xs items-start gap-1.5 text-sm ${TONE[tone]}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** The changelog and vulnerability delta of an upgrade (N13 notice content). */
export function UpgradeDetails({ upgrade }: { upgrade: InstallUpgrade }) {
  const { newCritical, newHigh } = upgrade.vulnDelta;
  return (
    <div className="space-y-2 text-sm">
      {upgrade.breaking && <p className="font-medium text-warning-strong">The publisher marked this version as breaking.</p>}
      {(newCritical > 0 || newHigh > 0) ? (
        <p className="text-danger-strong">It adds {newCritical} critical and {newHigh} high vulnerabilities.</p>
      ) : (
        <p className="text-fg-muted">No new critical or high vulnerabilities.</p>
      )}
      {upgrade.changelog && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 text-xs text-fg">{upgrade.changelog}</pre>
      )}
    </div>
  );
}
