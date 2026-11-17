// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stacked overlays (a dirty Modal's "Discard changes?" confirm, the global
 * step-up dialog over an open Modal) each listen for Tab on `document`. Only
 * the TOP one may trap it: the one beneath used to see focus "outside" itself
 * (the top dialog is portaled elsewhere), pull it to its own first control, and
 * the top trap pulled it straight back to ITS first control — so a keyboard
 * user could never get past the top dialog's first button.
 */

import { describe, it, expect } from '@jest/globals';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from '../src/components/ui/Modal';

function Stacked() {
  const [inner, setInner] = useState(false);
  return (
    <Modal title="Outer" onClose={() => {}}>
      <button type="button" onClick={() => setInner(true)}>open inner</button>
      {inner && (
        <Modal title="Inner" onClose={() => setInner(false)}>
          <button type="button">inner one</button>
          <button type="button">inner two</button>
        </Modal>
      )}
    </Modal>
  );
}

describe('stacked dialogs — Tab trap', () => {
  it('lets Tab move normally inside the top dialog', () => {
    render(<Stacked />);
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }));
    const one = screen.getByRole('button', { name: 'inner one' });
    one.focus();

    // Not at a boundary: neither trap may intervene, so the browser moves focus on.
    const notPrevented = fireEvent.keyDown(one, { key: 'Tab' });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(one);
  });

  it('still wraps at the top dialog\'s last control', () => {
    render(<Stacked />);
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }));
    const two = screen.getByRole('button', { name: 'inner two' });
    two.focus();

    expect(fireEvent.keyDown(two, { key: 'Tab' })).toBe(false);
    const innerDialog = screen.getByRole('dialog', { name: 'Inner' });
    expect(innerDialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(two);
  });

  it('hands the trap back to the dialog beneath once the top one closes', () => {
    render(<Stacked />);
    fireEvent.click(screen.getByRole('button', { name: 'open inner' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'inner one' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Inner' })).not.toBeInTheDocument();

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Outer' }).contains(document.activeElement)).toBe(true);
    outside.remove();
  });
});
