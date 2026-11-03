// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId } from 'react';
import { Select } from '@/components/ui/Select';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';

interface CampaignSelectProps {
  /** The selected campaign slug, or `''` for none. */
  value: string;
  onChange: (campaign: string) => void;
  /** Label text; the field is always optional. */
  label?: string;
  disabled?: boolean;
}

/**
 * Pick the campaign a discount or promotion belongs to — a PICKER, not a text
 * box, because `campaign` is a reference the server validates.
 *
 * It used to be free text on both the mint and the promotion form, which was
 * fine while a campaign was a label: any string was accepted and a typo quietly
 * created a second campaign. Now an unknown name is refused, so a text box would
 * hand the author a 400 for a value they had no way to know was wrong — and it
 * would still not tell them which campaigns exist.
 *
 * Only OPEN campaigns are offered: a closed, ended or budget-exhausted campaign
 * accepts no redemptions, so minting a code into one produces a code that cannot
 * be used. The currently-selected value is always kept in the list even when it
 * is no longer open, so editing an existing record never silently re-points it.
 */
export function CampaignSelect({ value, onChange, label = 'Campaign', disabled }: CampaignSelectProps) {
  const uid = useId();
  const read = useFetch(
    async (signal) => {
      const res = await api.listCampaigns({ active: 'true', limit: 200 }, { signal });
      return res.data?.campaigns ?? [];
    },
    [],
  );

  const campaigns = read.data ?? [];
  const open = campaigns.filter((c) => c.open !== false);
  // Keep a selected-but-no-longer-open campaign visible rather than dropping it,
  // which would look like the field had been cleared.
  const options = open.some((c) => c.id === value) || !value
    ? open
    : [...open, ...campaigns.filter((c) => c.id === value)];

  return (
    <div>
      <label className="block text-xs font-medium text-fg-muted" htmlFor={`${uid}-campaign`}>
        {label} <span className="text-fg-subtle">(optional)</span>
      </label>
      <Select
        id={`${uid}-campaign`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || read.loading}
        className="mt-1"
      >
        <option value="">No campaign</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.id}){c.open === false ? ' — closed' : ''}
          </option>
        ))}
      </Select>
      {read.error && (
        <p className="mt-1 text-xs text-danger">Could not load campaigns — leave this blank, or retry.</p>
      )}
      {!read.loading && !read.error && campaigns.length === 0 && (
        <p className="mt-1 text-xs text-fg-subtle">
          No campaigns yet. Create one under Campaigns to group codes under a shared budget.
        </p>
      )}
      {value && (
        <p className="mt-1 text-xs text-fg-subtle">
          This code counts against the campaign&apos;s budget, window and one-per-account rule.
        </p>
      )}
    </div>
  );
}
