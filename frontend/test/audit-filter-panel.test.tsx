// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The audit log's advanced filter grid, extracted from the page. Every field
 * used to repeat `setX(...); setOffset(0)`; the offset reset now belongs to
 * `useListPage`, so each field is a single `onChange(key, value)`.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { AuditFilterPanel } from '../src/components/audit/AuditFilterPanel';

const noFilters: Record<string, string> = {};

describe('AuditFilterPanel', () => {
  it('reports a text edit as one keyed change', () => {
    const onChange = jest.fn();
    render(<AuditFilterPanel filters={noFilters} onChange={onChange} isSuperAdmin={false} />);
    fireEvent.change(screen.getByLabelText(/filter by actor user id/i), { target: { value: 'u-1' } });
    expect(onChange).toHaveBeenCalledWith('actorId', 'u-1');
  });

  it('reports a select change the same way', () => {
    const onChange = jest.fn();
    render(<AuditFilterPanel filters={noFilters} onChange={onChange} isSuperAdmin={false} />);
    fireEvent.change(screen.getByLabelText(/filter by outcome/i), { target: { value: 'failure' } });
    expect(onChange).toHaveBeenCalledWith('outcome', 'failure');
  });

  it('offers the sysadmin-only org scopes only to a sysadmin', () => {
    const { rerender } = render(<AuditFilterPanel filters={noFilters} onChange={() => {}} isSuperAdmin={false} />);
    expect(screen.queryByLabelText(/filter by org id/i)).not.toBeInTheDocument();

    rerender(<AuditFilterPanel filters={noFilters} onChange={() => {}} isSuperAdmin />);
    expect(screen.getByLabelText(/filter by org id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter by affected org id/i)).toBeInTheDocument();
  });

  it('bounds each date input by the other so the range cannot invert', () => {
    render(<AuditFilterPanel filters={{ from: '2026-01-01', to: '2026-02-01' }} onChange={() => {}} isSuperAdmin={false} />);
    expect(screen.getByLabelText(/created on or after/i)).toHaveAttribute('max', '2026-02-01');
    expect(screen.getByLabelText(/created on or before/i)).toHaveAttribute('min', '2026-01-01');
  });

  it('renders current values, treating a missing key as empty', () => {
    render(<AuditFilterPanel filters={{ roleId: 'role-9' }} onChange={() => {}} isSuperAdmin={false} />);
    expect(screen.getByLabelText(/filter by role id/i)).toHaveValue('role-9');
    expect(screen.getByLabelText(/filter by target id/i)).toHaveValue('');
  });
});
