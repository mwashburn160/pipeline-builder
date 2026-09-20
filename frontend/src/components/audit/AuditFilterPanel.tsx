// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Select } from '@/components/ui/Select';
import { FilterInput } from '@/components/ui/FilterInput';

/**
 * The audit log's field definitions, in the order the panel renders them.
 * Shared with the page so `useListPage` and this panel can't drift apart.
 *
 * `action` is missing on purpose: it's the FilterBar's primary search input.
 */
export const AUDIT_FILTER_KEYS = [
  'actorId', 'requestId', 'outcome', 'impersonatorId', 'targetId',
  'roleId', 'targetType', 'from', 'to', 'orgId', 'affectedOrgId',
] as const;

/** Target types `GET /audit` scopes on. */
const TARGET_TYPES = [
  'pipeline', 'plugin', 'user', 'organization', 'role',
  'invitation', 'policy', 'rule', 'dashboard',
] as const;

interface AuditFilterPanelProps {
  /** Current filter values, keyed as in {@link AUDIT_FILTER_KEYS}. */
  filters: Record<string, string>;
  /** Commits one field; the caller resets pagination. */
  onChange: (key: string, value: string) => void;
  /**
   * `orgId` / `affectedOrgId` are sysadmin-only scopes — the backend pins an
   * org admin to their own org, so they're never offered to one.
   */
  isSuperAdmin: boolean;
}

/**
 * The audit log's advanced filter grid. Lived inline on the page as a 12-field
 * block that repeated `setX(...); setOffset(0)` per field; the offset reset now
 * belongs to `useListPage`, so each field is a single `onChange` call.
 */
export function AuditFilterPanel({ filters, onChange, isSuperAdmin }: AuditFilterPanelProps) {
  const text = (key: string, placeholder: string, label: string) => (
    <FilterInput
      type="text"
      placeholder={placeholder}
      aria-label={label}
      value={filters[key] ?? ''}
      onChange={(e) => onChange(key, e.target.value)}
    />
  );

  return (
    <div id="audit-filter-panel" className="w-full grid grid-cols-1 md:grid-cols-3 gap-2">
      {text('actorId', 'Actor user id', 'Filter by actor user id')}
      {text('requestId', 'Request id (correlation)', 'Filter by request id')}
      <Select
        aria-label="Filter by outcome"
        value={filters.outcome ?? ''}
        onChange={(e) => onChange('outcome', e.target.value)}
        className="filter-input"
      >
        <option value="">All outcomes</option>
        <option value="success">Success</option>
        <option value="failure">Failure</option>
      </Select>
      {text('impersonatorId', 'Impersonator user id', 'Filter by impersonator user id')}
      {text('targetId', 'Target id', 'Filter by target id')}
      {text('roleId', 'Role id (events touching one role)', 'Filter by role id')}
      <Select
        aria-label="Filter by target type"
        value={filters.targetType ?? ''}
        onChange={(e) => onChange('targetType', e.target.value)}
        className="filter-input"
      >
        <option value="">Any target type</option>
        {TARGET_TYPES.map((t) => (
          <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
        ))}
      </Select>
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="shrink-0">From</span>
        <FilterInput
          type="date"
          aria-label="Filter events created on or after"
          value={filters.from ?? ''}
          max={filters.to || undefined}
          onChange={(e) => onChange('from', e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="shrink-0">To</span>
        <FilterInput
          type="date"
          aria-label="Filter events created on or before"
          value={filters.to ?? ''}
          min={filters.from || undefined}
          onChange={(e) => onChange('to', e.target.value)}
        />
      </label>
      {isSuperAdmin && (
        <>
          {text('orgId', 'Org id — events by its members (sysadmin)', 'Filter by org id')}
          {text('affectedOrgId', 'Affected org id (sysadmin filter)', 'Filter by affected org id')}
        </>
      )}
    </div>
  );
}
