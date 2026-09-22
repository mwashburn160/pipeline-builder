// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI plugin builder's "similar plugins already exist" hint: the
 * generator returns the closest catalog plugins so the user can reuse
 * one instead of deploying a duplicate.
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { SimilarPluginsNotice } from '../src/components/plugin/AIPluginBuilderTab';

describe('SimilarPluginsNotice', () => {
  it('renders nothing when there are no similar plugins', () => {
    const { container } = render(<SimilarPluginsNotice plugins={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each similar plugin with its category', () => {
    render(<SimilarPluginsNotice plugins={[
      { id: 'a', name: 'eslint', version: '2.0.0', category: 'quality', summary: 'Lints JS', keywords: ['lint'] },
      { id: 'b', name: 'prettier', version: '1.0.0', category: null, summary: null, keywords: [] },
    ]} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Similar plugins already exist: eslint (quality), prettier. Consider reusing');
  });
});
