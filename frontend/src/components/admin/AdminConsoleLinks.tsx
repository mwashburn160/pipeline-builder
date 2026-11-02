// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ExternalLink, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { MfaRequiredDialog } from '@/components/ui/MfaRequiredDialog';
import { useFeatures } from '@/hooks/useFeatures';
import { readSessionAssurance } from '@/hooks/useSessionAssurance';
import api from '@/lib/api';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { adminConsolesAvailable, consoleAccess, consolesAreGated, setAdminConsoleCookie, visibleConsoles, type AdminConsole } from '@/lib/admin-console';
import type { User } from '@/types';

/**
 * All five operator consoles, for whoever holds the permission each one needs,
 * on every target that serves them.
 *
 * TWO things vary by target and both are handled here rather than hidden:
 *
 *  1. **How it is reached.** Four are a path on this same origin. The RustFS
 *     console is a whole nginx `server` on :9001 (its UI calls ROOT paths, so it
 *     cannot live under a sub-path), and whether that port is reachable from a
 *     browser depends on the target — ec2 and docker publish it, eks and
 *     minikube need a `kubectl port-forward`. `consoleAccess` answers which, and
 *     a console that needs a command gets the command instead of an Open button
 *     that would fail with a connection error.
 *  2. **Whether they are served at all.** `ADMIN_CONSOLES_ENABLED=false` makes
 *     the AWS gateways answer a 404 stub for all five, so the card renders
 *     nothing rather than five dead tiles.
 *  3. **Whether the gateway gates.** Only the AWS trees run the `auth_request`
 *     to `/admin/console-check`. Opening a console there sets the
 *     `pb_admin_console` cookie to the current access token and needs an
 *     MFA-grade session, because that is what the gate checks. On minikube and
 *     docker it checks nothing, so requiring a second factor in the UI would
 *     refuse a developer a console that is in fact wide open.
 */
export function AdminConsoleLinks({ user }: { user: Pick<User, 'isSuperAdmin' | 'mfaPolicy' | 'authFactors'> }) {
  const { deployTarget, adminConsolesEnabled } = useFeatures();
  const { can } = useAuthGuard();
  const [mfaPrompt, setMfaPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const consoles = visibleConsoles({
    deployTarget,
    isSuperAdmin: user.isSuperAdmin === true,
    canObservability: can('observability_console:open'),
    canDatabase: can('database_console:open'),
    canObjectStore: can('objectstore_console:open'),
  });
  // `adminConsolesEnabled` is the deploy switch (`ADMIN_CONSOLES_ENABLED`). With
  // it off the AWS gateways serve a 404 stub, so the card must not offer five
  // tiles that each dead-end — it reports through /config for exactly this.
  if (!adminConsolesEnabled || consoles.length === 0 || !adminConsolesAvailable(deployTarget)) return null;
  const gated = consolesAreGated(deployTarget);

  const open = (console_: AdminConsole, href: string) => {
    setError(null);
    // Ungated target: no cookie to mint and nothing to be MFA-grade for. Open it.
    if (!gated) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    if (readSessionAssurance(user) < 2) {
      setMfaPrompt(true);
      return;
    }
    // Open synchronously (so no pop-up blocker intervenes), then point it at the
    // console once the cookie is written for a token with time left on it.
    const win = window.open('about:blank', '_blank');
    void (async () => {
      try {
        await api.ensureFreshToken();
        const token = api.getAccessToken();
        if (!token || !setAdminConsoleCookie(token)) throw new Error('Your session has no usable access token — sign in again.');
        if (win) {
          win.opener = null;
          win.location.href = href;
        } else {
          window.location.href = href;
        }
      } catch (e) {
        win?.close();
        setError(e instanceof Error ? e.message : 'Could not open the console');
      }
    })();
  };

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Wrench className="h-4 w-4 text-brand" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">Operator consoles</h2>
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        Direct access to the datastores, the object store and every tenant&apos;s telemetry. Each console needs its own
        permission.{' '}
        {gated
          ? 'The gateway checks it, plus the system org and a second factor, on every request.'
          : 'On this target the gateway checks nothing — reaching it already means local access.'}
      </p>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Operator consoles">
        {consoles.map((c) => {
          const access = consoleAccess(c, deployTarget);
          return (
            <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-default p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{c.label}</p>
                <p className="text-xs text-fg-muted">{c.description}</p>
                {access.kind === 'port-forward' && (
                  <p className="mt-1.5 text-xs text-fg-subtle">
                    Not published on this target. Run{' '}
                    <code className="break-all">{access.command}</code>, then {access.note.replace(/^Then o/, 'o')}.
                  </p>
                )}
              </div>
              {access.kind === 'link' && (
                <Button size="sm" variant="secondary" onClick={() => open(c, access.href)} aria-label={`Open ${c.label}`} className="gap-1">
                  Open <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {mfaPrompt && (
        <MfaRequiredDialog
          code="MFA_REQUIRED"
          message="The operator consoles need a session opened with a second factor (a passkey or an authenticator app)."
          onClose={() => setMfaPrompt(false)}
        />
      )}
    </Card>
  );
}
