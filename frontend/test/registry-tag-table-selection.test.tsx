// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TagTable bulk selection must track the tags that still exist. After a bulk
 * (or single) delete the page re-reads the tag list; a selection that kept the
 * deleted refs left a "N selected · Delete selected" bar whose action re-sent
 * deletes for tags that are already gone.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagTable } from '../src/components/registry/TagTable';

function props(tags: string[] | null, onBulkDelete = jest.fn<AnyFn>()) {
  return {
    repo: 'org/app', tags, loading: false, error: null, selectedTag: null,
    onSelect: jest.fn<AnyFn>(), onCopy: jest.fn<AnyFn>(), onDelete: jest.fn<AnyFn>(),
    onBulkDelete, onRefresh: jest.fn<AnyFn>(), canCopy: true, canPurge: true,
  };
}

describe('TagTable selection', () => {
  it('drops selected tags that are no longer in the list after a refresh', () => {
    const onBulkDelete = jest.fn<AnyFn>();
    const { rerender } = render(<TagTable {...props(['v1', 'v2', 'v3'], onBulkDelete)} />);
    fireEvent.click(screen.getByLabelText('Select v1'));
    fireEvent.click(screen.getByLabelText('Select v2'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    // v1 and v2 were deleted; the re-read list no longer has them.
    rerender(<TagTable {...props(['v3'], onBulkDelete)} />);
    expect(screen.queryByText(/^\d+ selected$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete selected/i })).not.toBeInTheDocument();
  });

  it('keeps the surviving part of a selection and acts only on it', () => {
    const onBulkDelete = jest.fn<AnyFn>();
    const { rerender } = render(<TagTable {...props(['v1', 'v2', 'v3'], onBulkDelete)} />);
    fireEvent.click(screen.getByLabelText('Select v1'));
    fireEvent.click(screen.getByLabelText('Select v3'));

    rerender(<TagTable {...props(['v2', 'v3'], onBulkDelete)} />);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(onBulkDelete).toHaveBeenCalledWith(['v3']);
  });

  it('keeps the selection while the list is reloading (tags not yet known)', () => {
    const { rerender } = render(<TagTable {...props(['v1', 'v2'])} />);
    fireEvent.click(screen.getByLabelText('Select v1'));
    rerender(<TagTable {...props(null)} />);
    rerender(<TagTable {...props(['v1', 'v2'])} />);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});
