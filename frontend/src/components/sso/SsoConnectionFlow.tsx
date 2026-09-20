// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { SsoSetupWizard, type WizardStep } from './SsoSetupWizard';
import { SsoStatusSummary } from './SsoStatusSummary';
import type { OrgIdpConfigDto } from '@/types';

/**
 * ONE organization's SSO connection, in whichever of its two shapes applies:
 * the six-step SETUP WIZARD while there is nothing configured (or while an
 * existing connection is being edited), and the STATUS SUMMARY otherwise —
 * with Edit / Resume / Change routing back into the wizard at the right step.
 *
 * Extracted because the org settings page and the TEAM settings drawer were two
 * different products for the same job: the page had the wizard, SP values,
 * metadata import, test connection and the "SSO required" switch, while a team
 * got the two protocol editors STACKED, no SP values, no test and no way to
 * require SSO. An admin who learned one could not use the other. Both now mount
 * this, handed the org id they administer — teams included, since every part
 * below takes `orgId` as a prop and none reads the active org from context.
 *
 * `config` is owned by the CALLER, because what sits around this (group → role
 * mappings, SCIM, Disconnect) describes the same record and must see a save
 * here immediately. Only the wizard step being edited is local.
 *
 * Every write inside keeps the IdP routes' strong step-up + assurance gate.
 */
export function SsoConnectionFlow({
  orgId,
  config,
  readOnly,
  onConfigChange,
}: {
  orgId: string;
  config: OrgIdpConfigDto | null;
  readOnly: boolean;
  /** The connection after a save — the caller re-renders everything around it. */
  onConfigChange: (config: OrgIdpConfigDto) => void;
}) {
  const [editing, setEditing] = useState<WizardStep | null>(null);
  // A disconnect clears the caller's config while `editing` may still name a
  // step that only exists for a saved connection (4-6 render nothing without
  // one). Deriving it keeps the wizard at step 1 for the re-setup instead of on
  // a blank step; the state itself is harmless once a save re-fills `config`.
  const step = config ? editing : null;

  if (!config || step !== null) {
    return (
      <SsoSetupWizard
        // Remount per entry point so the wizard opens at the chosen step.
        key={`${step ?? 'new'}`}
        orgId={orgId}
        config={config}
        readOnly={readOnly}
        initialStep={step ?? 1}
        onSaved={(saved) => {
          // The first save creates the connection: stay in the wizard (now at
          // the domains step) instead of dropping to the summary.
          if (!config) setEditing(4);
          onConfigChange(saved);
        }}
        onDone={config ? () => setEditing(null) : undefined}
      />
    );
  }

  return (
    <SsoStatusSummary
      orgId={orgId}
      config={config}
      readOnly={readOnly}
      onSaved={onConfigChange}
      onEdit={setEditing}
    />
  );
}
