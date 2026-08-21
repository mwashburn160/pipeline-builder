// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { ShieldCheck, Lock, BookOpen } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useFeatures } from '@/hooks/useFeatures';
import { FEATURE_METADATA, type ComplianceSetFlag } from '@/lib/feature-flags';

/**
 * Curated compliance content sets, gated on the `compliance_standard` /
 * `compliance_advanced` add-on entitlements. Modeled on the DORA upsell
 * (`DoraUpsell`): a set the org HOLDS renders as an "included" card pointing at
 * the catalog below; a set it does NOT hold renders a locked teaser whose CTA
 * deep-links to the matching billing add-on (`?highlight=<feature>` — the same
 * key `AddonGrid` matches a bundle on via its `features[]`).
 *
 * The compliance page itself stays open to anyone with `compliance:read`; only
 * this curated-set section is gated. Subscribing to a set's system-org published
 * rules is separately server-enforced on the same feature flags.
 */

interface ContentSet {
  feature: ComplianceSetFlag;
  /** What the set covers, one bullet per line. */
  contents: string[];
  /**
   * Whether this set depends on `compliance_standard` (Advanced does). Used to
   * (a) render the "requires the Standard library" note ONLY when Standard is
   * not held, and (b) point the locked CTA at Standard first — buying Advanced
   * without Standard is billing-rejected (400), so we must not deep-link a user
   * straight to Advanced alone.
   */
  requiresStandard?: boolean;
}

const CONTENT_SETS: ContentSet[] = [
  {
    feature: 'compliance_standard',
    contents: [
      'Curated CI/CD best-practice rule library',
      'Plugin & pipeline hardening checks',
      'One-click subscribe + activate from the catalog',
    ],
  },
  {
    feature: 'compliance_advanced',
    contents: [
      'SOC 2 / PCI-DSS / CIS control libraries',
      'Rules grouped under their framework policy',
      'Each tagged with its framework control id',
    ],
    requiresStandard: true,
  },
];

function HeldCard({ set }: { set: ContentSet }) {
  const meta = FEATURE_METADATA[set.feature];
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-300">
            <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100">{meta.label}</h4>
        </div>
        <span className="text-xs font-medium rounded-full bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 whitespace-nowrap">
          Included
        </span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{meta.description}</p>
      <ul className="mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-400 flex-1">
        {set.contents.map((c) => (
          <li key={c} className="flex items-start gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-500" aria-hidden="true" />
            <span>{c}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <BookOpen className="w-3.5 h-3.5" aria-hidden="true" /> Browse and subscribe to these rules in the catalog below.
      </p>
    </Card>
  );
}

function LockedCard({ set, standardHeld }: { set: ContentSet; standardHeld: boolean }) {
  const meta = FEATURE_METADATA[set.feature];
  // Advanced depends on Standard: only surface the dependency note while the org
  // still lacks Standard, and route its unlock CTA to Standard first (buying
  // Advanced alone is billing-rejected). Once Standard is held, Advanced's CTA
  // targets Advanced directly and the note disappears.
  const gatedOnStandard = !!set.requiresStandard && !standardHeld;
  const note = gatedOnStandard ? 'Requires the Standard Compliance library.' : undefined;
  const highlight: ComplianceSetFlag = gatedOnStandard ? 'compliance_standard' : set.feature;
  return (
    <Card className="relative flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300">
            <Lock className="w-4 h-4" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100">{meta.label}</h4>
        </div>
        <span className="text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 px-2 py-0.5 whitespace-nowrap">
          Add-on
        </span>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{meta.description}</p>
      <ul className="mt-3 space-y-1 text-sm text-gray-500 dark:text-gray-500 flex-1">
        {set.contents.map((c) => (
          <li key={c} className="flex items-start gap-1.5">
            <Lock className="w-3 h-3 mt-1 shrink-0 text-gray-400" aria-hidden="true" />
            <span>{c}</span>
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{note}</p>}
      <Link
        href={`/dashboard/billing?highlight=${highlight}`}
        className="btn btn-primary btn-sm mt-4 self-start"
      >
        Unlock {meta.label}
      </Link>
    </Card>
  );
}

export default function ComplianceContentSets() {
  const { isEnabled } = useFeatures();
  const standardHeld = isEnabled('compliance_standard');
  return (
    <section aria-label="Curated compliance content sets" className="space-y-3">
      <div>
        <h3 className="text-base font-semibold text-gray-900 dark:text-white">Curated content sets</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Pre-built compliance rule libraries you can subscribe to. Authoring your own rules stays free.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {CONTENT_SETS.map((set) =>
          isEnabled(set.feature) ? <HeldCard key={set.feature} set={set} /> : <LockedCard key={set.feature} set={set} standardHeld={standardHeld} />,
        )}
      </div>
    </section>
  );
}
