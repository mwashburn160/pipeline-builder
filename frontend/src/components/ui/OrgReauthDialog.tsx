// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Timer } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from './Button';
import { Modal } from './Modal';

interface Props {
  /** The organization the person tried to switch into. */
  orgName: string;
  /** The organization they are still in. */
  currentOrgName?: string;
  onClose: () => void;
}

/**
 * What the org switcher shows when `switch-org` answers 403
 * `SESSION_POLICY_REAUTH_REQUIRED`: the session is fine where it is, but older
 * (or idler) than the destination org's session policy allows.
 *
 * Refreshing cannot cure it, so the only way in is a fresh sign-in — offered,
 * never forced: the person stays in their current organization until they
 * choose to sign in again (and may well want to finish something first).
 */
export function OrgReauthDialog({ orgName, currentOrgName, onClose }: Props) {
  const { logout } = useAuth();
  return (
    <Modal
      title="Sign in again to switch"
      titleIcon={<Timer className="h-5 w-5 text-warning shrink-0" />}
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          <strong>{orgName}</strong> requires a recent sign-in, and your current session is older than its session
          policy allows. Sign in again, then switch to it.
        </p>
        <p className="text-xs text-fg-muted">
          {currentOrgName
            ? <>Until then you stay in <strong>{currentOrgName}</strong> — nothing has changed there.</>
            : 'Until then you stay in your current organization — nothing has changed there.'}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button type="button" variant="primary" onClick={() => { onClose(); void logout({ reason: 'org-reauth' }); }}>
            Sign in again
          </Button>
        </div>
      </div>
    </Modal>
  );
}
