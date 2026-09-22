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
import { ADMIN_CONSOLES, adminConsolesAvailable, setAdminConsoleCookie, type AdminConsole } from '@/lib/admin-console';
import type { User } from '@/types';

/**
 * The operator consoles (Grafana, Kiali, pgAdmin, mongo-express) for a platform
 * administrator, on the AWS targets whose gateway serves them.
 *
 * Opening one sets the `pb_admin_console` cookie to the current access token
 * (see lib/admin-console) — the gateway's `auth_request` reads it and checks
 * sysadmin + AAL2 with platform — and then opens the console. The session must
 * already be MFA-grade: a step-up cannot raise a session's assurance (the gate
 * reads the access token's own `aal`), so a single-factor session is told to
 * sign in again with its second factor instead of being sent to a 401.
 */
export function AdminConsoleLinks({ user }: { user: Pick<User, 'isSuperAdmin' | 'mfaPolicy' | 'authFactors'> }) {
  const { deployTarget } = useFeatures();
  const [mfaPrompt, setMfaPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user.isSuperAdmin || !adminConsolesAvailable(deployTarget)) return null;

  const open = (console_: AdminConsole) => {
    setError(null);
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
          win.location.href = console_.path;
        } else {
          window.location.href = console_.path;
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
        Direct access to the datastores and every tenant&apos;s telemetry. Requires a platform administrator session
        opened with a second factor; the gateway checks it on every request.
      </p>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Operator consoles">
        {ADMIN_CONSOLES.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-lg border border-default p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{c.label}</p>
              <p className="text-xs text-fg-muted">{c.description}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => open(c)} aria-label={`Open ${c.label}`} className="gap-1">
              Open <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </li>
        ))}
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
