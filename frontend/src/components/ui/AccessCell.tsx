// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { visibilityRung } from './visibility-rungs';

/** Per-rung emphasis: the narrower the rung, the more legible — `public` is the
 *  common case and stays muted, so the eye catches rows that are restricted. */
const TONE: Record<string, string> = {
  private: 'font-medium text-gray-700 dark:text-gray-300',
  org: 'text-gray-600 dark:text-gray-400',
  public: 'text-gray-400 dark:text-gray-500',
};

/**
 * Visibility table cell — renders all three rungs (private / org / public) with
 * the shared ladder labels and icons. Shared by the pipelines/plugins tables.
 */
export function AccessCell({ visibility }: { visibility: string }) {
  const rung = visibilityRung(visibility);
  if (!rung) return <span className="text-xs text-gray-400 dark:text-gray-500">{visibility}</span>;
  const { Icon, label, meaning } = rung;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${TONE[rung.value]}`} title={`${label} — ${meaning}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />{label}
    </span>
  );
}
