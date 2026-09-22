// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AdvisoryView } from '@/types/ecosystem';

/** One advisory's facts (shared with the console's list). */
export function AdvisoryFacts({ advisory: a }: { advisory: AdvisoryView }) {
  return (
    <div className="space-y-1 text-xs text-fg-muted">
      <p>
        Affects <code className="font-mono text-fg">{a.affectedRange}</code>
        {' · '}
        {a.fixedVersion ? <>fixed in <code className="font-mono text-fg">{a.fixedVersion}</code></> : 'no fix yet'}
        {a.affectedVersions.length > 0 && <> · covers {a.affectedVersions.map((v) => `v${v}`).join(', ')}</>}
      </p>
      {a.cveIds.length > 0 && <p className="font-mono">{a.cveIds.join(', ')}</p>}
    </div>
  );
}
