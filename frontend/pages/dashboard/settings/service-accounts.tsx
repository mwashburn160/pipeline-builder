// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Organization SERVICE ACCOUNTS (#2) — org owner/admin self-service.
 *
 * Machine identities live here rather than on the personal keys page because
 * they belong to the ORG, not to whoever created them: they survive their
 * creator leaving, they take no seat, and only `service_accounts:manage` (which
 * superadmins hold implicitly) can change them. The backend independently
 * enforces the permission, the tenancy and a step-up on every write.
 *
 * The keys minted here also appear on the token-management page, in the same
 * list as personal access keys, labelled with their owning account.
 */

import { Bot } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Callout } from '@/components/ui/Callout';
import { ServiceAccountsSection } from '@/components/settings/ServiceAccountsSection';

export default function ServiceAccountsPage() {
  const { isReady, user, isReadOnly } = useAuthGuard({ requirePermission: 'service_accounts:manage' });

  if (!isReady || !user) return <LoadingPage />;

  const orgId = user.organizationId;

  return (
    <DashboardLayout
      title="Service accounts"
      subtitle="Machine identities for CI, automation and integrations"
      titleExtra={<Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />}
    >
      <div className="space-y-6">
        {!orgId ? (
          <Callout variant="danger">
            Could not determine your active organization. Try reloading the page.
          </Callout>
        ) : (
          <ServiceAccountsSection orgId={orgId} readOnly={isReadOnly} />
        )}
      </div>
    </DashboardLayout>
  );
}
