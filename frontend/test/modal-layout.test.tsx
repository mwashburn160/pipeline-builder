// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A dialog's footer is always reachable, whatever its height.
 *
 *  - Below `sm`: a full-height sheet — header pinned at the top, footer at the
 *    bottom, and only the body scrolls.
 *  - From `sm` up: EVERY dialog (not only `tall` ones) is capped to the
 *    viewport and scrolls its body, so the footer of a long form stays on
 *    screen. A non-`tall` dialog used to grow past a 720px window with its
 *    footer — the Send/Save button — below the fold and no way to scroll to it.
 *
 * jsdom does no layout, so the contract is pinned on the classes that produce it.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { Modal } from '../src/components/ui/Modal';

const classesOf = (el: Element) => el.className.split(/\s+/);

function renderModal(tall?: boolean) {
  render(
    <Modal title="Send invitation" onClose={() => undefined} tall={tall} footer={<button type="button">Send</button>}>
      <p>body copy</p>
    </Modal>,
  );
  const panel = screen.getByRole('dialog', { name: 'Send invitation' });
  const body = screen.getByText('body copy').parentElement!;
  const footer = screen.getByRole('button', { name: 'Send' }).parentElement!;
  return { panel, body, footer };
}

describe('Modal layout', () => {
  it.each([[false], [true]])('tall=%s: caps the panel to the viewport and scrolls only the body, from sm up', (tall) => {
    const { panel, body, footer } = renderModal(tall);
    expect(classesOf(panel)).toEqual(expect.arrayContaining(['sm:flex', 'sm:flex-col']));
    expect(classesOf(panel).some((c) => /^sm:max-h-/.test(c))).toBe(true);
    expect(classesOf(body)).toEqual(expect.arrayContaining(['sm:flex-1', 'sm:min-h-0', 'sm:overflow-y-auto']));
    expect(classesOf(footer)).toContain('shrink-0');
  });

  it('is a full-height sheet below sm, with a pinned footer', () => {
    const { panel, body, footer } = renderModal();
    expect(classesOf(panel)).toEqual(expect.arrayContaining(['max-sm:h-dvh', 'max-sm:flex', 'max-sm:flex-col']));
    expect(classesOf(body)).toEqual(expect.arrayContaining(['max-sm:flex-1', 'max-sm:overflow-y-auto', 'max-sm:min-h-0']));
    expect(classesOf(footer)).toContain('shrink-0');
  });
});
