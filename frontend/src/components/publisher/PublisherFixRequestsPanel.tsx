// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';

/**
 * Publisher → Fix requests. When nightly CVE remediation finds fixable findings
 * it targets (the deployment's PLUGIN_REMEDIATION_SEVERITIES, Critical by
 * default, plus any known exploited one) in a listed version it may not change (a listed plugin is
 * its publisher's), it sends the publisher a fix request (N40) listing each
 * package, CVE, fixed version and the suggested patch. Those requests are
 * delivered as notices only — there is no stored list or read route — so this
 * tab points at the inbox where they arrive rather than inventing one.
 */
export function PublisherFixRequestsPanel() {
  return (
    <SectionCard
      icon={Wrench}
      title="Fix requests"
      description="Fixable findings the platform found in your listed versions at the severities its security fixes target (Critical by default), and any known exploited one. Publish a fixed version to clear them."
    >
      <p className="text-sm text-fg" data-testid="fix-requests-notice">
        Fix requests arrive as notices to members who manage this publisher, with each package, CVE, fixed version and the
        suggested patch. Installers are told a request was sent and move once you publish a fixed version through a normal
        new-version request.
      </p>
      <p className="mt-2 text-sm">
        <Link href="/dashboard/inbox?tab=messages" className="text-brand underline">Open your notices</Link>
      </p>
    </SectionCard>
  );
}
