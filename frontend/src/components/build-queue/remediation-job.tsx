// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { PLUGIN_REMEDIATION_JOB_NAME } from '@pipeline-builder/api-core/plugin-scan';
import { Badge } from '@/components/ui/Badge';
import { remediationHref } from '@/lib/plugin-remediation';

/** The BullMQ job-id prefix of a remediation build (`pluginRemediationJobId`). */
const REMEDIATION_JOB_ID_PREFIX = 'remediation-';

/**
 * Whether a build-queue job is a nightly remediation build, and which
 * remediation it belongs to. Recognised from the job id the remediation job is
 * queued under (`remediation-<id>`), or from a `name` / `kind` the listing may
 * carry. The id is only known from the job id.
 */
export function remediationJobOf(job: { id?: string | number; name?: string; kind?: string }): { remediationId: string | null } | null {
  const id = job.id == null ? '' : String(job.id);
  if (id.startsWith(REMEDIATION_JOB_ID_PREFIX) && id.length > REMEDIATION_JOB_ID_PREFIX.length) {
    return { remediationId: id.slice(REMEDIATION_JOB_ID_PREFIX.length) };
  }
  if (job.name === PLUGIN_REMEDIATION_JOB_NAME || job.kind === PLUGIN_REMEDIATION_JOB_NAME) return { remediationId: null };
  return null;
}

/**
 * The "Remediation · No build credits" mark on a remediation build: those
 * builds spend no credits (like system-org builds) but count toward the org's
 * daily remediation cap. Links to the remediation card when the id is known.
 */
export function RemediationJobLabel({ remediationId }: { remediationId: string | null }) {
  const badge = <Badge color="indigo">Remediation</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {remediationId
        ? <Link href={remediationHref(remediationId)} title="Open the remediation">{badge}</Link>
        : badge}
      <span className="text-xs text-fg-muted" title="Remediation builds spend no build credits; they count toward the daily remediation cap.">
        No build credits
      </span>
    </span>
  );
}
