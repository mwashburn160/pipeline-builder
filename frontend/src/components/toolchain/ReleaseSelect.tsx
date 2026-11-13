// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId } from 'react';
import { Select } from '@/components/ui/Select';
import { RELEASE_STATUS_LABEL } from '@/lib/toolchain';
import type { ToolchainConsoleRelease } from '@/types/toolchain';

/** The release a per-release panel (Canary, Adoption, Affected) is looking at. */
export function ReleaseSelect({ releases, value, onChange }: {
  releases: ToolchainConsoleRelease[];
  value: string;
  onChange: (releaseVersion: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="font-medium text-fg">Release</label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="w-auto">
        {releases.map((r) => (
          <option key={r.releaseVersion} value={r.releaseVersion}>
            {r.releaseVersion} ({RELEASE_STATUS_LABEL[r.status]})
          </option>
        ))}
      </Select>
    </div>
  );
}
