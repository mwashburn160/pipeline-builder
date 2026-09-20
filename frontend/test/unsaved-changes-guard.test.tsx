// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closing a modal mid-edit must not silently discard the work.
 *
 * `Modal` dismisses on Escape, backdrop click and the X; every large editor
 * (plugin edit, pipeline wizard, message composer) passed `onClose` straight
 * through, so one stray click outside destroyed the draft. With `dirty` those
 * paths ask first — while explicit in-form actions (Cancel/Save) still close
 * directly, as they should.
 *
 * These also cover ConfirmDialog, the replacement for `window.confirm`.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from '../src/components/ui/Modal';
import { ConfirmDialog } from '../src/components/ui/ConfirmDialog';

const renderModal = (props: Partial<React.ComponentProps<typeof Modal>> = {}) => {
  const onClose = jest.fn();
  render(
    <Modal title="Edit plugin" onClose={onClose} {...props}>
      <input aria-label="Name" defaultValue="x" />
    </Modal>,
  );
  return { onClose };
};

/** The backdrop is the presentation-role wrapper around the dialog panel. */
const backdrop = () => document.querySelector('.modal-backdrop') as HTMLElement;

describe('Modal — unsaved changes guard', () => {
  it('closes straight away when nothing has been edited', () => {
    const { onClose } = renderModal();
    fireEvent.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding when the form is dirty (backdrop click)', () => {
    const { onClose } = renderModal({ dirty: true });
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard changes?')).toBeInTheDocument();
  });

  it('asks before discarding on Escape', () => {
    const { onClose } = renderModal({ dirty: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard changes?')).toBeInTheDocument();
  });

  it('asks before discarding via the header close button', () => {
    const { onClose } = renderModal({ dirty: true });
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard changes?')).toBeInTheDocument();
  });

  it('"Keep editing" returns to the form with the work intact', () => {
    const { onClose } = renderModal({ dirty: true });
    fireEvent.click(backdrop());
    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard changes?')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('"Discard" closes the modal', () => {
    const { onClose } = renderModal({ dirty: true });
    fireEvent.click(backdrop());
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the caller-supplied wording for the discard prompt', () => {
    renderModal({ dirty: true, discardMessage: "This message hasn't been sent." });
    fireEvent.click(backdrop());
    expect(screen.getByText("This message hasn't been sent.")).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('focuses Cancel, so a stray Enter never confirms', () => {
    render(
      <ConfirmDialog title="Reduce seats?" onConfirm={jest.fn()} onCancel={jest.fn()}>
        <p>body</p>
      </ConfirmDialog>,
    );
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('disables both actions while the confirmed action is in flight', () => {
    render(
      <ConfirmDialog title="Revoke token?" loading onConfirm={jest.fn()} onCancel={jest.fn()}>
        <p>body</p>
      </ConfirmDialog>,
    );
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
  });
});
