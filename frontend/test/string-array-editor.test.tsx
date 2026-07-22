// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for StringArrayEditor — the generic dynamic string-list editor.
 *
 * Contract: rows are keyed by a stable, client-generated id (not the array
 * index), so a mid-list removal preserves the DOM identity of the rows that
 * survive. This is a UI-identity guarantee (focus/value don't jump); the
 * serialized value handed to onChange is unchanged — no id ever leaks into it.
 */

import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StringArrayEditor from '../src/components/pipeline/editors/StringArrayEditor';

/** Controlled harness so the editor behaves as it does in a real form. */
function Harness({ initial, onChangeSpy }: { initial: string[]; onChangeSpy?: (v: string[]) => void }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <StringArrayEditor
      value={value}
      onChange={(v) => { onChangeSpy?.(v); setValue(v); }}
      addLabel="+ Add"
    />
  );
}

describe('StringArrayEditor', () => {
  it('renders one input per array item with the correct values', () => {
    render(<Harness initial={['a', 'b', 'c']} />);
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['a', 'b', 'c']);
  });

  it('keeps surviving rows at the same DOM node on a mid-list removal (stable key)', () => {
    render(<Harness initial={['a', 'b', 'c']} />);

    // Capture the node that renders the LAST item — the one an index key would
    // reassign/unmount when a middle row is removed.
    const cNodeBefore = (screen.getAllByRole('textbox') as HTMLInputElement[])[2];
    expect(cNodeBefore.value).toBe('c');

    // Remove the middle row ('b').
    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeButtons[1]);

    const inputsAfter = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(inputsAfter.map((i) => i.value)).toEqual(['a', 'c']);

    // With a stable id key, 'c' is still the very same DOM element.
    // With an index key it would have been remounted onto row 1's old node.
    expect(inputsAfter[1]).toBe(cNodeBefore);
  });

  it('hands onChange a plain string[] with no injected id fields', () => {
    const onChangeSpy = jest.fn();
    render(<Harness initial={['x', 'y']} onChangeSpy={onChangeSpy} />);

    fireEvent.click(screen.getByRole('button', { name: /\+ add/i }));
    expect(onChangeSpy).toHaveBeenLastCalledWith(['x', 'y', '']);

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: 'x2' } });
    expect(onChangeSpy).toHaveBeenLastCalledWith(['x2', 'y', '']);

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeButtons[0]);
    // Serialized output is a bare string array — every emitted payload is.
    for (const call of onChangeSpy.mock.calls) {
      const arg = call[0];
      expect(Array.isArray(arg)).toBe(true);
      for (const el of arg) expect(typeof el).toBe('string');
    }
  });
});
