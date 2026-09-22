// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BadgeCheck, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { TRUST_TIER_LABELS, type TrustTier } from '@/lib/public-directory/types';

const STYLE: Record<TrustTier, { cls: string; Icon: typeof BadgeCheck; hint: string }> = {
  official: {
    cls: 'bg-info-bg text-info-strong border-info-border',
    Icon: BadgeCheck,
    hint: 'Built, signed and maintained by the Pipeline Builder team.',
  },
  verified: {
    cls: 'bg-success-bg text-success-strong border-success-border',
    Icon: ShieldCheck,
    hint: 'Published by an organization whose identity has been verified.',
  },
  community: {
    cls: 'bg-surface-muted text-fg-muted border-default',
    Icon: Users,
    hint: 'Published by a community member. Review it before use.',
  },
  unverified: {
    cls: 'bg-warning-bg text-warning-strong border-warning-border',
    Icon: ShieldAlert,
    hint: 'The publisher has not been verified. Review it carefully before use.',
  },
};

/** The trust tier of a listing's publisher. `compact` drops the label to an icon (kept for screen readers). */
export function TrustTierBadge({ tier, compact = false }: { tier: TrustTier; compact?: boolean }) {
  const s = STYLE[tier] ?? STYLE.unverified;
  const label = TRUST_TIER_LABELS[tier] ?? TRUST_TIER_LABELS.unverified;
  return (
    <span
      title={s.hint}
      data-tier={tier}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${s.cls}`}
    >
      <s.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
