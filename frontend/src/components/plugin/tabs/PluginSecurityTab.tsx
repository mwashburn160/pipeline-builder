// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugins page's Security tab: the panel of its selected sub-tab —
 * vulnerability search, remediations, the consumption policy, and (for an
 * approver) install approvals.
 */

import { ApprovalsTab } from '@/components/plugin-installs/ApprovalsTab';
import { PolicyTab } from '@/components/plugin-installs/PolicyTab';
import { AdvisorySearchPanel } from '@/components/plugin/AdvisorySearchPanel';
import { RemediationsPanel } from '@/components/plugin/RemediationsPanel';
import type { PluginsSection } from '@/lib/page-tabs/plugins';

/** Sub-tabs of Security, in order. Approvals is an approver's surface (`plugin_installs:manage`). */
export const SECURITY_SECTIONS: readonly { id: PluginsSection; label: string }[] = [
  { id: 'vulnerabilities', label: 'Vulnerability search' },
  { id: 'remediations', label: 'Remediations' },
  { id: 'policy', label: 'Policy' },
  { id: 'approvals', label: 'Approvals' },
];

interface PluginSecurityTabProps {
  section: PluginsSection | null | undefined;
  canManageInstalls: boolean;
  canWrite: boolean;
  isSystemOrg: boolean;
  /** The remediation a deep link focuses (`?remediation=`). */
  focusRemediationId: string | undefined;
  onOpenPlugin: (id: string) => void | Promise<void>;
}

export function PluginSecurityTab({ section, canManageInstalls, canWrite, isSystemOrg, focusRemediationId, onOpenPlugin }: PluginSecurityTabProps) {
  return (
    <>
      {section === 'approvals' && canManageInstalls && <ApprovalsTab />}
      {section === 'policy' && <PolicyTab canManage={canManageInstalls} />}
      {section === 'vulnerabilities' && <AdvisorySearchPanel />}
      {section === 'remediations' && (
        <RemediationsPanel
          canWrite={canWrite}
          isSystemOrg={isSystemOrg}
          focusId={focusRemediationId}
          onOpenPlugin={onOpenPlugin}
        />
      )}
    </>
  );
}
