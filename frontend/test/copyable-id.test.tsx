// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for CopyableId — the inline ID + tiny copy button used across
 * sysadmin tables. The component is small enough that exhaustive UI
 * snapshots would be overkill; we test the four observable behaviors:
 * value vs display fallback, copy-button click writes to clipboard,
 * idle → copied state transition, and fallback rendering after the
 * Clipboard API rejects.
 */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { CopyableId } from '../src/components/ui/CopyableId';

// Jest's jsdom doesn't ship a navigator.clipboard implementation.
// We swap in a controllable mock per test.
function mockClipboard(impl: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: impl,
  });
}

describe('CopyableId', () => {
  it('renders the value as a code element by default', () => {
    render(<CopyableId value="abc123" />);
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });

  it('renders the optional display string in place of value', () => {
    render(<CopyableId value="abc123longgg" display="abc…" />);
    expect(screen.getByText('abc…')).toBeInTheDocument();
    expect(screen.queryByText('abc123longgg')).not.toBeInTheDocument();
  });

  it('copies the full value (not the display string) on click', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    mockClipboard({ writeText });

    render(<CopyableId value="full-secret-id" display="full…" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
    });

    expect(writeText).toHaveBeenCalledWith('full-secret-id');
  });

  it('shows a "Copied!" tooltip after a successful copy', async () => {
    mockClipboard({ writeText: jest.fn().mockResolvedValue(undefined) });

    render(<CopyableId value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveAttribute('title', 'Copied!');
    });
  });

  it('shows a "Copy failed" tooltip when the Clipboard API rejects', async () => {
    mockClipboard({ writeText: jest.fn().mockRejectedValue(new Error('blocked')) });

    render(<CopyableId value="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveAttribute('title', 'Copy failed');
    });
  });
});
