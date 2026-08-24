// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared dashboard UI primitives introduced by the settings/govern
 * redesign. Each is small and presentational, so we assert only the observable
 * contract: Switch toggles + exposes aria-checked; Callout maps variant → role +
 * tinted classes; SectionCard renders title/actions/footer; SecretReveal shows
 * the value + copies it; DescriptionList renders label/value pairs.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { Switch } from '../src/components/ui/Switch';
import { Callout } from '../src/components/ui/Callout';
import { SectionCard } from '../src/components/ui/SectionCard';
import { SecretReveal } from '../src/components/ui/SecretReveal';
import { DescriptionList } from '../src/components/ui/DescriptionList';
import { ToggleRow } from '../src/components/ui/SettingRow';

function mockClipboard(impl: { writeText: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: impl });
}

describe('Switch', () => {
  it('exposes role=switch with aria-checked reflecting the checked prop', () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} aria-label="Mute" />);
    const sw = screen.getByRole('switch', { name: 'Mute' });
    expect(sw).toHaveAttribute('aria-checked', 'false');

    rerender(<Switch checked onChange={() => {}} aria-label="Mute" />);
    expect(screen.getByRole('switch', { name: 'Mute' })).toHaveAttribute('aria-checked', 'true');
  });

  it('fires onChange with the negated value when clicked', () => {
    const onChange = jest.fn();
    render(<Switch checked={false} onChange={onChange} aria-label="Mute" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not fire onChange when disabled', () => {
    const onChange = jest.fn();
    render(<Switch checked={false} onChange={onChange} disabled aria-label="Mute" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ToggleRow', () => {
  it('renders label + description and toggles the underlying switch', () => {
    const onChange = jest.fn();
    render(<ToggleRow label="Mute quota warnings" description="Pause the toasts" checked={false} onChange={onChange} />);
    expect(screen.getByText('Mute quota warnings')).toBeInTheDocument();
    expect(screen.getByText('Pause the toasts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Callout', () => {
  it('uses role=alert for danger/warning and role=note otherwise', () => {
    const { rerender } = render(<Callout variant="danger">boom</Callout>);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');

    rerender(<Callout variant="info">fyi</Callout>);
    expect(screen.getByRole('note')).toHaveTextContent('fyi');
  });

  it('renders a title and applies the variant tint class', () => {
    const { container } = render(<Callout variant="success" title="Saved">done</Callout>);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    // success maps onto the green palette
    expect(container.querySelector('.bg-green-50')).toBeTruthy();
  });

  it('renders a dismiss button when onDismiss is provided', () => {
    const onDismiss = jest.fn();
    render(<Callout onDismiss={onDismiss}>x</Callout>);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('SectionCard', () => {
  it('renders the title as a heading plus actions and footer', () => {
    render(
      <SectionCard title="Profile" actions={<button>Edit</button>} footer={<button>Save</button>}>
        <p>body</p>
      </SectionCard>,
    );
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('omits the header entirely when no title/description/actions/icon are given', () => {
    render(<SectionCard><p>only body</p></SectionCard>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('only body')).toBeInTheDocument();
  });
});

describe('SecretReveal', () => {
  it('renders the secret value and copies it on click', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    mockClipboard({ writeText });

    render(<SecretReveal value="pat_abc123" label="Token" />);
    expect(screen.getByText('pat_abc123')).toBeInTheDocument();
    expect(screen.getByText('Token created')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });
    expect(writeText).toHaveBeenCalledWith('pat_abc123');
  });
});

describe('DescriptionList', () => {
  it('renders each label/value pair', () => {
    render(<DescriptionList items={[{ label: 'Issuer', value: 'pb' }, { label: 'Subject', value: 'u-1' }]} />);
    expect(screen.getByText('Issuer')).toBeInTheDocument();
    expect(screen.getByText('pb')).toBeInTheDocument();
    expect(screen.getByText('Subject')).toBeInTheDocument();
    expect(screen.getByText('u-1')).toBeInTheDocument();
  });
});
