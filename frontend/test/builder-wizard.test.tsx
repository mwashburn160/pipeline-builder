// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useBuilderWizard + JsonPreviewPanel: step moves ask the builder first, and
 * the JSON editor applies an edit through the form's own loader.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { renderHook, act, render, screen, fireEvent } from '@testing-library/react';
import { useBuilderWizard } from '@/hooks/useBuilderWizard';
import { JsonPreviewPanel } from '@/components/pipeline/JsonPreviewPanel';
import type { FormBuilderTabRef } from '@/components/pipeline/FormBuilderTab';
import type { BuilderProps } from '@/types';

function fakeForm(over: Partial<FormBuilderTabRef> = {}) {
  return {
    current: {
      canProceed: jest.fn(() => true),
      goToStep: jest.fn(),
      loadFromProps: jest.fn(() => null),
      getPropsPreview: jest.fn(() => ({ project: 'normalized' })),
      ...over,
    } as unknown as FormBuilderTabRef,
  };
}

describe('useBuilderWizard', () => {
  it('moves only when the builder allows it, and keeps the builder in step', () => {
    const form = fakeForm();
    const { result } = renderHook(() => useBuilderWizard(form));
    act(() => result.current.next());
    expect(result.current.currentStep).toBe(1);
    expect(form.current.goToStep).toHaveBeenCalledWith(1);
    act(() => result.current.prev());
    expect(result.current.currentStep).toBe(0);
    act(() => result.current.prev());
    expect(result.current.currentStep).toBe(0);
    (form.current.canProceed as jest.Mock).mockReturnValue(false);
    act(() => result.current.next());
    expect(result.current.currentStep).toBe(0);
  });

  it('applies edited JSON through the loader and re-renders the normalized form', () => {
    const form = fakeForm();
    const { result } = renderHook(() => useBuilderWizard(form));
    act(() => { result.current.preview.show({ project: 'a' } as unknown as BuilderProps); });
    expect(result.current.preview.open).toBe(true);
    act(() => result.current.preview.setJson('{"project":"b"}'));
    act(() => result.current.preview.apply());
    expect(form.current.loadFromProps).toHaveBeenCalledWith({ project: 'b' });
    expect(result.current.preview.applied).toBe(true);
    expect(result.current.preview.json).toContain('normalized');
  });

  it('reports invalid JSON and loader errors, and refuses to open on nothing', () => {
    const form = fakeForm({ loadFromProps: jest.fn(() => 'stages must be an array') as never });
    const { result } = renderHook(() => useBuilderWizard(form));
    let opened = true;
    act(() => { opened = result.current.preview.show(null); });
    expect(opened).toBe(false);
    act(() => result.current.preview.setJson('{nope'));
    act(() => result.current.preview.apply());
    expect(result.current.preview.error).toMatch(/Invalid JSON/);
    act(() => result.current.preview.setJson('{}'));
    act(() => result.current.preview.apply());
    expect(result.current.preview.error).toBe('stages must be an array');
    act(() => result.current.reset());
    expect(result.current.preview.open).toBe(false);
  });
});

describe('JsonPreviewPanel', () => {
  it('renders the editable panel and applies on click', () => {
    const preview = { json: '{}', open: true, error: null, applied: true, show: jest.fn(), close: jest.fn(), setJson: jest.fn(), apply: jest.fn() };
    render(<JsonPreviewPanel preview={preview as never} edit={{ subject: 'pipeline' }} />);
    fireEvent.click(screen.getByText('Apply to form'));
    expect(preview.apply).toHaveBeenCalled();
    expect(screen.getByText(/Applied to the form/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));
    expect(preview.close).toHaveBeenCalled();
  });

  it('renders read-only, and nothing while closed', () => {
    const preview = { json: '{"a":1}', open: true, error: null, applied: false, show: jest.fn(), close: jest.fn(), setJson: jest.fn(), apply: jest.fn() };
    const { rerender } = render(<JsonPreviewPanel preview={preview as never} />);
    expect(screen.getByText('JSON Preview')).toBeInTheDocument();
    rerender(<JsonPreviewPanel preview={{ ...preview, open: false } as never} />);
    expect(screen.queryByText('JSON Preview')).toBeNull();
  });
});
