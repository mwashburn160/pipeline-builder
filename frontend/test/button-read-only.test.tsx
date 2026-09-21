// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '../src/components/ui/Button';
import { READ_ONLY_REASON } from '../src/components/ui/ReadOnlyNotice';

describe('Button readOnly', () => {
  it('disables the button and explains why, replacing its own title', () => {
    const onClick = jest.fn<AnyFn>();
    render(<Button readOnly title="Create a token" onClick={onClick}>Create</Button>);
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', READ_ONLY_REASON);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps its own title and state when not read-only', () => {
    render(<Button title="Create a token" disabled={false}>Create</Button>);
    const btn = screen.getByRole('button', { name: 'Create' });
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute('title', 'Create a token');
  });

  it('still honours disabled alongside readOnly={false}', () => {
    render(<Button readOnly={false} disabled>Create</Button>);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
