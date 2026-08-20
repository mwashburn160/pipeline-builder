// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen, fireEvent } from '@testing-library/react';
import VarsEditor from '../src/components/pipeline/editors/VarsEditor';
import type { MetadataEntry } from '../src/types/form-types';

describe('VarsEditor', () => {
  it('renders an existing var entry with its key + value visible and editable', () => {
    const onChange = jest.fn();
    render(
      <VarsEditor
        value={[{ key: 'orgId', value: 'REPLACE_WITH_YOUR_ORG_ID', type: 'string' }]}
        onChange={onChange}
      />,
    );
    // Free-form key input shows the var name (no metadata-key combobox).
    expect(screen.getByDisplayValue('orgId')).toBeInTheDocument();
    expect(screen.getByDisplayValue('REPLACE_WITH_YOUR_ORG_ID')).toBeInTheDocument();

    // Editing the value fires onChange with the updated entry.
    fireEvent.change(screen.getByDisplayValue('REPLACE_WITH_YOUR_ORG_ID'), { target: { value: 'org-123' } });
    expect(onChange).toHaveBeenCalledWith([{ key: 'orgId', value: 'org-123', type: 'string' }]);
  });

  it('adds a new empty entry via "Add Variable"', () => {
    const onChange = jest.fn();
    render(<VarsEditor value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /add variable/i }));
    expect(onChange).toHaveBeenCalledWith([{ key: '', value: '', type: 'string' }]);
  });

  it('removes an entry', () => {
    const onChange = jest.fn();
    const rows: MetadataEntry[] = [
      { key: 'a', value: '1', type: 'string' },
      { key: 'b', value: '2', type: 'string' },
    ];
    render(<VarsEditor value={rows} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    expect(onChange).toHaveBeenCalledWith([{ key: 'b', value: '2', type: 'string' }]);
  });

  it('coerces the value to a boolean when the type switches to boolean', () => {
    const onChange = jest.fn();
    render(<VarsEditor value={[{ key: 'flag', value: 'xyz', type: 'string' }]} onChange={onChange} />);
    fireEvent.change(screen.getAllByRole('combobox').slice(-1)[0], { target: { value: 'boolean' } });
    expect(onChange).toHaveBeenCalledWith([{ key: 'flag', value: 'false', type: 'boolean' }]);
  });
});
